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
//! The `nodes` and `edges` test modules also shadow the SeaORM entities,
//! imported as `node_rows` and `edge_rows`; `assets` is the next entity
//! collision (spell it `crate::entity::assets`).

mod benchmark;
mod edges;
mod history;
mod indexes;
mod inputs;
mod manual;
mod nodes;
mod previews;
mod scene;
mod search;
mod settings;
mod worker;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::clock::now_ms;
use crate::entity::{edges as edge_rows, node_inputs, nodes as node_rows, result_batches};
use crate::types::EdgePoint;
use sea_orm::{ColumnTrait, QueryFilter, QueryTrait};

fn current_rev(db: &Database) -> i64 {
    db.run(|conn| document::current_rev(conn).map_err(|error| error.to_string()))
        .expect("read the document revision")
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

#[test]
fn sqlite_url_makes_a_relative_path_absolute() {
    let url = sqlite_url("my data/notes:2024.db").expect("url");
    assert!(url.starts_with("sqlite:file:"));
    assert!(url.contains("my%20data/notes:2024.db"));
    assert!(!url.contains("sqlite://my"));
}

#[cfg(windows)]
#[test]
fn sqlite_url_strips_a_verbatim_prefix() {
    let url = sqlite_url("\\\\?\\C:\\Flow Data\\flow.db").expect("url");
    assert!(!url.contains("%3F"), "{url}");
    assert!(url.contains("C:/Flow%20Data/flow.db"), "{url}");
}

#[cfg(windows)]
#[test]
fn sqlite_url_keeps_a_verbatim_unc_share() {
    let url = sqlite_url("\\\\?\\UNC\\nas\\backups\\flow.db").expect("url");
    assert!(!url.contains("%3F"), "{url}");
    // The authority-less `file://server` form is rejected by the bundled
    // SQLite; the ignored `localhost` authority keeps the UNC path.
    assert!(
        url.starts_with("sqlite:file://localhost//nas/backups/flow.db"),
        "{url}"
    );
    assert!(!url.contains("file://nas"), "{url}");
}

#[cfg(windows)]
#[test]
fn sqlite_url_opens_a_canonicalized_package() {
    let (path, database) = temp_database("verbatim-open");
    {
        let db = Database::open(&database).expect("create");
        db.close().expect("close");
    }
    let canonical = std::fs::canonicalize(&path).expect("canonicalize");
    let url = sqlite_url_ro(&canonical.to_string_lossy()).expect("url");
    let conn = sea_orm::Database::connect(url).expect("open canonicalized url");
    let state = schema::v1::inspect(&conn).expect("inspect the opened package");
    assert!(matches!(state, schema::v1::FileState::Current(_)));
    drop(conn);
    remove_database_files(&path);
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

#[test]
fn persists_across_reopen() {
    let path = std::env::temp_dir().join(format!(
        "flow-native-{}-{}.db",
        std::process::id(),
        now_ms()
    ));
    let path = path.to_string_lossy().into_owned();

    {
        let db = Database::open(&path).expect("open");
        db.insert_nodes(vec![node(
            "persisted",
            "Persistent panel",
            "Survives a reopen",
            &["disk"],
            10.0,
            20.0,
        )])
        .expect("insert");
    }

    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(db.count().expect("count"), 1);
        let hits = db
            .search("Persistent".to_owned(), SearchFilters::default(), 20)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "persisted");
    }

    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

#[test]
fn opens_a_database_in_a_directory_with_spaces() {
    let dir = std::env::temp_dir().join(format!("flow native {} {}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).expect("create directory");
    let path = dir.join("flow.db");
    let path = path.to_string_lossy().into_owned();

    {
        let db = Database::open(&path).expect("open");
        db.insert_nodes(vec![node("spaced", "With spaces", "", &[], 0.0, 0.0)])
            .expect("insert");
    }
    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(db.count().expect("count"), 1);
    }

    for suffix in ["", "-wal", "-shm"] {
        remove_path_retrying(std::path::Path::new(&format!("{path}{suffix}")));
    }
    remove_path_retrying(&dir);
}

#[test]
fn a_referenced_asset_cannot_be_deleted() {
    use crate::entity::assets;
    use sea_orm::ActiveValue::Set;

    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let asset = test_asset(&db, "asset-keep");
    let input_asset = asset.clone();
    db.run(move |conn| {
        node_inputs::Entity::insert(node_inputs::ActiveModel {
            id: Set("local-input".to_owned()),
            node_id: Set("a".to_owned()),
            position: Set(0),
            port_id: Set("references".to_owned()),
            kind: Set("image".to_owned()),
            origin: Set("local".to_owned()),
            edge_id: Set(None),
            item_id: Set(None),
            asset_id: Set(Some(input_asset)),
            text: Set(String::new()),
            meta_json: Set("{}".to_owned()),
            created_at: Set(0),
        })
        .exec(conn)
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("attach the asset to an input");

    let deleted = db.run(move |conn| {
        assets::Entity::delete_by_id(asset)
            .exec(conn)
            .map(|_| ())
            .map_err(|error| error.to_string())
    });
    assert!(
        deleted.is_err(),
        "an asset an input still uses must not be deleted"
    );
}

#[test]
fn a_later_run_invalidates_a_settings_edit_and_keeps_the_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "Original", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_settings(
        "a".to_owned(),
        "{\"prompt\":\"one\"}".to_owned(),
        Some(vec![
            "prompt".to_owned(),
            "references".to_owned(),
            "text".to_owned(),
        ]),
    )
    .expect("settings");

    // Runs are not history: the undo below must not resurrect the body,
    // output or status this run wrote.
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "Run output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");

    // The run made the pending settings entry stale: undo must not restore
    // the old settings over the output the run wrote.
    let undone = db.undo().expect("undo after a run");
    assert!(
        undone.changed.is_empty(),
        "a non-history run invalidates the settings entry"
    );
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.settings_json, "{\"prompt\":\"one\"}");
    assert_eq!(detail.node.body, "Run output");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch"));
    assert_eq!(detail.node.status, "done");

    // Redo was cleared by the run as well.
    let redone = db.redo().expect("redo after invalidation");
    assert!(redone.changed.is_empty());
    let redone = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(redone.node.settings_json, "{\"prompt\":\"one\"}");
    assert_eq!(redone.node.body, "Run output");
    assert_eq!(redone.node.output_batch_id.as_deref(), Some("batch"));
}

#[test]
fn an_asset_import_invalidates_history_that_references_the_asset() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.import_asset(AssetInput {
        id: "asset-1".to_owned(),
        kind: "image".to_owned(),
        name: "one.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("import asset");
    db.clear_history().expect("clear setup history");
    db.add_input(InputItemInput {
        id: "input-1".to_owned(),
        node_id: "n".to_owned(),
        port_id: "in".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some("asset-1".to_owned()),
        text: String::new(),
        meta_json: None,
    })
    .expect("add asset input");

    // The same bytes under a new requested id resolve to the first row
    // and invalidate the entry that references it.
    db.import_asset(AssetInput {
        id: "asset-2".to_owned(),
        kind: "image".to_owned(),
        name: "one-copy.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("re-import the same bytes");

    let undone = db.undo().expect("undo after the asset import");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail")
            .inputs
            .len(),
        1,
        "the import invalidated the input entry"
    );
}

#[test]
fn reimporting_an_asset_restores_missing_bytes() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");

    std::fs::remove_file(db.assets_dir.join(&first.hash)).expect("remove the stored bytes");
    assert!(db.asset_bytes(first.id.clone()).is_err());

    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("reimport");
    assert_eq!(second.id, first.id);
    assert_eq!(db.asset_bytes(first.id).expect("read back"), bytes);
}

#[test]
fn a_stored_size_mismatch_rejects_the_import_and_does_not_write() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    std::fs::remove_file(db.assets_dir.join(&first.hash)).expect("remove the stored bytes");
    direct_write(&db, "UPDATE assets SET size = 99 WHERE id = 'asset-1'");

    let error = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes,
            meta_json: None,
        })
        .expect_err("a size mismatch must be rejected");
    assert!(error.contains("imported bytes are 6"), "{error}");
    assert!(
        !db.assets_dir.join(&first.hash).exists(),
        "mismatched bytes must not be written"
    );
}

