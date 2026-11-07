use std::fs;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter,
};

use crate::clock::now_ms;
use crate::constants::DOCUMENT_ID;
use crate::document;
use crate::entity::{documents, edges, nodes};
use crate::history::HistoryOp;
use crate::mutation::{self, Mutation};
use crate::scene;
use crate::schema;
use crate::search;
use crate::types::{
    ChangeSet, EdgeInput, NodeBounds, NodeInput, NodeSummary, SceneSnapshot, SearchFilters,
    SearchHit, Viewport,
};
use crate::viewport;

type Job = Box<dyn FnOnce(&DatabaseConnection) + Send + 'static>;

/// A handle to the database worker.
///
/// SeaORM's sync Rusqlite connection is deliberately not `Send` (it holds a
/// non-`Send` metric callback), so the connection lives on one worker thread.
/// This handle only carries jobs to it; it is cheap to clone and can move to
/// NSH's blocking pool.
#[derive(Clone)]
pub struct Database {
    tx: Arc<Mutex<Sender<Job>>>,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let path = path.to_owned();

        std::thread::Builder::new()
            .name("flow-db".to_owned())
            .spawn(move || worker(&path, ready_tx, job_rx))
            .map_err(|error| error.to_string())?;

        ready_rx
            .recv()
            .map_err(|_| "the database worker stopped during startup".to_owned())??;

        Ok(Self {
            tx: Arc::new(Mutex::new(job_tx)),
        })
    }

    pub fn insert_nodes(&self, nodes: Vec<NodeInput>) -> Result<Mutation, String> {
        self.run(move |conn| mutation::insert_nodes(conn, nodes))
    }

    pub fn move_nodes(&self, ids: Vec<String>, dx: f64, dy: f64) -> Result<Mutation, String> {
        self.run(move |conn| mutation::move_nodes(conn, ids, dx, dy))
    }

    pub fn set_node_text(
        &self,
        id: String,
        title: String,
        body: String,
        tags: Vec<String>,
    ) -> Result<Mutation, String> {
        self.run(move |conn| mutation::set_node_text(conn, id, title, body, tags))
    }

    pub fn delete_nodes(&self, ids: Vec<String>) -> Result<Mutation, String> {
        self.run(move |conn| mutation::delete_nodes(conn, ids))
    }

    pub fn set_node_bounds(&self, bounds: Vec<NodeBounds>) -> Result<Mutation, String> {
        self.run(move |conn| mutation::set_node_bounds(conn, bounds))
    }

    pub fn insert_edges(&self, edges: Vec<EdgeInput>) -> Result<Mutation, String> {
        self.run(move |conn| mutation::insert_edges(conn, edges))
    }

    pub fn delete_edges(&self, ids: Vec<String>) -> Result<Mutation, String> {
        self.run(move |conn| mutation::delete_edges(conn, ids))
    }

    pub fn apply_ops(&self, ops: &[HistoryOp]) -> Result<ChangeSet, String> {
        let ops = ops.to_vec();
        self.run(move |conn| mutation::apply_ops(conn, &ops))
    }

    pub fn viewport(&self, rect: Viewport, margin: f64) -> Result<Vec<NodeSummary>, String> {
        self.run(move |conn| viewport::viewport(conn, rect, margin))
    }

    pub fn scene(&self, rect: Viewport, margin: f64) -> Result<SceneSnapshot, String> {
        self.run(move |conn| scene::snapshot(conn, rect, margin))
    }

    pub fn bounds(&self) -> Result<Viewport, String> {
        self.run(scene::bounds)
    }

    pub fn get_node(&self, id: String) -> Result<Option<NodeSummary>, String> {
        self.run(move |conn| scene::get_node(conn, &id))
    }

    pub fn search(
        &self,
        query: String,
        filters: SearchFilters,
        limit: u32,
    ) -> Result<Vec<SearchHit>, String> {
        self.run(move |conn| search::search(conn, query, filters, limit))
    }

    pub fn count(&self) -> Result<u32, String> {
        self.run(count)
    }

    pub fn edge_count(&self) -> Result<u32, String> {
        self.run(edge_count)
    }

    pub fn empty_change(&self) -> Result<ChangeSet, String> {
        self.run(|conn| {
            Ok(ChangeSet {
                rev: document::current_rev(conn).map_err(|error| error.to_string())? as f64,
                changed: Vec::new(),
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            })
        })
    }

    fn run<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&DatabaseConnection) -> Result<T, String> + Send + 'static,
    {
        let (result_tx, result_rx) = mpsc::channel();
        let job: Job = Box::new(move |conn| {
            let _ = result_tx.send(work(conn));
        });

        self.tx
            .lock()
            .map_err(|_| "the database worker lock is poisoned".to_owned())?
            .send(job)
            .map_err(|_| "the database worker stopped".to_owned())?;

        result_rx
            .recv()
            .map_err(|_| "the database worker stopped".to_owned())?
    }
}

