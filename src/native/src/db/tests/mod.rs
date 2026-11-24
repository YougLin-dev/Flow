//! Inline database tests, moved out of `db.rs`.
//!
//! `db::tests` is a descendant of `db`, so the fixtures and tests keep access
//! to the private workers and builders they exercise. Child modules use
//! `use super::*;` to share the fixtures declared here.
//!
//! A test module whose name matches a production module shadows that binding
//! for every `use super::*;` child. `scene`, `search`, `gc` and `history` are
//! crate-root modules spelled `crate::scene`, `crate::search`, `crate::gc`
//! and `crate::history`; `worker`, `session`, `verify` and `metadata` become
//! `crate::db::...` after the production db split. Never use a bare path.
//! The `nodes`, `edges` and `assets` test modules also shadow the SeaORM
//! entities; `nodes`/`edges` are imported as `node_rows`/`edge_rows`, and the
//! asset entity is imported as `crate::entity::assets` inside the test that
//! uses it.

mod assets;
mod benchmark;
mod edges;
mod gc;
mod history;
mod indexes;
mod inputs;
mod manual;
mod metadata;
mod nodes;
mod previews;
mod reset;
mod runs;
mod scene;
mod search;
mod seed;
mod session;
mod settings;
mod sqlite_vfs;
mod startup;
mod verify;
mod worker;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::clock::now_ms;
use crate::entity::{edges as edge_rows, node_inputs, nodes as node_rows, result_batches};
use crate::history::HistoryOp;
use crate::types::EdgePoint;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, QueryTrait};

fn current_rev(db: &Database) -> i64 {
    db.run(|conn| document::current_rev(conn).map_err(|error| error.to_string()))
        .expect("read the document revision")
}

/// The whole document row, for tests that check metadata beside the revision.
fn current_document(db: &Database) -> crate::entity::document::Model {
    db.run(|conn| document::current(conn).map_err(|error| error.to_string()))
        .expect("read the document row")
}

/// Removes a test path, retrying while the worker still closes its
/// SQLite handles. Windows refuses to unlink a file the worker holds.
fn remove_path_retrying(path: &std::path::Path) {
    for _ in 0..100 {
        if !path.exists() {
            return;
        }
        let result = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        if result.is_ok() && !path.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!path.exists(), "could not remove {}", path.display());
}