#[test]
fn a_reimport_repairs_a_corrupt_file_and_keeps_the_first_metadata() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    let path = db.assets_dir.join(&first.hash);

    // A same-length corruption is caught by the content hash.
    std::fs::write(&path, b"XXXXXX").expect("tamper the stored bytes");
    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/png".to_owned(),
            bytes: bytes.clone(),
            meta_json: Some("{\"changed\":true}".to_owned()),
        })
        .expect("reimport over same-length corruption");
    assert_eq!(second.id, "asset-1");
    assert_eq!(second.kind, "image");
    assert_eq!(second.name, "one.svg");
    assert_eq!(second.mime, "image/svg+xml");
    assert_eq!(second.meta_json, "{}");
    assert_eq!(second.hash, first.hash);
    assert_eq!(std::fs::read(&path).expect("read the file"), bytes);

    // A truncated file is caught by its size and repaired the same way.
    std::fs::write(&path, b"<sv").expect("truncate the stored bytes");
    db.import_asset(AssetInput {
        id: "asset-3".to_owned(),
        kind: "image".to_owned(),
        name: "three.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: bytes.clone(),
        meta_json: None,
    })
    .expect("reimport over truncation");
    assert_eq!(std::fs::read(&path).expect("read the file"), bytes);
}

#[test]
fn an_in_memory_database_removes_its_temporary_assets_on_drop() {
    let bytes = b"<svg/>".to_vec();
    let dir = {
        let db = Database::open(":memory:").expect("open");
        let asset = db
            .import_asset(AssetInput {
                id: "asset-1".to_owned(),
                kind: "image".to_owned(),
                name: "one.svg".to_owned(),
                mime: "image/svg+xml".to_owned(),
                bytes: bytes.clone(),
                meta_json: None,
            })
            .expect("import");
        let dir = db.assets_dir.to_path_buf();
        let clone = db.clone();
        drop(db);
        assert!(dir.exists(), "a live clone keeps the directory");
        assert_eq!(
            clone.asset_bytes(asset.id).expect("read through the clone"),
            bytes
        );
        drop(clone);
        dir
    };
    assert!(!dir.exists(), "the temporary directory is removed on drop");
}

#[test]
fn a_file_database_keeps_its_assets_after_drop_and_reopen() {
    let dir = std::env::temp_dir().join(format!("flow assets {} {}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).expect("create directory");
    let path = dir.join("flow.db");
    let path = path.to_string_lossy().into_owned();
    let bytes = b"<svg/>".to_vec();

    let (id, hash) = {
        let db = Database::open(&path).expect("open");
        let asset = db
            .import_asset(AssetInput {
                id: "asset-1".to_owned(),
                kind: "image".to_owned(),
                name: "one.svg".to_owned(),
                mime: "image/svg+xml".to_owned(),
                bytes: bytes.clone(),
                meta_json: None,
            })
            .expect("import");
        assert!(db.assets_dir.join(&asset.hash).exists());
        (asset.id, asset.hash)
    };
    let stored = dir.join("assets").join(&hash);
    assert!(
        stored.exists(),
        "a file database must keep its assets directory"
    );
    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(
            db.asset_bytes(id).expect("read after reopen"),
            bytes,
            "the stored bytes survive the close"
        );
    }
    assert!(stored.exists());

    for suffix in ["", "-wal", "-shm"] {
        remove_path_retrying(std::path::Path::new(&format!("{path}{suffix}")));
    }
    remove_path_retrying(&dir);
}

#[test]
fn asset_bytes_rejects_a_malformed_stored_hash() {
    let db = Database::open(":memory:").expect("open");
    db.import_asset(AssetInput {
        id: "asset-1".to_owned(),
        kind: "image".to_owned(),
        name: "one.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("import");
    // The v1 CHECK refuses a malformed hash on an ordinary write; bypass
    // it to exercise the read path's own guard.
    direct_write(&db, "PRAGMA ignore_check_constraints = ON");
    direct_write(
        &db,
        "UPDATE assets SET hash = '../escape' WHERE id = 'asset-1'",
    );
    direct_write(&db, "PRAGMA ignore_check_constraints = OFF");

    let error = db
        .asset_bytes("asset-1".to_owned())
        .expect_err("a malformed hash must not be read");
    assert!(error.contains("malformed hash"), "{error}");
}

#[test]
fn asset_bytes_rejects_bytes_that_do_not_match_the_row_size() {
    let db = Database::open(":memory:").expect("open");
    let asset = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: b"<svg/>".to_vec(),
            meta_json: None,
        })
        .expect("import");
    std::fs::write(db.assets_dir.join(&asset.hash), b"a longer file")
        .expect("tamper the stored bytes");

    let error = db
        .asset_bytes(asset.id)
        .expect_err("a file whose size disagrees with its row must be rejected");
    assert!(error.contains("its row says 6"), "{error}");
}

#[test]
fn asset_bytes_rejects_a_same_length_corrupt_file() {
    let db = Database::open(":memory:").expect("open");
    let asset = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: b"<svg/>".to_vec(),
            meta_json: None,
        })
        .expect("import");
    std::fs::write(db.assets_dir.join(&asset.hash), b"broken").expect("tamper the stored bytes");

    let error = db
        .asset_bytes(asset.id)
        .expect_err("a file whose content hash disagrees with its row must be rejected");
    assert!(error.contains("stored hash"), "{error}");
}

#[test]
fn a_failed_insert_returns_and_validates_the_winning_asset() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");

    let assets_dir = Arc::clone(&db.assets_dir);
    let hash = first.hash.clone();
    let import_bytes = bytes.clone();
    let winner = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &hash,
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect("the conflict winner");
    assert_eq!(winner.id, first.id);

    direct_write(&db, "UPDATE assets SET size = 99 WHERE id = 'asset-1'");
    let assets_dir = Arc::clone(&db.assets_dir);
    let hash = first.hash.clone();
    let import_bytes = bytes.clone();
    let error = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &hash,
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect_err("a corrupt winner must be rejected");
    assert!(error.contains("imported bytes are 6"), "{error}");

    let assets_dir = Arc::clone(&db.assets_dir);
    let import_bytes = bytes.clone();
    let error = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &"f".repeat(64),
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect_err("without a winner the insert error is returned");
    assert!(error.contains("the insert failed"), "{error}");
}