fn worker(path: &str, ready: Sender<Result<(), String>>, jobs: Receiver<Job>) {
    let conn = match open_connection(path) {
        Ok(conn) => {
            let _ = ready.send(Ok(()));
            conn
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    for job in jobs {
        job(&conn);
    }
}

fn open_connection(path: &str) -> Result<DatabaseConnection, String> {
    if path != ":memory:"
        && let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let url = sqlite_url(path);
    let conn = sea_orm::Database::connect(url.as_str()).map_err(|error| error.to_string())?;
    configure(&conn, path)?;
    schema::migrate(&conn)?;
    ensure_document(&conn)?;

    Ok(conn)
}

fn count(conn: &DatabaseConnection) -> Result<u32, String> {
    nodes::Entity::find()
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .count(conn)
        .map(|count| count as u32)
        .map_err(|error| error.to_string())
}

fn edge_count(conn: &DatabaseConnection) -> Result<u32, String> {
    edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .count(conn)
        .map(|count| count as u32)
        .map_err(|error| error.to_string())
}

fn sqlite_url(path: &str) -> String {
    if path == ":memory:" {
        return "sqlite::memory:".to_owned();
    }

    let normalized = path.replace('\\', "/");
    if normalized.bytes().all(is_uri_path_byte) {
        format!("sqlite://{normalized}")
    } else {
        let encoded = encode_uri_path(&normalized);
        if encoded.starts_with('/') {
            format!("sqlite:file:{encoded}")
        } else {
            format!("sqlite:file:///{encoded}")
        }
    }
}

fn is_uri_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
}

/// Percent-encodes a filesystem path for SQLite's `file:` URI. SQLite decodes
/// the escapes, so a data directory with spaces ("Application Support") works.
fn encode_uri_path(path: &str) -> String {
    use std::fmt::Write;

    let mut encoded = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        if is_uri_path_byte(*byte) {
            encoded.push(char::from(*byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn configure(conn: &DatabaseConnection, path: &str) -> Result<(), String> {
    conn.execute_unprepared("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -64000;")
        .map_err(|error| error.to_string())?;
    if path != ":memory:" {
        conn.execute_unprepared("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_document(conn: &DatabaseConnection) -> Result<(), String> {
    let exists = documents::Entity::find_by_id(DOCUMENT_ID)
        .one(conn)
        .map_err(|error| error.to_string())?
        .is_some();
    if exists {
        return Ok(());
    }

    let now = now_ms();
    documents::Entity::insert(documents::ActiveModel {
        id: Set(DOCUMENT_ID.to_owned()),
        title: Set("Flow".to_owned()),
        rev: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec(conn)
    .map_err(|error| error.to_string())?;

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }

    #[test]
    fn inserts_searches_moves_and_deletes() {
        let db = Database::open(":memory:").expect("open");
        let mutation = db
            .insert_nodes(vec![
                node(
                    "a",
                    "Image generator",
                    "Makes an image",
                    &["image"],
                    0.0,
                    0.0,
                ),
                node("b", "Text panel", "A text node", &["text"], 300.0, 0.0),
            ])
            .expect("insert");
        assert_eq!(mutation.changes.changed.len(), 2);
        assert_eq!(db.count().expect("count"), 2);

        let found = db.get_node("a".to_owned()).expect("get node");
        assert_eq!(
            found.as_ref().map(|node| node.title.as_str()),
            Some("Image generator")
        );
        assert!(
            db.get_node("missing".to_owned())
                .expect("get missing")
                .is_none()
        );

        let hits = db
            .search("generator".to_owned(), SearchFilters::default(), 20)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
        assert!(
            db.search("   ".to_owned(), SearchFilters::default(), 20)
                .expect("empty search")
                .is_empty()
        );
        assert_eq!(
            db.search(
                "panel".to_owned(),
                SearchFilters {
                    kind: Some("text".to_owned()),
                },
                20,
            )
            .expect("kind search")
            .len(),
            1
        );
        assert!(
            db.search(
                "panel".to_owned(),
                SearchFilters {
                    kind: Some("image".to_owned()),
                },
                20,
            )
            .expect("kind search miss")
            .is_empty()
        );

        let viewport = db
            .viewport(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 150.0,
                    height: 100.0,
                },
                0.0,
            )
            .expect("viewport");
        assert_eq!(viewport.len(), 1);
        assert_eq!(viewport[0].id, "a");

        let moved = db
            .move_nodes(vec!["a".to_owned()], 50.0, 25.0)
            .expect("move");
        assert_eq!(moved.changes.changed[0].x, 50.0);
        assert_eq!(moved.changes.changed[0].y, 25.0);

        db.apply_ops(&moved.inverse).expect("undo move");
        let restored = db
            .viewport(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 150.0,
                    height: 100.0,
                },
                0.0,
            )
            .expect("viewport after undo");
        assert_eq!(restored[0].x, 0.0);

        let deleted = db.delete_nodes(vec!["a".to_owned()]).expect("delete");
        assert_eq!(deleted.changes.removed, vec!["a"]);
        assert_eq!(db.count().expect("count after delete"), 1);
        db.apply_ops(&deleted.inverse).expect("undo delete");
        assert_eq!(db.count().expect("count after undo"), 2);
    }

    #[test]
    fn viewport_prefers_nodes_inside_the_rect_over_the_margin() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a-margin", "Margin", "", &[], -250.0, 10.0),
            node("z-inside", "Inside", "", &[], 10.0, 10.0),
        ])
        .expect("insert");

        let nodes = db
            .viewport(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
                300.0,
            )
            .expect("viewport");

        // `a-margin` sorts first by id, but only intersects the prefetch
        // margin; the card budget must see the visible node first.
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].id, "z-inside");
    }

    #[test]
    fn short_cjk_queries_use_the_like_fallback() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node(
            "a",
            "图像生成器",
            "把文本变成图片",
            &["设计", "生成"],
            0.0,
            0.0,
        )])
        .expect("insert");

        // Two characters cannot be indexed by the trigram tokenizer; each
        // searchable field falls back to the bounded LIKE scan.
        for query in ["图像", "图片", "设计"] {
            let hits = db
                .search(query.to_owned(), SearchFilters::default(), 20)
                .expect("short search");
            assert_eq!(hits.len(), 1, "query {query}");
        }

        let hits = db
            .search("生成器".to_owned(), SearchFilters::default(), 20)
            .expect("trigram search");
        assert_eq!(hits.len(), 1);

        let text = db
            .search(
                "图像".to_owned(),
                SearchFilters {
                    kind: Some("text".to_owned()),
                },
                20,
            )
            .expect("filtered search");
        assert_eq!(text.len(), 1);
        assert!(
            db.search(
                "图像".to_owned(),
                SearchFilters {
                    kind: Some("image".to_owned()),
                },
                20,
            )
            .expect("filter miss")
            .is_empty()
        );
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
        let dir =
            std::env::temp_dir().join(format!("flow native {} {}", std::process::id(), now_ms()));
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
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn schema_cascades_edges_and_assets_with_their_nodes() {
        let db = Database::open(":memory:").expect("open");
        let schema = db
            .run(|conn| {
                let statement = sea_orm::Statement::from_string(
                    sea_orm::DbBackend::Sqlite,
                    "SELECT name, sql FROM sqlite_master \
                     WHERE name IN ('edges', 'node_assets')"
                        .to_owned(),
                );
                let rows = conn
                    .query_all_raw(statement)
                    .map_err(|error| error.to_string())?;
                Ok(rows
                    .iter()
                    .map(|row| {
                        (
                            row.try_get::<String>("", "name").unwrap_or_default(),
                            row.try_get::<String>("", "sql").unwrap_or_default(),
                        )
                    })
                    .collect::<Vec<_>>())
            })
            .expect("schema");

        for (name, sql) in schema {
            assert!(
                sql.contains("ON DELETE CASCADE"),
                "{name} must cascade when its node is deleted"
            );
        }
    }

    #[test]
    fn deleting_a_node_cascades_edges_and_node_assets() {
        use crate::entity::{assets, edges, node_assets};
        use sea_orm::{ActiveValue::Set, PaginatorTrait};

        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 300.0, 0.0),
        ])
        .expect("insert nodes");

        db.run(|conn| {
            assets::Entity::insert(assets::ActiveModel {
                id: Set("asset".to_owned()),
                hash: Set("hash".to_owned()),
                kind: Set("image".to_owned()),
                name: Set("asset.png".to_owned()),
                mime: Set("image/png".to_owned()),
                size: Set(1),
                meta_json: Set("{}".to_owned()),
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;

            edges::Entity::insert(edges::ActiveModel {
                id: Set("edge".to_owned()),
                document_id: Set(DOCUMENT_ID.to_owned()),
                from_id: Set("a".to_owned()),
                to_id: Set("b".to_owned()),
                from_port: Set(None),
                to_port: Set(None),
                kind: Set("link".to_owned()),
                data_json: Set("{}".to_owned()),
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;

            node_assets::Entity::insert(node_assets::ActiveModel {
                node_id: Set("a".to_owned()),
                asset_id: Set("asset".to_owned()),
                role: Set("preview".to_owned()),
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;

            Ok(())
        })
        .expect("insert relations");

        db.delete_nodes(vec!["a".to_owned()]).expect("delete node");

        let counts = db
            .run(|conn| {
                let edges = edges::Entity::find()
                    .count(conn)
                    .map_err(|error| error.to_string())?;
                let node_assets = node_assets::Entity::find()
                    .count(conn)
                    .map_err(|error| error.to_string())?;
                Ok((edges, node_assets))
            })
            .expect("count relations");

        assert_eq!(counts, (0, 0));
    }

    fn benchmark_nodes(chunk: usize) -> Vec<NodeInput> {
        (0..1000)
            .map(|offset| {
                let i = chunk * 1000 + offset;
                node(
                    &format!("n{i}"),
                    &format!("Node {i} image generator"),
                    if i.is_multiple_of(2) {
                        "A panel that turns text into an image."
                    } else {
                        "一个把文本变成图片的生成器。"
                    },
                    &["generated", "flow"],
                    (i % 100) as f64 * 220.0,
                    (i / 100) as f64 * 140.0,
                )
            })
            .collect()
    }

    #[test]
    #[ignore = "writes the 100k UI fixture; set FLOW_BENCH_DB=<path>"]
    fn seed_benchmark_database() {
        let path = std::env::var("FLOW_BENCH_DB").expect("FLOW_BENCH_DB");
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).expect("create parent directory");
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }

        let db = Database::open(&path).expect("open");
        for chunk in 0..100 {
            db.insert_nodes(benchmark_nodes(chunk))
                .expect("insert chunk");
        }
        assert_eq!(db.count().expect("count"), 100_000);
        println!("seeded 100000 nodes in {path}");
    }

    #[test]
    #[ignore = "100k benchmark; run with --release -- --ignored --nocapture"]
    fn hundred_thousand_nodes_benchmark() {
        let db = Database::open(":memory:").expect("open");
        let started = std::time::Instant::now();
        for chunk in 0..100 {
            db.insert_nodes(benchmark_nodes(chunk))
                .expect("insert chunk");
        }
        let build = started.elapsed();
        assert_eq!(db.count().expect("count"), 100_000);

        let started = std::time::Instant::now();
        let hits = db
            .search("generator".to_owned(), SearchFilters::default(), 20)
            .expect("search");
        let search = started.elapsed();
        assert!(!hits.is_empty());

        let started = std::time::Instant::now();
        let viewport = db
            .viewport(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                120.0,
            )
            .expect("viewport");
        let viewport_time = started.elapsed();
        assert!(!viewport.is_empty());

        let started = std::time::Instant::now();
        let scene = db
            .scene(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                120.0,
            )
            .expect("scene");
        let scene_time = started.elapsed();
        assert!(!scene.nodes.is_empty());

        let started = std::time::Instant::now();
        let bounds = db.bounds().expect("bounds");
        let bounds_time = started.elapsed();
        assert!(bounds.width > 0.0 && bounds.height > 0.0);

        let mut viewport_times = Vec::new();
        for _ in 0..20 {
            let started = std::time::Instant::now();
            let _ = db
                .viewport(
                    Viewport {
                        x: 0.0,
                        y: 0.0,
                        width: 1920.0,
                        height: 1080.0,
                    },
                    120.0,
                )
                .expect("viewport repeated");
            viewport_times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        viewport_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let viewport_avg = viewport_times.iter().sum::<f64>() / viewport_times.len() as f64;
        let viewport_p95 = viewport_times[(viewport_times.len() * 95) / 100];

        let mut search_times = Vec::new();
        for _ in 0..20 {
            let started = std::time::Instant::now();
            let _ = db
                .search("generator".to_owned(), SearchFilters::default(), 20)
                .expect("search repeated");
            search_times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        search_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let search_avg = search_times.iter().sum::<f64>() / search_times.len() as f64;
        let search_p95 = search_times[(search_times.len() * 95) / 100];

        let started = std::time::Instant::now();
        let selective = db
            .search("Node 99999".to_owned(), SearchFilters::default(), 20)
            .expect("selective search");
        let selective_time = started.elapsed();

        let started = std::time::Instant::now();
        let cjk_short = db
            .search("图片".to_owned(), SearchFilters::default(), 20)
            .expect("short CJK search");
        let cjk_short_time = started.elapsed();
        assert!(!cjk_short.is_empty());

        let started = std::time::Instant::now();
        let cjk_trigram = db
            .search("生成器".to_owned(), SearchFilters::default(), 20)
            .expect("CJK trigram search");
        let cjk_trigram_time = started.elapsed();
        assert!(!cjk_trigram.is_empty());

        println!(
            "100k build={build:?} search={search:?} viewport={viewport_time:?} scene={scene_time:?} bounds={bounds_time:?} hits={} visible={}",
            hits.len(),
            viewport.len()
        );
        println!(
            "viewport avg={viewport_avg:.2}ms p95={viewport_p95:.2}ms; search avg={search_avg:.2}ms p95={search_p95:.2}ms; selective={selective_time:?} hits={}",
            selective.len()
        );
        println!(
            "cjk short={cjk_short_time:?} hits={} trigram={cjk_trigram_time:?} hits={}",
            cjk_short.len(),
            cjk_trigram.len()
        );
    }
}