fn direct_write(db: &Database, sql: &str) {
    let sql = sql.to_owned();
    db.run(move |conn| {
        conn.execute_unprepared(&sql)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .expect("direct write");
}

fn manual_text_db() -> Database {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "before", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_manual_text(
        "n".to_owned(),
        "after".to_owned(),
        ResultBatchInput {
            id: "batch-manual".to_owned(),
            node_id: "n".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        ResultItemInput {
            id: "item-manual".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "after".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual edit");
    db
}

/// Imports a tiny, deterministic asset under `id`. v1 requires an asset
/// row for every image result item and every local input.
fn test_asset(db: &Database, id: &str) -> String {
    db.import_asset(AssetInput {
        id: id.to_owned(),
        kind: "image".to_owned(),
        name: format!("{id}.png"),
        mime: "image/png".to_owned(),
        bytes: format!("test asset bytes: {id}").into_bytes(),
        meta_json: None,
    })
    .expect("import test asset")
    .id
}

fn node(id: &str, title: &str, body: &str, tags: &[&str], x: f64, y: f64) -> NodeInput {
    NodeInput {
        id: id.to_owned(),
        kind: "text".to_owned(),
        title: title.to_owned(),
        body: body.to_owned(),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        x,
        y,
        width: 200.0,
        height: 84.0,
        z: 0.0,
        data_json: None,
        settings_json: None,
    }
}

fn edge(id: &str, from: &str, to: &str) -> EdgeInput {
    EdgeInput {
        id: id.to_owned(),
        from_id: from.to_owned(),
        to_id: to.to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    }
}

fn result_batch(id: &str, node_id: &str, status: &str) -> ResultBatchInput {
    ResultBatchInput {
        id: id.to_owned(),
        node_id: node_id.to_owned(),
        trigger: "run".to_owned(),
        provider: "mock-text".to_owned(),
        model: "mock-text".to_owned(),
        params_json: "{}".to_owned(),
        status: status.to_owned(),
        error: None,
    }
}

fn result_text_item(id: &str, text: &str) -> ResultItemInput {
    ResultItemInput {
        id: id.to_owned(),
        position: 0.0,
        port_id: "out".to_owned(),
        kind: "text".to_owned(),
        text: text.to_owned(),
        asset_id: None,
        meta_json: None,
    }
}

fn result_image_item(id: &str, asset_id: &str) -> ResultItemInput {
    ResultItemInput {
        id: id.to_owned(),
        position: 0.0,
        port_id: "out".to_owned(),
        kind: "image".to_owned(),
        text: String::new(),
        asset_id: Some(asset_id.to_owned()),
        meta_json: None,
    }
}

fn asset_hash(db: &Database, id: &str) -> String {
    let id = id.to_owned();
    db.run(move |conn| {
        conn.query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "SELECT hash FROM assets WHERE id = ?",
            [id.into()],
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the asset row is missing".to_owned())?
        .try_get_by_index::<String>(0)
        .map_err(|error| error.to_string())
    })
    .expect("read the asset hash")
}

fn batch_exists(db: &Database, id: &str) -> bool {
    let id = id.to_owned();
    db.run(move |conn| {
        conn.query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "SELECT EXISTS (SELECT 1 FROM result_batches WHERE id = ?)",
            [id.into()],
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the existence read returned no row".to_owned())?
        .try_get_by_index::<i64>(0)
        .map(|found| found != 0)
        .map_err(|error| error.to_string())
    })
    .expect("check the batch")
}

fn connect(db: &Database, id: &str, from: &str, to: &str) {
    connect_ports(db, id, from, "out", to, "in", "text");
}

fn connect_ports(
    db: &Database,
    id: &str,
    from: &str,
    from_port: &str,
    to: &str,
    to_port: &str,
    port_kind: &str,
) {
    db.connect_edge(EdgeInput {
        id: id.to_owned(),
        from_id: from.to_owned(),
        to_id: to.to_owned(),
        from_port: from_port.to_owned(),
        to_port: to_port.to_owned(),
        port_kind: port_kind.to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");
}

/// Applies the v1 position uniqueness before the schema swap, so the
/// position writer is tested against the constraint it must satisfy.
fn enforce_unique_input_positions(db: &Database) {
    direct_write(
        db,
        "CREATE UNIQUE INDEX test_node_inputs_position ON node_inputs (node_id, port_id, position)",
    );
}

fn port_inputs<'a>(detail: &'a NodeDetail, port: &str) -> Vec<&'a InputItemSummary> {
    let mut inputs: Vec<&InputItemSummary> = detail
        .inputs
        .iter()
        .filter(|input| input.port_id == port)
        .collect();
    inputs.sort_by_key(|input| input.position as i32);
    inputs
}

fn add_local_input(db: &Database, node_id: &str, id: &str, port: &str, text: &str) {
    let asset = test_asset(db, &format!("asset-{id}"));
    db.add_input(InputItemInput {
        id: id.to_owned(),
        node_id: node_id.to_owned(),
        port_id: port.to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some(asset),
        text: text.to_owned(),
        meta_json: None,
    })
    .expect("add input");
}

fn scene_edge_ids(db: &Database) -> Vec<String> {
    db.scene(
        Viewport {
            x: -1000.0,
            y: -1000.0,
            width: 5000.0,
            height: 5000.0,
        },
        0.0,
        100,
    )
    .expect("scene")
    .edges
    .into_iter()
    .map(|edge| edge.id)
    .collect()
}

/// A text source with one done output, a text target, and an edge that
/// snapshots the source's `text` item into the target's prompt.
fn text_target_with_incoming_edge(db: &Database) {
    db.insert_nodes(vec![
        node("source", "Source", "", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-source".to_owned(),
            node_id: "source".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-source".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "hello".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");
    connect_ports(
        db,
        "edge-target",
        "source",
        "text",
        "target",
        "prompt",
        "text",
    );
}

/// An upload with one image output, a text target, and an edge that
/// snapshots the uploaded item into the target's references.
fn upload_with_edge_to_target(db: &Database) {
    let mut upload = node("source", "Source", "", &[], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":["image"]}"#.to_owned());
    db.insert_nodes(vec![upload, node("target", "Target", "", &[], 400.0, 0.0)])
        .expect("insert");
    test_asset(db, "asset-cat");
    db.set_manual_upload(
        "source".to_owned(),
        r#"{"version":1,"media":["image"]}"#.to_owned(),
        "cat.png".to_owned(),
        ResultBatchInput {
            id: "batch-first".to_owned(),
            node_id: "source".to_owned(),
            trigger: "upload".to_owned(),
            provider: "local".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-first".to_owned(),
            position: 0.0,
            port_id: "image".to_owned(),
            kind: "image".to_owned(),
            text: String::new(),
            asset_id: Some("asset-cat".to_owned()),
            meta_json: None,
        }],
        None,
    )
    .expect("upload");
    connect_ports(
        db,
        "edge-source",
        "source",
        "image",
        "target",
        "references",
        "image",
    );
}

fn scene_between(
    db: &Database,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    max_cards: u64,
) -> SceneSnapshot {
    db.scene(
        Viewport {
            x,
            y,
            width,
            height,
        },
        0.0,
        max_cards,
    )
    .expect("scene")
}

fn temp_database(label: &str) -> (std::path::PathBuf, String) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "flow-{label}-{}-{}-{}.db",
        std::process::id(),
        now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let as_string = path.to_string_lossy().into_owned();
    (path, as_string)
}

fn remove_database_files(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        remove_path_retrying(std::path::Path::new(&format!("{}{suffix}", path.display())));
    }
}

fn write_raw_database(path: &str, sql: &str) {
    let url = sqlite_url(path).expect("raw database URL");
    let conn = sea_orm::Database::connect(url.as_str()).expect("open raw database");
    conn.execute_unprepared(sql).expect("write raw database");
}

fn node_seq(db: &Database, id: &str) -> i64 {
    let id = id.to_owned();
    db.run(move |conn| {
        node_rows::Entity::find()
            .filter(node_rows::Column::Id.eq(id))
            .one(conn)
            .map(|row| row.map(|row| row.seq))
            .map_err(|error| error.to_string())
    })
    .expect("read node")
    .expect("node row")
}

fn edge_seq(db: &Database, id: &str) -> i64 {
    let id = id.to_owned();
    db.run(move |conn| {
        edge_rows::Entity::find()
            .filter(edge_rows::Column::Id.eq(id))
            .one(conn)
            .map(|row| row.map(|row| row.seq))
            .map_err(|error| error.to_string())
    })
    .expect("read edge")
    .expect("edge row")
}

/// One `min_x` cell from an RTree or the `edge_boxes` view.
fn min_x_of(db: &Database, table: &'static str, id: i64) -> f64 {
    db.run(move |conn| {
        let sql = format!("SELECT min_x FROM {table} WHERE id = ?");
        conn.query_one_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            &sql,
            [id.into()],
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the box row is missing".to_owned())?
        .try_get_by_index::<f64>(0)
        .map_err(|error| error.to_string())
    })
    .expect("read the box")
}

fn text_item(id: &str, text: &str) -> ResultItemInput {
    ResultItemInput {
        id: id.to_owned(),
        position: 0.0,
        port_id: "out".to_owned(),
        kind: "text".to_owned(),
        text: text.to_owned(),
        asset_id: None,
        meta_json: None,
    }
}

fn run_batch(id: &str, node_id: &str, status: &str, error: Option<&str>) -> ResultBatchInput {
    ResultBatchInput {
        id: id.to_owned(),
        node_id: node_id.to_owned(),
        trigger: "run".to_owned(),
        provider: "mock-text".to_owned(),
        model: "mock-text".to_owned(),
        params_json: "{}".to_owned(),
        status: status.to_owned(),
        error: error.map(str::to_owned),
    }
}

fn seed_input() -> SeedDocumentInput {
    let mut text = node("seed-text", "Text", "", &["text"], 80.0, 120.0);
    text.settings_json = Some(r#"{"version":1,"prompt":"Describe a lake."}"#.to_owned());
    let mut image = node("seed-image", "Image", "", &["image"], 520.0, 120.0);
    image.kind = "image".to_owned();
    SeedDocumentInput {
        nodes: vec![text, image],
        edges: vec![EdgeInput {
            id: "seed-edge".to_owned(),
            from_id: "seed-text".to_owned(),
            to_id: "seed-image".to_owned(),
            from_port: "text".to_owned(),
            to_port: "prompt".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 110.0,
            to_offset: 110.0,
            kind: "flow".to_owned(),
            data_json: None,
        }],
        batch: Some(ResultBatchInput {
            id: "seed-batch".to_owned(),
            node_id: "seed-text".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        }),
        item: Some(ResultItemInput {
            id: "seed-item".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "A calm lake.".to_owned(),
            asset_id: None,
            meta_json: None,
        }),
    }
}

fn preview_item(id: String, position: i32, asset_id: Option<&str>) -> ResultItemInput {
    let text = id.clone();
    ResultItemInput {
        id,
        position: position as f64,
        port_id: "out".to_owned(),
        // v1 requires an asset for every image item. Assetless preview
        // fixtures model the text result, which needs none.
        kind: if asset_id.is_some() { "image" } else { "text" }.to_owned(),
        text,
        asset_id: asset_id.map(str::to_owned),
        meta_json: None,
    }
}

/// Saves one done image run and returns the output batch the node kept.
fn preview_run(
    db: &Database,
    node_id: &str,
    batch_id: &str,
    items: Vec<ResultItemInput>,
) -> String {
    db.save_run(
        ResultBatchInput {
            id: batch_id.to_owned(),
            node_id: node_id.to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-image".to_owned(),
            model: "mock-image".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        items,
    )
    .expect("save preview run");
    let actual = db
        .get_node(node_id.to_owned())
        .expect("read preview node")
        .expect("the preview node exists")
        .output_batch_id
        .expect("a done run stores its output batch");
    assert_eq!(actual, batch_id, "save_run output batch");
    actual
}

// The deterministic PNG is a fixture, not benchmark-only: the asset tests
// use it to persist an image without a committed binary.

/// A deterministic 2x2 RGBA PNG whose first two pixel bytes identify the
/// image index. It is built with a stored deflate block, so the fixture
/// needs no image crate or committed binary.
fn benchmark_png(seed: u32) -> Vec<u8> {
    let mut raw = Vec::with_capacity(2 * (1 + 2 * 4));
    for row in 0..2u8 {
        raw.push(0); // no filter
        for column in 0..2u8 {
            raw.extend_from_slice(&[
                (seed >> 8) as u8,
                seed as u8,
                column.wrapping_mul(67).wrapping_add(row.wrapping_mul(29)),
                255,
            ]);
        }
    }

    let mut zlib = Vec::with_capacity(7 + raw.len() + 4);
    zlib.extend_from_slice(&[0x78, 0x01, 0x01]); // zlib header, final stored block
    zlib.extend_from_slice(&(raw.len() as u16).to_le_bytes());
    zlib.extend_from_slice(&(!(raw.len() as u16)).to_le_bytes());
    zlib.extend_from_slice(&raw);
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&2u32.to_be_bytes());
    ihdr.extend_from_slice(&2u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace

    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    png.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
    png.extend_from_slice(&png_chunk(b"IDAT", &zlib));
    png.extend_from_slice(&png_chunk(b"IEND", &[]));
    png
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(12 + data.len());
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    chunk.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    chunk
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}