#[test]
fn a_successful_run_marks_its_targets_stale_and_keeps_the_last_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.connect_edge(EdgeInput {
        id: "a-b".to_owned(),
        from_id: "a".to_owned(),
        to_id: "b".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    let first = db
        .save_run(
            ResultBatchInput {
                id: "batch-b".to_owned(),
                node_id: "b".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-b".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "B output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save run");
    assert_eq!(first.changed[0].status, "done");
    assert_eq!(first.changed[0].output_batch_id.as_deref(), Some("batch-b"));

    let second = db
        .save_run(
            ResultBatchInput {
                id: "batch-a".to_owned(),
                node_id: "a".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-a".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "A output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save source run");
    assert!(
        second
            .changed
            .iter()
            .any(|node| { node.id == "b" && node.status == "stale" })
    );

    let failed = db
        .save_run(
            ResultBatchInput {
                id: "batch-failed".to_owned(),
                node_id: "b".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "failed".to_owned(),
                error: Some("prompt is empty".to_owned()),
            },
            Vec::new(),
        )
        .expect("save failure");
    assert_eq!(failed.changed[0].status, "failed");
    assert_eq!(
        failed.changed[0].output_batch_id.as_deref(),
        Some("batch-b")
    );
}

#[test]
fn assets_are_content_addressed_and_read_back() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import duplicate");
    assert_eq!(first.id, second.id);
    assert_eq!(first.size, bytes.len() as f64);
    assert_eq!(db.asset_bytes(first.id).expect("read bytes"), bytes);
}

#[test]
fn a_later_run_invalidates_a_manual_text_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "before", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_manual_text(
        "n".to_owned(),
        "manual".to_owned(),
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
            text: "manual".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual edit");
    db.save_run(
        ResultBatchInput {
            id: "batch-run".to_owned(),
            node_id: "n".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-run".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "run output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");
    let before = current_rev(&db);

    let undone = db.undo().expect("undo after a run");
    assert!(undone.changed.is_empty());
    assert_eq!(undone.rev, before as f64);
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "run output");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-run"));
    assert_eq!(detail.node.status, "done");
}

#[test]
fn a_run_on_the_source_invalidates_a_removed_edge_input() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-one".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-one".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "A lake".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("source batch");
    connect(&db, "source-target", "source", "target");
    let input_id = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs[0]
        .id
        .clone();
    db.remove_input(input_id).expect("remove snapshot");

    // A run on the source makes the removed snapshot stale; the entry
    // records the source node from its edge.
    db.save_run(
        ResultBatchInput {
            id: "batch-two".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-two".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "A dawn".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("source rerun");

    let undone = db.undo().expect("undo after the source run");
    assert!(undone.changed.is_empty());
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty(),
        "the run on the source invalidated the removed snapshot"
    );
}

#[test]
fn a_source_run_invalidates_an_output_entry_on_a_stale_target() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    let run = |db: &Database, batch: &str, node: &str, item: &str, text: &str| {
        db.save_run(
            ResultBatchInput {
                id: batch.to_owned(),
                node_id: node.to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: item.to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: text.to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run");
    };
    run(&db, "batch-source-one", "source", "item-source-one", "one");
    run(
        &db,
        "batch-target",
        "target",
        "item-target",
        "target output",
    );
    db.set_manual_text(
        "target".to_owned(),
        "manual target".to_owned(),
        ResultBatchInput {
            id: "batch-target-manual".to_owned(),
            node_id: "target".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        ResultItemInput {
            id: "item-target-manual".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "manual target".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual target");
    // The connect marks the target stale while the manual entry is still
    // pending; the next source run must still invalidate that entry.
    connect(&db, "source-target", "source", "target");
    run(&db, "batch-source-two", "source", "item-source-two", "two");

    let undone = db.undo().expect("undo after the source run");
    assert!(undone.changed.is_empty());
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(target.node.status, "stale");
    assert_eq!(target.node.body, "manual target");
    assert_eq!(
        target.node.output_batch_id.as_deref(),
        Some("batch-target-manual")
    );
}

#[test]
fn a_status_write_invalidates_pending_history() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.move_nodes(vec!["n".to_owned()], 10.0, 0.0)
        .expect("move");
    db.set_node_status("n".to_owned(), "running".to_owned())
        .expect("status");

    let undone = db.undo().expect("undo after the status write");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.get_node("n".to_owned()).expect("get").expect("n").x,
        10.0
    );
}

#[test]
fn recovering_runs_invalidates_pending_history() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("n".to_owned(), "running".to_owned())
        .expect("status");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "n".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");
    db.move_nodes(vec!["n".to_owned()], 10.0, 0.0)
        .expect("move");
    assert_eq!(db.recover_runs().expect("recover"), 1);

    let undone = db.undo().expect("undo after recovery");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.get_node("n".to_owned()).expect("get").expect("n").x,
        10.0
    );
}

#[test]
fn a_run_invalidates_a_settings_entry_that_removed_an_edge() {
    let db = Database::open(":memory:").expect("open");
    text_target_with_incoming_edge(&db);
    db.clear_history().expect("clear setup history");
    let settings = db
        .set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec!["references".to_owned(), "text".to_owned()]),
        )
        .expect("remove the input port");
    assert!(settings.forward.iter().any(|op| matches!(
        op,
        HistoryOp::DeleteEdge { id } if id == "edge-target"
    )));
    assert!(scene_edge_ids(&db).is_empty());

    // A run is not history: it invalidates the pending settings entry,
    // which references the source through its restored edge.
    db.save_run(
        ResultBatchInput {
            id: "batch-later".to_owned(),
            node_id: "source".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-later".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "later".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");

    let undone = db.undo().expect("undo after a run");
    assert!(undone.changed.is_empty());
    assert!(scene_edge_ids(&db).is_empty());
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(
        target.node.settings_json,
        r#"{"version":1,"prompt":"changed"}"#
    );
    assert!(target.inputs.is_empty());
}

#[test]
fn a_later_run_invalidates_a_reconnect_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("first", "First", "A lake", &[], 0.0, 0.0),
        node("second", "Second", "A dawn", &[], 400.0, 0.0),
        node("target", "Target", "", &[], 800.0, 0.0),
    ])
    .expect("insert nodes");
    let batch = |id: &str, node_id: &str| ResultBatchInput {
        id: id.to_owned(),
        node_id: node_id.to_owned(),
        trigger: "manual".to_owned(),
        provider: "manual".to_owned(),
        model: String::new(),
        params_json: "{}".to_owned(),
        status: "done".to_owned(),
        error: None,
    };
    let item = |id: &str, text: &str| ResultItemInput {
        id: id.to_owned(),
        position: 0.0,
        port_id: "out".to_owned(),
        kind: "text".to_owned(),
        text: text.to_owned(),
        asset_id: None,
        meta_json: None,
    };
    db.save_run(
        batch("batch-first", "first"),
        vec![item("i1", "first item")],
    )
    .expect("first batch");
    db.save_run(
        batch("batch-second", "second"),
        vec![item("j1", "second item")],
    )
    .expect("second batch");
    db.connect_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "first".to_owned(),
        to_id: "target".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    // Move the source end, then run the new source again and sync the
    // target: the snapshot rows are rebuilt under new item ids, so the
    // ids the reconnect captured are gone.
    db.update_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "second".to_owned(),
        to_id: "target".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("reconnect");
    db.save_run(
        batch("batch-second-2", "second"),
        vec![item("j2", "second again")],
    )
    .expect("second rerun");
    db.sync_inputs("target".to_owned()).expect("sync");

    // The rerun and the input sync made the reconnect entry stale; undo
    // must not resurrect either the old or the replaced snapshot.
    let undone = db.undo().expect("undo after a run and sync");
    assert!(
        undone.changed.is_empty(),
        "the non-history writes invalidate the reconnect entry"
    );
    let inputs = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs;
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].item_id.as_deref(), Some("j2"));
    assert_eq!(inputs[0].text, "second again");

    let redone = db.redo().expect("redo after invalidation");
    assert!(redone.changed.is_empty());
    let inputs = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs;
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].item_id.as_deref(), Some("j2"));
}

#[test]
fn recovering_runs_marks_running_nodes_interrupted() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("a".to_owned(), "running".to_owned())
        .expect("running");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");

    assert_eq!(db.recover_runs().expect("recover"), 1);
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("detail");
    assert_eq!(detail.node.status, "interrupted");
    assert_eq!(detail.batch, None);
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

#[test]
fn opening_an_empty_file_creates_a_v1_package() {
    let db = Database::open(":memory:").expect("open");
    let info = db.project_info().expect("project info");
    assert_eq!(info.title, "Flow");
    assert_eq!(info.project_id.len(), 32);
    assert!(
        info.project_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "a project id is 32 lowercase hex characters"
    );
    assert!(!info.demo_seeded);
    assert_eq!((info.node_count, info.edge_count), (0.0, 0.0));
    assert_eq!(
        (info.camera_x, info.camera_y, info.camera_zoom),
        (0.0, 0.0, 1.0)
    );

    let pragmas = db
        .run(|conn| {
            let read = |name: &str| {
                conn.query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    format!("PRAGMA {name}"),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("PRAGMA {name} returned no row"))?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())
            };
            let clean = conn
                .query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "missing document row".to_owned())?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())?;
            Ok((
                read("application_id")?,
                read("user_version")?,
                read("foreign_keys")?,
                read("recursive_triggers")?,
                clean,
            ))
        })
        .expect("read pragmas");
    assert_eq!(pragmas.0, schema::v1::APPLICATION_ID);
    assert_eq!(pragmas.1, schema::v1::USER_VERSION);
    assert_eq!(pragmas.2, 1, "foreign keys are on");
    assert_eq!(pragmas.3, 0, "recursive triggers stay off");
    assert_eq!(pragmas.4, 0, "an open package is dirty");
}

#[test]
fn open_package_refuses_missing_files_without_creating_them() {
    let (path, _) = temp_database("package-missing");
    let missing = path.with_file_name(format!(
        "flow-missing-package-{}-{}.db",
        std::process::id(),
        now_ms()
    ));
    let text = missing.to_string_lossy().into_owned();
    let error = match Database::open_package(&text, "a".repeat(32)) {
        Ok(_) => panic!("a missing package must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("has no Flow database"), "{error}");
    assert!(!missing.exists(), "the open must not create the file");
    remove_database_files(&path);

    let (empty_path, empty) = temp_database("package-empty");
    std::fs::write(&empty_path, b"").expect("empty package file");
    let error = match Database::open_package(&empty, "a".repeat(32)) {
        Ok(_) => panic!("an empty package must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("has no Flow database"), "{error}");
    assert_eq!(
        std::fs::metadata(&empty_path).expect("empty file").len(),
        0,
        "an empty file must not receive a schema"
    );
    remove_database_files(&empty_path);
}

#[test]
fn open_package_requires_the_matching_identity_without_marking_it_dirty() {
    let (path, database) = temp_database("package-identity");
    let project_id;
    {
        let db = Database::open(&database).expect("create");
        project_id = db.project_info().expect("info").project_id;
        db.close().expect("clean close");
    }
    {
        let db = Database::open_package(&database, project_id.clone()).expect("open package");
        let info = db.project_info().expect("info");
        assert!(info.opened_clean);
        assert_eq!(info.project_id, project_id);
        db.close().expect("close");
    }
    let error = match Database::open_package(&database, "b".repeat(32)) {
        Ok(_) => panic!("a mismatched identity must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("belongs to a different project"), "{error}");
    {
        let db = Database::open_package(&database, project_id).expect("reopen");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a refused identity must not mark the package dirty"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn opening_refuses_foreign_and_legacy_files_without_dropping_them() {
    let (foreign_path, foreign) = temp_database("foreign");
    write_raw_database(
        &foreign,
        "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep');",
    );
    let error = match Database::open(&foreign) {
        Ok(_) => panic!("a foreign database must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("not a Flow database"), "{error}");
    assert!(error.contains(&foreign), "the error names the package path");
    let kept = {
        let url = sqlite_url(&foreign).expect("raw URL");
        let conn = sea_orm::Database::connect(url.as_str()).expect("reopen raw database");
        let row = conn
            .query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT body FROM notes".to_owned(),
            ))
            .expect("read foreign row")
            .expect("foreign row survives");
        row.try_get_by_index::<String>(0).expect("foreign body")
    };
    assert_eq!(kept, "keep");
    remove_database_files(&foreign_path);

    let (legacy_path, legacy) = temp_database("legacy");
    write_raw_database(
        &legacy,
        "CREATE TABLE documents (id TEXT PRIMARY KEY); \
             CREATE TABLE nodes (id TEXT PRIMARY KEY); \
             INSERT INTO documents VALUES ('default');",
    );
    let error = match Database::open(&legacy) {
        Ok(_) => panic!("a v5 development file must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("not a Flow database"), "{error}");
    remove_database_files(&legacy_path);
}

#[test]
fn close_marks_the_package_clean_and_stops_the_worker() {
    let (path, database) = temp_database("close");
    {
        let db = Database::open(&database).expect("open");
        db.close().expect("close");
        assert!(
            db.count().is_err(),
            "a job after close must not reach SQLite"
        );
        db.close().expect("a second close is a no-op");
    }

    // close() acknowledges only after the worker released the file, so a
    // rename (or delete/backup) can follow immediately.
    let renamed = format!("{database}.closed");
    std::fs::rename(&database, &renamed).expect("close releases the package file");
    std::fs::rename(&renamed, &database).expect("restore the package file");

    let url = sqlite_url(&database).expect("raw URL");
    let conn = sea_orm::Database::connect(url.as_str()).expect("reopen raw database");
    let clean = conn
        .query_one_raw(sea_orm::Statement::from_string(
            conn.get_database_backend(),
            "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
        ))
        .expect("read clean flag")
        .expect("document row")
        .try_get_by_index::<i64>(0)
        .expect("clean flag");
    assert_eq!(clean, 1, "close records a clean shutdown");
    drop(conn);

    // Reopening marks the package dirty again until the next close.
    {
        let db = Database::open(&database).expect("reopen");
        let dirty = db
            .run(|conn| {
                conn.query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "missing document row".to_owned())?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())
            })
            .expect("read clean flag");
        assert_eq!(dirty, 0);
    }
    remove_database_files(&path);
}

#[test]
fn close_refuses_a_blocked_checkpoint() {
    use sea_orm::TransactionTrait;

    let (path, database) = temp_database("close-busy");
    let db = Database::open(&database).expect("open");

    // A reader whose snapshot predates the next commit keeps that frame
    // out of the main file, so TRUNCATE reports busy with
    // checkpointed < log.
    let url = sqlite_url(&database).expect("raw URL");
    let reader = sea_orm::Database::connect(url.as_str()).expect("open reader");
    let snapshot = reader.begin().expect("begin read transaction");
    snapshot
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Sqlite,
            "SELECT count(*) FROM document".to_owned(),
        ))
        .expect("pin the snapshot");

    db.insert_nodes(vec![node("late", "Late", "", &[], 0.0, 0.0)])
        .expect("commit after the snapshot");
    assert_eq!(
        CLOSE_FAILED_AFTER_STOP,
        "the document closed with a recovery warning: "
    );
    let error = db
        .close()
        .expect_err("a blocked checkpoint is not a clean close");
    assert!(error.contains("write-ahead log"), "{error}");
    assert!(
        error.starts_with(CLOSE_FAILED_AFTER_STOP),
        "the worker stopped, so the close must say so: {error}"
    );

    // The failed close leaves the package marked dirty, so the next open
    // schedules verification instead of skipping it.
    drop(snapshot);
    let clean = reader
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Sqlite,
            "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
        ))
        .expect("read clean flag")
        .expect("document row")
        .try_get_by_index::<i64>(0)
        .expect("clean flag");
    assert_eq!(clean, 0, "a refused checkpoint stays dirty");
    drop(reader);
    remove_database_files(&path);
}

#[test]
fn close_with_view_saves_the_camera_and_a_clean_state() {
    let (path, database) = temp_database("close-view");
    {
        let db = Database::open(&database).expect("open");
        let error = db
            .close_with_view(f64::NAN, 0.0, 1.0)
            .expect_err("an invalid camera must not close the package");
        assert!(error.contains("camera"), "{error}");
        assert!(
            !error.starts_with(CLOSE_FAILED_AFTER_STOP),
            "no close job ran, so the worker may still hold the package"
        );
        db.close_with_view(120.0, -40.0, 2.5)
            .expect("close with the view");
    }
    {
        let db = Database::open(&database).expect("reopen");
        let info = db.project_info().expect("info");
        assert!(info.opened_clean, "the combined close is clean");
        assert_eq!(
            (info.camera_x, info.camera_y, info.camera_zoom),
            (120.0, -40.0, 2.5),
            "the camera was saved before the checkpoint"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn a_failed_verify_keeps_the_package_due_for_recovery() {
    let dir = std::env::temp_dir().join(format!(
        "flow-verify-dirty-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).expect("create package directory");
    let path = dir.join("flow.db");
    let database = path.to_string_lossy().into_owned();
    {
        let db = Database::open(&database).expect("open");
        test_asset(&db, "asset-orphan");
        db.run(|conn| {
            conn.execute_unprepared("PRAGMA foreign_keys = OFF")
                .map_err(|error| error.to_string())?;
            let inserted = conn.execute_unprepared(
                "INSERT INTO node_inputs \
                     (id, node_id, position, port_id, kind, origin, asset_id, \
                      text, meta_json, created_at) \
                     VALUES ('orphan', 'missing', 0, 'references', 'image', 'local', \
                             'asset-orphan', '', '{}', 0)",
            );
            conn.execute_unprepared("PRAGMA foreign_keys = ON")
                .map_err(|error| error.to_string())?;
            inserted.map(|_| ()).map_err(|error| error.to_string())
        })
        .expect("insert an orphan input");
        db.verify().expect_err("verify reports the orphan");
        db.close().expect("close after a failed verify");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "a failed verify leaves the package due for recovery"
        );
        db.close().expect("close");
    }
    remove_path_retrying(&dir);
}

#[test]
fn a_close_request_skips_a_queued_read_but_runs_a_queued_command() {
    let db = Database::open(":memory:").expect("open");
    db.closing.store(true, Ordering::SeqCst);
    let skipped = db
        .run_read(|_| -> Result<(), String> {
            panic!("a read after the close request must not touch SQLite")
        })
        .expect_err("the queued read answers closed");
    assert!(skipped.contains("closed"), "{skipped}");

    // A command the UI already issued must still reach the checkpoint.
    db.insert_nodes(vec![node("queued", "Queued", "", &[], 0.0, 0.0)])
        .expect("a queued command still runs");
    let count = db
        .run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the count");
    assert_eq!(count, 1);
}

#[test]
fn closing_before_verify_keeps_a_crashed_package_dirty() {
    let (path, database) = temp_database("close-pending");
    {
        let db = Database::open(&database).expect("open");
        db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .expect("insert");
        // Drop without close: the package stays dirty.
    }
    {
        let db = Database::open(&database).expect("reopen after a crash");
        assert!(!db.project_info().expect("info").opened_clean);
        // Quit before the recovery check ever runs.
        db.close().expect("close without verify");
    }
    {
        let db = Database::open(&database).expect("reopen again");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "the recovery check is still pending"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen after verify");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a completed verify lets the next close mark the package clean"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn a_close_job_reads_the_recovery_state_after_earlier_jobs() {
    let (path, database) = temp_database("close-order");
    {
        let db = Database::open(&database).expect("open");
        let pending = Arc::clone(&db.recovery_pending);
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        // Queue the jobs by hand: a blocked verify would be skipped by the
        // close gate, so this pins the FIFO ordering of an earlier job
        // that did run and stored its outcome before the close is read.
        db.closing.store(true, Ordering::SeqCst);
        db.closed.store(true, Ordering::SeqCst);
        db.tx
            .lock()
            .expect("lock the job queue")
            .send(Job::Run(Box::new(move |_| {
                pending.store(true, Ordering::SeqCst);
            })))
            .expect("queue the marking job");
        db.tx
            .lock()
            .expect("lock the job queue")
            .send(Job::Close {
                ack: ack_tx,
                camera: None,
                recovery_pending: Arc::clone(&db.recovery_pending),
            })
            .expect("queue the close job");
        ack_rx.recv().expect("close ack").expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "the close job must read the state after the earlier job ran"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn gc_refuses_while_the_undo_history_holds_an_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let error = db.gc().expect_err("an undoable edit blocks collection");
    assert!(error.contains("undo history"), "{error}");

    db.clear_history().expect("clear history");
    let report = db.gc().expect("collect an idle package");
    assert_eq!(report.batches, 0.0);
    assert_eq!(report.assets, 0.0);
}

#[test]
fn gc_keeps_outputs_inputs_and_the_newest_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("s", "S", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        result_batch("b1", "s", "done"),
        vec![result_text_item("i1", "one")],
    )
    .expect("first run");
    db.connect_edge(edge("s-t", "s", "t"))
        .expect("snapshot b1 into the target");
    db.save_run(
        result_batch("b2", "s", "done"),
        vec![result_text_item("i2", "two")],
    )
    .expect("second run");
    db.save_run(result_batch("b3", "s", "failed"), Vec::new())
        .expect("failed run");
    db.save_run(
        result_batch("b4", "s", "done"),
        vec![result_text_item("i4", "four")],
    )
    .expect("third run");
    // A later failure keeps b4 as the output but becomes the newest batch,
    // which carries the composer's error line.
    db.save_run(result_batch("b5", "s", "failed"), Vec::new())
        .expect("failed run after the output");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 2.0, "b2 and the failed b3 are unreachable");
    assert_eq!(report.items, 1.0, "only b2 had an item");
    assert!(batch_exists(&db, "b1"), "the input snapshot keeps b1");
    assert!(!batch_exists(&db, "b2"));
    assert!(!batch_exists(&db, "b3"));
    assert!(batch_exists(&db, "b4"), "the output batch stays");
    assert!(batch_exists(&db, "b5"), "the newest batch stays");
    let detail = db
        .node_detail("t".to_owned())
        .expect("detail")
        .expect("target node");
    assert_eq!(detail.inputs[0].item_id.as_deref(), Some("i1"));
    assert!(detail.inputs[0].item.is_some());
    let source = db
        .node_detail("s".to_owned())
        .expect("detail")
        .expect("source node");
    assert_eq!(
        source.batch.as_ref().map(|batch| batch.id.as_str()),
        Some("b4")
    );
    assert_eq!(
        source.latest_batch.as_ref().map(|batch| batch.id.as_str()),
        Some("b5")
    );
}

#[test]
fn gc_collects_a_deleted_incarnations_batches() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("x", "X", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        result_batch("old", "x", "done"),
        vec![result_text_item("old-item", "old")],
    )
    .expect("old run");
    db.delete_nodes(vec!["x".to_owned()])
        .expect("delete the node");
    db.insert_nodes(vec![node("x", "X", "", &[], 0.0, 0.0)])
        .expect("recreate the same id");
    db.save_run(
        result_batch("new", "x", "done"),
        vec![result_text_item("new-item", "new")],
    )
    .expect("new run");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 1.0);
    assert!(
        !batch_exists(&db, "old"),
        "the dead incarnation's batch is not the newest of a live node"
    );
    assert!(batch_exists(&db, "new"));
}

#[test]
fn gc_never_collects_a_running_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(result_batch("run-1", "a", "running"))
        .expect("first running batch");
    db.begin_run(result_batch("run-2", "a", "running"))
        .expect("second running batch");
    db.clear_history().expect("clear history");

    // run-1 is neither the output nor the newest batch; only its running
    // status keeps it, and the delete trigger would abort the collection.
    let report = db.gc().expect("running batches are not collectable");
    assert_eq!(report.batches, 0.0);
    assert!(batch_exists(&db, "run-1"));
    assert!(batch_exists(&db, "run-2"));
}

#[test]
fn gc_collects_unreferenced_assets_and_orphan_files() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("kept", "Kept", "", &[], 0.0, 0.0),
        node("gone", "Gone", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    let kept_asset = test_asset(&db, "kept-asset");
    let input_asset = test_asset(&db, "input-asset");
    let dead_asset = test_asset(&db, "dead-asset");
    let orphan_asset = test_asset(&db, "orphan-asset");
    // A text item has a NULL asset_id; the asset NOT IN subqueries must
    // filter those out or every asset becomes "possibly referenced".
    let mut kept_text = result_text_item("kept-text", "note");
    kept_text.port_id = "text".to_owned();
    db.save_run(
        result_batch("kept-batch", "kept", "done"),
        vec![result_image_item("kept-item", &kept_asset), kept_text],
    )
    .expect("kept run");
    db.insert_nodes(vec![node("src", "Src", "", &[], 0.0, 300.0)])
        .expect("source node");
    db.save_run(
        result_batch("src-batch", "src", "done"),
        vec![result_text_item("src-item", "upstream")],
    )
    .expect("source run");
    db.connect_edge(edge("src-kept", "src", "kept"))
        .expect("text edge input with a NULL asset");
    db.save_run(
        result_batch("dead-batch", "gone", "done"),
        vec![result_image_item("dead-item", &dead_asset)],
    )
    .expect("run of the node that is deleted");
    db.add_input(InputItemInput {
        id: "local-input".to_owned(),
        node_id: "kept".to_owned(),
        port_id: "references".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some(input_asset.clone()),
        text: String::new(),
        meta_json: None,
    })
    .expect("local input");
    db.delete_nodes(vec!["gone".to_owned()])
        .expect("delete the node, leaving its batch");
    let orphan_hash = "ab".repeat(32);
    fs::write(db.assets_dir.join(&orphan_hash), b"orphan file").expect("write the orphan");
    let orphan_temp = format!(".{orphan_hash}.tmp-1234");
    fs::write(db.assets_dir.join(&orphan_temp), b"partial").expect("write the orphan temp");
    let kept_temp = format!(".{}.tmp-5678", asset_hash(&db, &kept_asset));
    fs::write(db.assets_dir.join(&kept_temp), b"partial").expect("write the kept temp");
    fs::write(db.assets_dir.join("notes.txt"), b"keep me").expect("write the unknown file");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 1.0);
    assert_eq!(report.items, 1.0);
    assert_eq!(report.assets, 2.0, "the dead and orphan rows are gone");
    assert_eq!(
        report.files, 4.0,
        "two asset files, the orphan hash and its temp file"
    );
    assert!(db.asset_bytes(kept_asset).is_ok());
    assert!(db.asset_bytes(input_asset).is_ok());
    assert!(db.asset_bytes(dead_asset).is_err());
    assert!(db.asset_bytes(orphan_asset).is_err());
    assert!(db.assets_dir.join("notes.txt").exists());
    assert!(!db.assets_dir.join(&orphan_hash).exists());
    assert!(!db.assets_dir.join(&orphan_temp).exists());
    assert!(
        db.assets_dir.join(&kept_temp).exists(),
        "a temp file whose hash still has a row is not an orphan"
    );
}

#[test]
fn reset_clears_content_and_keeps_the_project_identity() {
    let db = Database::open(":memory:").expect("open");
    db.seed_document(seed_input()).expect("seed");
    db.insert_nodes(vec![node("extra", "Extra", "", &[], 0.0, 300.0)])
        .expect("extra node");
    let asset = test_asset(&db, "reset-asset");
    db.save_view(10.0, 20.0, 2.0).expect("save the view");
    let before = db.project_info().expect("info before the reset");
    let created_at = db
        .run(|conn| {
            document::current(conn)
                .map(|row| row.created_at)
                .map_err(|error| error.to_string())
        })
        .expect("read the creation time");
    assert!(before.demo_seeded);

    db.reset().expect("reset");

    let after = db.project_info().expect("info after the reset");
    assert_eq!(after.project_id, before.project_id, "identity survives");
    assert_eq!(after.title, before.title);
    assert_eq!((after.node_count, after.edge_count), (0.0, 0.0));
    assert!(!after.demo_seeded);
    assert_eq!(
        (after.camera_x, after.camera_y, after.camera_zoom),
        (0.0, 0.0, 1.0)
    );
    let created_after = db
        .run(|conn| {
            document::current(conn)
                .map(|row| row.created_at)
                .map_err(|error| error.to_string())
        })
        .expect("read the new creation time");
    assert_eq!(created_after, created_at);
    assert!(
        !db.assets_dir.exists(),
        "the parked asset directory is deleted"
    );
    assert!(db.asset_bytes(asset).is_err(), "asset rows are gone");

    // The undo history was cleared, and the recreated schema still works.
    let undo = db.undo().expect("undo after the reset");
    assert!(undo.changed.is_empty() && undo.removed.is_empty());
    db.insert_nodes(vec![node("new", "New", "", &[], 0.0, 0.0)])
        .expect("insert after the reset");
    assert_eq!(db.count().expect("count after the reset"), 1);
    db.verify().expect("verify the recreated schema");
}

#[test]
fn verify_stops_at_the_entry_when_a_close_is_pending() {
    let db = Database::open(":memory:").expect("open");
    let error = db
        .run(|conn| verify_connection(conn, || true))
        .expect_err("a pending close aborts the recovery check");
    assert!(error.contains("closing"), "{error}");
}

#[test]
fn a_close_request_skips_a_queued_verify_and_leaves_it_pending() {
    let (path, database) = temp_database("verify-skip");
    {
        let db = Database::open(&database).expect("open");
        db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .expect("insert");
        // Drop without close: the package is due for recovery.
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(!db.project_info().expect("info").opened_clean);
        db.closing.store(true, Ordering::SeqCst);
        let error = db
            .verify()
            .expect_err("the close gate skips the queued check");
        assert!(error.contains("closed"), "{error}");
        db.close().expect("close after the skipped check");
    }
    {
        let db = Database::open(&database).expect("reopen after close");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "a skipped verify keeps the recovery pending"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn verify_stops_between_phases_and_rolls_the_repair_back() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.insert_edges(vec![edge("a-b", "a", "b")])
        .expect("connect");
    let seq = edge_seq(&db, "a-b");
    let before = min_x_of(&db, "edges_rtree", seq);
    // A direct geometry write records the dirty connector but does not
    // run the command's flush, so the edge box still holds the old curve.
    direct_write(&db, "UPDATE nodes SET x = x + 400 WHERE id = 'a'");
    assert_eq!(min_x_of(&db, "edges_rtree", seq), before);
    let error = db
        .run(|conn| {
            let calls = std::cell::Cell::new(0u32);
            // Stop after the transaction's geometry flush has run with a
            // repair phase still to go: the rollback must undo the flush.
            verify_connection(conn, || {
                let next = calls.get() + 1;
                calls.set(next);
                next >= 6
            })
        })
        .expect_err("a close between phases aborts the repair");
    assert!(error.contains("closing"), "{error}");
    assert_eq!(
        min_x_of(&db, "edges_rtree", seq),
        before,
        "the aborted transaction rolled the flush back"
    );
    let dirty = db
        .run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes_geometry_dirty".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the dirty count");
    assert!(dirty > 0, "the flush still has work to do");

    db.verify().expect("the next verify finishes the repair");
    assert!(
        (min_x_of(&db, "edges_rtree", seq) - before).abs() > 50.0,
        "the completed flush updates the edge box"
    );
}

#[test]
fn save_view_persists_without_bumping_the_revision() {
    let db = Database::open(":memory:").expect("open");
    let before = current_rev(&db);
    db.save_view(120.0, -40.0, 2.5).expect("save view");
    let info = db.project_info().expect("project info");
    assert_eq!(
        (info.camera_x, info.camera_y, info.camera_zoom),
        (120.0, -40.0, 2.5)
    );
    assert_eq!(current_rev(&db), before, "the camera is not an undo step");

    for (x, y, zoom) in [
        (f64::NAN, 0.0, 1.0),
        (0.0, f64::INFINITY, 1.0),
        (0.0, 0.0, 0.0),
    ] {
        let error = db
            .save_view(x, y, zoom)
            .expect_err("an invalid camera must be refused");
        assert!(error.contains("camera"), "{error}");
    }
}

#[test]
fn verify_accepts_a_healthy_package() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.verify().expect("a healthy package passes verification");
}

#[test]
fn verify_rejects_an_orphan_input_row() {
    let db = Database::open(":memory:").expect("open");
    test_asset(&db, "asset-orphan");
    db.run(|conn| {
            conn.execute_unprepared("PRAGMA foreign_keys = OFF")
                .map_err(|error| error.to_string())?;
            let inserted = conn.execute_unprepared(
                "INSERT INTO node_inputs \
                 (id, node_id, position, port_id, kind, origin, asset_id, text, meta_json, created_at) \
                 VALUES ('orphan', 'missing', 0, 'references', 'image', 'local', \
                         'asset-orphan', '', '{}', 0)",
            );
            conn.execute_unprepared("PRAGMA foreign_keys = ON")
                .map_err(|error| error.to_string())?;
            inserted.map(|_| ()).map_err(|error| error.to_string())
        })
        .expect("insert an orphan input with foreign keys off");
    let error = db.verify().expect_err("verify must report the orphan row");
    assert!(error.contains("foreign-key"), "{error}");
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

#[test]
fn project_info_reports_the_previous_shutdown_state() {
    let (path, database) = temp_database("opened-clean");
    {
        let db = Database::open(&database).expect("open");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a new package has nothing from a previous session"
        );
        db.close().expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a clean close reopens clean"
        );
        // Dropping without close leaves the package dirty.
    }
    {
        let db = Database::open(&database).expect("reopen after an abandoned session");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "an abandoned session schedules verify"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn verify_rebuilds_a_drifted_fts_index() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node(
        "a",
        "Alpha",
        "searchable body",
        &["tag"],
        0.0,
        0.0,
    )])
    .expect("insert");
    let seq = node_seq(&db, "a");
    // Remove the index entry without the trigger that mirrors nodes.
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "INSERT INTO nodes_fts(nodes_fts, rowid, title, body, tags) \
                 VALUES('delete', ?, ?, ?, ?)",
            [
                seq.into(),
                "Alpha".into(),
                "searchable body".into(),
                "tag".into(),
            ],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("desync the index");
    assert!(
        db.search("searchable".to_owned(), SearchFilters::default(), 20)
            .expect("search the missing row")
            .is_empty(),
        "the index lost the node"
    );

    db.verify().expect("verify rebuilds the index");
    let hits = db
        .search("searchable".to_owned(), SearchFilters::default(), 20)
        .expect("search after verify");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "a");
}

#[test]
fn verify_rebuilds_a_missing_node_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 10.0, 20.0)])
        .expect("insert");
    let seq = node_seq(&db, "a");
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "DELETE FROM nodes_rtree WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("remove the box");
    let rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 400.0,
    };
    assert!(
        db.viewport(rect.clone(), 0.0).expect("viewport").is_empty(),
        "the missing box hides the node"
    );

    db.verify().expect("verify rebuilds the node index");
    assert_eq!(
        db.viewport(rect, 0.0).expect("viewport after verify").len(),
        1
    );
}

#[test]
fn verify_rebuilds_a_stale_node_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 10.0, 20.0)])
        .expect("insert");
    let seq = node_seq(&db, "a");
    let min_x = |db: &Database| {
        db.run(move |conn| {
            conn.query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DbBackend::Sqlite,
                "SELECT min_x FROM nodes_rtree WHERE id = ?",
                [seq.into()],
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the box row is missing".to_owned())?
            .try_get_by_index::<f64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the box")
    };
    assert!((min_x(&db) - 8.0).abs() < 0.01);
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "UPDATE nodes_rtree \
                    SET min_x = min_x + 1000, max_x = max_x + 1000 \
                  WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("move the box away from the node");
    assert!(
        (min_x(&db) - 8.0).abs() > 100.0,
        "the box no longer matches the node"
    );

    db.verify().expect("verify rebuilds a stale box");
    assert!((min_x(&db) - 8.0).abs() < 0.01);
}

#[test]
fn verify_rebuilds_a_stale_edge_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.insert_edges(vec![edge("a-b", "a", "b")])
        .expect("connect");
    // The view and the RTree key on `edges.seq`, not the connector id.
    let seq = edge_seq(&db, "a-b");
    let expected = min_x_of(&db, "edge_boxes", seq);
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "UPDATE edges_rtree SET min_x = min_x + 1000, max_x = max_x + 1000 \
                  WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("move the edge box away");
    let stale = min_x_of(&db, "edges_rtree", seq);
    assert!((stale - expected).abs() > 100.0);

    db.verify().expect("verify rebuilds the edge box");
    let repaired = min_x_of(&db, "edges_rtree", seq);
    assert!((repaired - expected).abs() < 0.01);
}

#[test]
fn verify_accepts_rtree_cells_at_the_world_limits() {
    let db = Database::open(":memory:").expect("open");
    // The quarter-unit offsets are not representable in a 32-bit RTree
    // cell, so the stored cells genuinely round outward at these
    // magnitudes. Exact coordinates would make the parity delta zero and
    // leave the tolerance untested.
    db.insert_nodes(vec![
        node("a", "A", "", &[], 9_999_000.25, -9_999_000.25),
        node("b", "B", "", &[], -9_999_000.25, 9_999_000.25),
        node("c", "C", "", &[], 0.125, -0.375),
        node("d", "D", "", &[], 8_388_000.75, -8_388_000.75),
    ])
    .expect("insert at the world limits");
    let mut across = edge("limit-edge", "a", "b");
    across.from_offset = 42.3;
    across.to_offset = 42.7;
    db.insert_edges(vec![across])
        .expect("connect across the world");
    db.verify()
        .expect("legitimate 32-bit cells pass the parity tolerance");
}

#[test]
fn verify_clears_leftover_geometry_markers() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.insert_edges(vec![EdgeInput {
        id: "a-b".to_owned(),
        from_id: "a".to_owned(),
        to_id: "b".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    }])
    .expect("connect");
    db.run(|conn| {
        conn.execute_unprepared("INSERT INTO nodes_geometry_dirty (node_id) VALUES ('a')")
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .expect("leave a marker behind");
    let markers = |db: &Database| {
        db.run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes_geometry_dirty".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the marker count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("count markers")
    };
    assert_eq!(markers(&db), 1);

    db.verify().expect("verify flushes the markers");
    assert_eq!(markers(&db), 0);
}

#[test]
fn verify_tightens_the_bounds_without_bumping_the_revision() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 5000.0, 5000.0),
    ])
    .expect("insert");
    db.delete_nodes(vec!["b".to_owned()]).expect("delete");
    let loose = db.bounds().expect("bounds after delete");
    assert!(
        loose.width > 200.0,
        "a delete leaves the conservative envelope"
    );
    let rev = current_rev(&db);

    db.verify().expect("verify compacts the bounds");
    let exact = db.bounds().expect("bounds after verify");
    assert_eq!(
        (exact.x, exact.y, exact.width, exact.height),
        (0.0, 0.0, 200.0, 84.0)
    );
    assert_eq!(current_rev(&db), rev, "maintenance is not an undo step");
}

#[test]
fn a_provider_run_is_inserted_running_then_settled() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-failed".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "failed".to_owned(),
            error: Some("prompt is empty".to_owned()),
        },
        Vec::new(),
    )
    .expect("save a failed run");
    let (status, error, item_count, finished_at) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-failed"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.error, row.item_count, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "failed");
    assert_eq!(error.as_deref(), Some("prompt is empty"));
    assert_eq!(item_count, 0);
    assert!(finished_at.is_some(), "a settled batch is finished");

    db.save_run(
        ResultBatchInput {
            id: "batch-done".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-done".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "result".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("save a successful run");
    let (status, item_count) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-done"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.item_count)))
                .map_err(|error| error.to_string())
        })
        .expect("read done batch")
        .expect("done row");
    assert_eq!((status.as_str(), item_count), ("done", 1));

    // The triggers own the state machine: a settled insert or a late item
    // write is refused rather than silently stored.
    let late_insert = db.run(|conn| {
        conn.execute_unprepared(
            "INSERT INTO result_batches \
                 (id, node_id, node_seq, trigger, status, created_at) \
                 VALUES ('batch-direct', 'a', 1, 'run', 'done', 0)",
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    });
    assert!(late_insert.is_err(), "a batch must be inserted running");
    let late_item = db.run(|conn| {
        conn.execute_unprepared(
            "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
                 VALUES ('late', 'batch-done', 1, 'out', 'text', 'late')",
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    });
    assert!(late_item.is_err(), "items only enter a running batch");
}

#[test]
fn begin_and_settle_a_provider_run() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let begun = db
        .begin_run(ResultBatchInput {
            id: "batch-run".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        })
        .expect("begin run");
    assert_eq!(begun.changed[0].status, "running");
    assert_eq!(begun.changed[0].output_batch_id, None);
    let running = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-run"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(running, ("running".to_owned(), None));

    let settled = db
        .settle_run(
            ResultBatchInput {
                id: "batch-run".to_owned(),
                node_id: "a".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: r#"{"prompt":"p"}"#.to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-run".to_owned(),
                position: 0.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "run result".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("settle run");
    assert_eq!(settled.changed[0].status, "done");
    assert_eq!(
        settled.changed[0].output_batch_id.as_deref(),
        Some("batch-run")
    );
    assert_eq!(settled.changed[0].body, "run result");
    let settled_row = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-run"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.item_count, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read settled batch")
        .expect("settled row");
    assert_eq!(settled_row.0, "done");
    assert_eq!(settled_row.1, 1);
    assert!(settled_row.2.is_some());

    // A repeated or absent settle changes nothing and does not bump the
    // revision.
    let before = current_rev(&db);
    let settle_input = |id: &str| ResultBatchInput {
        id: id.to_owned(),
        node_id: "a".to_owned(),
        trigger: "run".to_owned(),
        provider: "mock-text".to_owned(),
        model: "mock-text".to_owned(),
        params_json: "{}".to_owned(),
        status: "failed".to_owned(),
        error: None,
    };
    let repeated = db
        .settle_run(settle_input("batch-run"), Vec::new())
        .expect("repeated settle");
    assert!(repeated.changed.is_empty());
    assert_eq!(repeated.rev, before as f64);
    let missing = db
        .settle_run(settle_input("batch-missing"), Vec::new())
        .expect("late settle");
    assert!(missing.changed.is_empty());
    assert_eq!(current_rev(&db), before);
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

#[test]
fn a_failed_rerun_keeps_the_previous_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        run_batch("batch-first", "a", "done", None),
        vec![text_item("item-first", "first result")],
    )
    .expect("first run");
    let first = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node");
    let first_batch = first.batch.expect("the first run is the output");
    assert_eq!(first.node.status, "done");
    assert_eq!(first.node.output_batch_id.as_deref(), Some("batch-first"));
    assert_eq!(first_batch.id, "batch-first");
    assert_eq!(first_batch.error, None, "a done batch has no error");

    for (batch_id, status, error) in [
        ("batch-failed", "failed", Some("the provider failed")),
        ("batch-cancelled", "cancelled", None),
    ] {
        db.begin_run(run_batch(batch_id, "a", "running", None))
            .expect("begin rerun");
        let settled = db
            .settle_run(run_batch(batch_id, "a", status, error), Vec::new())
            .expect("settle rerun");
        let changed = settled
            .changed
            .iter()
            .find(|changed| changed.id == "a")
            .expect("the node changed");
        assert_eq!(changed.status, status);
        assert_eq!(
            changed.output_batch_id.as_deref(),
            Some("batch-first"),
            "a {status} run keeps the previous output"
        );
        assert_eq!(
            changed.body, "first result",
            "a {status} run keeps the body"
        );
        let detail = db
            .node_detail("a".to_owned())
            .expect("detail")
            .expect("node");
        assert_eq!(detail.batch.expect("output batch").id, "batch-first");
        let latest = detail.latest_batch.expect("the rerun batch");
        assert_eq!(
            (latest.id.as_str(), latest.status.as_str()),
            (batch_id, status)
        );
    }
}

#[test]
fn deleting_a_node_mid_run_cancels_its_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin run");
    assert_eq!(
        db.delete_nodes(vec!["a".to_owned()])
            .expect("delete mid-run")
            .changes
            .removed,
        ["a"]
    );
    let settled = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-live"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(settled.0, "cancelled", "delete settles the running batch");
    assert!(settled.1.is_some(), "the cancelled batch is finished");

    // Undo restores the node in a terminal state, not stuck running with
    // no run behind it.
    let undone = db.undo().expect("undo the delete");
    let restored = undone
        .changed
        .iter()
        .find(|changed| changed.id == "a")
        .expect("the node came back");
    assert_eq!(restored.status, "cancelled");

    // A late provider result is a no-op: it can neither fill the settled
    // batch nor overwrite the node the undo restored.
    let late = db
        .settle_run(
            run_batch("batch-live", "a", "done", None),
            vec![text_item("late-item", "late result")],
        )
        .expect("late settle");
    assert!(late.changed.is_empty());
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("the node exists");
    assert_eq!(detail.node.status, "cancelled");
    assert_eq!(detail.node.body, "");
    assert!(detail.batch.is_none(), "the cancelled run wrote no output");
    assert_eq!(
        detail.latest_batch.map(|batch| batch.status),
        Some("cancelled".to_owned())
    );

    // The late settle did not invalidate the delete's redo entry.
    assert_eq!(db.redo().expect("redo the delete").removed, ["a"]);
    assert_eq!(db.count().expect("nodes after redo"), 0);

    // A one-call write for the now-missing node is also a no-op.
    let late_save = db
        .save_run(run_batch("batch-orphan", "a", "failed", None), Vec::new())
        .expect("late save");
    assert!(late_save.changed.is_empty());
    let batch_count = db
        .run(|conn| {
            result_batches::Entity::find()
                .all(conn)
                .map(|rows| rows.len())
                .map_err(|error| error.to_string())
        })
        .expect("count batches");
    assert_eq!(
        batch_count, 1,
        "a late save for a missing node writes nothing"
    );
}

#[test]
fn a_recreated_node_id_does_not_inherit_the_previous_incarnation_batches() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        run_batch("batch-old", "n", "done", None),
        vec![text_item("item-old", "old result")],
    )
    .expect("run");
    assert_eq!(
        db.node_detail("n".to_owned())
            .expect("detail")
            .expect("node")
            .latest_batch
            .expect("latest batch")
            .id,
        "batch-old"
    );

    db.delete_nodes(vec!["n".to_owned()]).expect("delete");
    db.insert_nodes(vec![node("n", "N", "new", &[], 10.0, 10.0)])
        .expect("recreate the id");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("the new node");
    assert!(detail.batch.is_none(), "the new incarnation has no output");
    assert!(
        detail.latest_batch.is_none(),
        "a re-created id must not inherit the dead incarnation's batch"
    );
}

#[test]
fn settling_a_run_for_a_missing_or_replaced_node_cancels_it() {
    let db = Database::open(":memory:").expect("open");
    let remove_node = |id: &str| {
        let id = id.to_owned();
        db.run(move |conn| {
            node_rows::Entity::delete_many()
                .filter(node_rows::Column::Id.eq(id))
                .exec(conn)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .expect("remove the node out of band");
    };
    let batch_state = |id: &str| {
        let id = id.to_owned();
        db.run(move |conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq(id))
                .one(conn)
                .map(|row| {
                    row.map(|row| {
                        (
                            row.status,
                            row.item_count,
                            row.finished_at,
                            row.error.unwrap_or_default(),
                        )
                    })
                })
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row")
    };

    // The node row disappears while its batch still runs.
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-missing", "a", "running", None))
        .expect("begin run");
    remove_node("a");
    let missing = db
        .settle_run(
            run_batch("batch-missing", "a", "done", None),
            vec![text_item("late-item", "late result")],
        )
        .expect("settle against a missing node");
    assert!(missing.changed.is_empty());
    let (status, item_count, finished_at, error) = batch_state("batch-missing");
    assert_eq!(status, "cancelled");
    assert_eq!(item_count, 0, "an orphan settle writes no items");
    assert!(finished_at.is_some(), "the orphan batch is finished");
    assert!(error.contains("deleted"), "{error}");

    // The id comes back as a new incarnation (new seq) while the old
    // batch still runs: the old run must not attach to it.
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("new incarnation");
    db.begin_run(run_batch("batch-incarnation", "a", "running", None))
        .expect("begin run");
    remove_node("a");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("third incarnation");
    let replaced = db
        .settle_run(
            run_batch("batch-incarnation", "a", "done", None),
            vec![text_item("wrong-item", "wrong")],
        )
        .expect("settle against a replaced node");
    assert!(replaced.changed.is_empty());
    let (status, item_count, _, _) = batch_state("batch-incarnation");
    assert_eq!(status, "cancelled");
    assert_eq!(item_count, 0, "a dead incarnation's run writes no items");
    let live = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("the live node");
    assert!(live.batch.is_none(), "the new incarnation has no output");
    assert!(live.latest_batch.is_none());
}

#[test]
fn deleting_several_nodes_settles_only_the_running_ones() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        run_batch("batch-done", "b", "done", None),
        vec![text_item("item-done", "done result")],
    )
    .expect("settle b");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin on a");

    let deleted = db
        .delete_nodes(vec!["a".to_owned(), "b".to_owned()])
        .expect("delete both");
    assert_eq!(deleted.changes.removed.len(), 2);
    let running = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Status.eq("running"))
                .all(conn)
                .map(|rows| rows.len())
                .map_err(|error| error.to_string())
        })
        .expect("count running batches");
    assert_eq!(running, 0, "no batch outlives its node");
    let done = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-done"))
                .one(conn)
                .map(|row| row.map(|row| row.status))
                .map_err(|error| error.to_string())
        })
        .expect("read done batch")
        .expect("done batch");
    assert_eq!(done, "done", "a settled batch is left untouched");

    let undone = db.undo().expect("undo the delete");
    let mut statuses: BTreeMap<&str, &str> = BTreeMap::new();
    for changed in &undone.changed {
        statuses.insert(changed.id.as_str(), changed.status.as_str());
    }
    assert_eq!(statuses.get("a"), Some(&"cancelled"));
    assert_eq!(statuses.get("b"), Some(&"done"));
    let b = db
        .node_detail("b".to_owned())
        .expect("detail")
        .expect("b returned");
    assert_eq!(b.batch.expect("output batch").id, "batch-done");
}

#[test]
fn applying_a_delete_op_cancels_a_running_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin");
    let changes = db
        .apply_ops(&[HistoryOp::Delete { id: "a".to_owned() }])
        .expect("apply a delete op");
    assert_eq!(changes.removed, ["a"]);
    let status = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-live"))
                .one(conn)
                .map(|row| row.map(|row| row.status))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "cancelled");
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

#[test]
fn seed_document_writes_the_example_and_only_once() {
    let db = Database::open(":memory:").expect("open");
    // Populate the undo stack on an empty document first: a successful
    // seed must clear it, so undo cannot revive the scratch node or
    // remove the demo.
    db.insert_nodes(vec![node("scratch", "Scratch", "", &[], 0.0, 0.0)])
        .expect("scratch node");
    db.delete_nodes(vec!["scratch".to_owned()])
        .expect("delete the scratch node");
    assert_eq!(db.count().expect("empty again"), 0);
    let changes = db.seed_document(seed_input()).expect("seed");
    assert_eq!(db.count().expect("nodes"), 2);
    assert_eq!(db.edge_count().expect("edges"), 1);
    assert_eq!(changes.edges_changed.len(), 1);
    let text = db
        .node_detail("seed-text".to_owned())
        .expect("detail")
        .expect("text detail");
    assert_eq!(text.node.status, "done");
    assert_eq!(text.node.body, "A calm lake.");
    assert_eq!(text.batch.expect("batch").items[0].text, "A calm lake.");
    let image = db
        .node_detail("seed-image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(image.inputs.len(), 1);
    assert_eq!(image.inputs[0].item_id.as_deref(), Some("seed-item"));
    let info = db.project_info().expect("project info");
    assert!(info.demo_seeded);
    assert_eq!((info.node_count, info.edge_count), (2.0, 1.0));

    // The seed is not undo history.
    assert!(db.undo().expect("undo after seed").changed.is_empty());

    // A second seed is a no-op even after the user deletes every node,
    // and it leaves the delete undoable: only a new project or a reset
    // seeds again.
    db.delete_nodes(vec!["seed-text".to_owned(), "seed-image".to_owned()])
        .expect("delete the demo");
    assert_eq!(db.count().expect("empty nodes"), 0);
    let second = db.seed_document(seed_input()).expect("second seed");
    assert!(second.changed.is_empty());
    assert_eq!(db.count().expect("still empty"), 0);
    let undone = db.undo().expect("undo the delete after a no-op seed");
    let restored: BTreeSet<&str> = undone.changed.iter().map(|node| node.id.as_str()).collect();
    assert!(
        restored.contains("seed-text") && restored.contains("seed-image"),
        "the no-op seed kept the delete undoable"
    );
    assert_eq!(db.count().expect("the demo is back"), 2);
}

#[test]
fn seed_document_refuses_a_non_empty_document_and_rolls_back() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("existing", "Existing", "", &[], 0.0, 0.0)])
        .expect("insert");
    let error = db
        .seed_document(seed_input())
        .expect_err("a non-empty document must be refused");
    assert!(error.contains("not empty"), "{error}");
    assert_eq!(db.count().expect("count"), 1);

    let db = Database::open(":memory:").expect("open");
    let mut input = seed_input();
    input.edges[0].to_id = "missing".to_owned();
    let error = db
        .seed_document(input)
        .expect_err("an edge to a missing node must fail");
    assert!(error.contains("missing"), "{error}");
    assert_eq!(db.count().expect("rolled back nodes"), 0);
    assert_eq!(db.edge_count().expect("rolled back edges"), 0);
    assert!(!db.project_info().expect("project info").demo_seeded);
}

#[test]
fn recovering_a_running_batch_settles_it_with_a_finish_time() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("a".to_owned(), "running".to_owned())
        .expect("running");
    db.save_run(
        ResultBatchInput {
            id: "batch-running".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");
    assert_eq!(db.recover_runs().expect("recover"), 1);
    let (status, finished_at) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-running"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "interrupted");
    assert!(finished_at.is_some(), "recovery settles the batch");
}

#[test]
fn empty_document_has_no_nodes_or_edges() {
    fn is_empty(conn: &DatabaseConnection) -> Result<bool, String> {
        Ok(!has_nodes(conn)? && !has_edges(conn)?)
    }

    let conn = open_connection(":memory:", OpenMode::Create)
        .expect("open memory database")
        .conn;
    assert!(is_empty(&conn).expect("empty predicate"));

    mutation::insert_nodes(
        &conn,
        vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 300.0, 0.0),
        ],
    )
    .expect("insert nodes");
    assert!(!is_empty(&conn).expect("node-only predicate"));
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
