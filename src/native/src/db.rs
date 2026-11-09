use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter,
};

use crate::asset;
use crate::clock::now_ms;
use crate::constants::DOCUMENT_ID;
use crate::detail;
use crate::document;
use crate::entity::{documents, edges, nodes};
#[cfg(test)]
use crate::history::HistoryOp;
use crate::history::{History, HistoryEntry};
use crate::mutation::{self, Mutation};
use crate::scene;
use crate::schema;
use crate::search;
use crate::types::{
    AssetInput, AssetSummary, ChangeSet, EdgeInput, InputItemInput, InputItemSummary, NodeBounds,
    NodeDetail, NodeInput, NodePreview, NodeSummary, ResultBatchInput, ResultItemInput,
    SceneSnapshot, SearchFilters, SearchHit, Viewport,
};
use crate::viewport;

type Job = Box<dyn FnOnce(&DatabaseConnection) + Send + 'static>;

/// A handle to the database worker.
///
/// SeaORM's sync Rusqlite connection is deliberately not `Send` (it holds a
/// non-`Send` metric callback), so the connection lives on one worker thread.
/// This handle only carries jobs to it; it is cheap to clone and can move to
/// NSH's blocking pool.
///
/// The undo history lives here too. It is mutated inside the same serialized
/// jobs as the database writes, so an undo can never pop an entry before an
/// earlier command has pushed its own.
#[derive(Clone)]
pub struct Database {
    tx: Arc<Mutex<Sender<Job>>>,
    history: Arc<Mutex<History>>,
    assets_dir: Arc<PathBuf>,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let path = path.to_owned();
        let assets_dir = Arc::new(asset::assets_dir_for(&path));

        std::thread::Builder::new()
            .name("flow-db".to_owned())
            .spawn(move || worker(&path, ready_tx, job_rx))
            .map_err(|error| error.to_string())?;

        ready_rx
            .recv()
            .map_err(|_| "the database worker stopped during startup".to_owned())??;

        Ok(Self {
            tx: Arc::new(Mutex::new(job_tx)),
            history: Arc::new(Mutex::new(History::default())),
            assets_dir,
        })
    }

    pub fn insert_nodes(&self, nodes: Vec<NodeInput>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::insert_nodes(conn, nodes))
    }

    pub fn move_nodes(&self, ids: Vec<String>, dx: f64, dy: f64) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::move_nodes(conn, ids, dx, dy))
    }

    pub fn set_node_text(
        &self,
        id: String,
        title: String,
        body: String,
        tags: Vec<String>,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::set_node_text(conn, id, title, body, tags))
    }

    pub fn set_node_settings(&self, id: String, settings_json: String) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::set_node_settings(conn, id, settings_json))
    }

    /// A text node's manual edit: a new immutable text batch, not undoable as
    /// a provider run, but this specific call is user history.
    pub fn set_manual_text(
        &self,
        id: String,
        text: String,
        batch: ResultBatchInput,
        item: ResultItemInput,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::set_manual_text(conn, id, text, batch, item))
    }

    /// Inserts an edge and snapshots the source's current output into the
    /// target's input list.
    pub fn connect_edge(&self, edge: EdgeInput) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::connect_edge(conn, edge))
    }

    pub fn update_edge(&self, edge: EdgeInput) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::update_edge(conn, edge))
    }

    pub fn add_input(&self, input: InputItemInput) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::add_input(conn, input))
    }

    pub fn remove_input(&self, id: String) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::remove_input(conn, id))
    }

    pub fn reorder_inputs(&self, node_id: String, ids: Vec<String>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::reorder_inputs(conn, node_id, ids))
    }

    /// Rebuilds edge inputs from the sources' current batches, before a run.
    pub fn sync_inputs(&self, node_id: String) -> Result<Vec<InputItemSummary>, String> {
        self.run(move |conn| {
            mutation::sync_inputs(conn, node_id.clone())?;
            detail::inputs(conn, &node_id)
        })
    }

    /// Persists a completed, failed or cancelled provider run. Not undoable.
    pub fn save_run(
        &self,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
    ) -> Result<ChangeSet, String> {
        self.run(move |conn| mutation::save_run(conn, batch, items))
    }

    pub fn set_node_status(&self, id: String, status: String) -> Result<ChangeSet, String> {
        self.run(move |conn| mutation::set_node_status(conn, id, status))
    }

    /// Marks runs left running by a previous process as interrupted.
    pub fn recover_runs(&self) -> Result<u32, String> {
        self.run(mutation::recover_runs)
    }

    /// A node with its output batch and input list.
    pub fn node_detail(&self, id: String) -> Result<Option<NodeDetail>, String> {
        self.run(move |conn| detail::node_detail(conn, &id))
    }

    /// The first items of several nodes' current batches, for card previews.
    pub fn previews(&self, ids: Vec<String>) -> Result<Vec<NodePreview>, String> {
        self.run(move |conn| detail::previews(conn, ids))
    }

    pub fn import_asset(&self, input: AssetInput) -> Result<AssetSummary, String> {
        let assets_dir = Arc::clone(&self.assets_dir);
        self.run(move |conn| asset::import_asset(conn, &assets_dir, input))
    }

    pub fn asset_bytes(&self, id: String) -> Result<Vec<u8>, String> {
        let assets_dir = Arc::clone(&self.assets_dir);
        self.run(move |conn| asset::asset_bytes(conn, &assets_dir, id))
    }

    pub fn delete_nodes(&self, ids: Vec<String>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::delete_nodes(conn, ids))
    }

    pub fn set_node_bounds(&self, bounds: Vec<NodeBounds>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::set_node_bounds(conn, bounds))
    }

    pub fn insert_edges(&self, edges: Vec<EdgeInput>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::insert_edges(conn, edges))
    }

    pub fn delete_edges(&self, ids: Vec<String>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::delete_edges(conn, ids))
    }

    #[cfg(test)]
    pub fn apply_ops(&self, ops: &[HistoryOp]) -> Result<ChangeSet, String> {
        let ops = ops.to_vec();
        self.run(move |conn| mutation::apply_ops(conn, &ops))
    }

    /// Reverts the last command. The history entry is taken and returned in
    /// the same worker job as the database writes.
    pub fn undo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let mut history = lock_history(&history)?;
            let Some(entry) = history.take_undo() else {
                return empty_change(conn);
            };
            let mut ops = entry.inverse.clone();
            ops.reverse();
            match mutation::apply_ops(conn, &ops) {
                Ok(changes) => {
                    history.push_redo(entry);
                    Ok(changes)
                }
                Err(error) => {
                    history.restore_undo(entry);
                    Err(error)
                }
            }
        })
    }

    /// Reapplies the last undone command, on the same worker job.
    pub fn redo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let mut history = lock_history(&history)?;
            let Some(entry) = history.take_redo() else {
                return empty_change(conn);
            };
            let ops = entry.forward.clone();
            match mutation::apply_ops(conn, &ops) {
                Ok(changes) => {
                    history.push_undo_after_redo(entry);
                    Ok(changes)
                }
                Err(error) => {
                    history.push_redo(entry);
                    Err(error)
                }
            }
        })
    }

    /// Drops the undo and redo stacks; used after seeding demo data.
    pub fn clear_history(&self) -> Result<(), String> {
        lock_history(&self.history)?.clear();
        Ok(())
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

    /// Runs a document mutation and records its inverse in the same worker
    /// job, so command order and history order can never diverge.
    fn run_mutation<F>(&self, work: F) -> Result<Mutation, String>
    where
        F: FnOnce(&DatabaseConnection) -> Result<Mutation, String> + Send + 'static,
    {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let mutation = work(conn)?;
            lock_history(&history)?.push(HistoryEntry {
                forward: mutation.forward.clone(),
                inverse: mutation.inverse.clone(),
            });
            Ok(mutation)
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

    let url = sqlite_url(path)?;
    let conn = sea_orm::Database::connect(url.as_str()).map_err(|error| error.to_string())?;
    configure(&conn, path)?;
    schema::migrate(&conn)?;
    ensure_document(&conn)?;

    Ok(conn)
}

fn empty_change(conn: &DatabaseConnection) -> Result<ChangeSet, String> {
    Ok(ChangeSet {
        rev: document::current_rev(conn).map_err(|error| error.to_string())? as f64,
        changed: Vec::new(),
        removed: Vec::new(),
        edges_changed: Vec::new(),
        edges_removed: Vec::new(),
    })
}

fn lock_history(
    history: &Arc<Mutex<History>>,
) -> Result<std::sync::MutexGuard<'_, History>, String> {
    history
        .lock()
        .map_err(|_| "the undo history lock is poisoned".to_owned())
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

fn sqlite_url(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }

    // SQLite resolves `file:` URIs as absolute paths. Make relative overrides
    // (`FLOW_DB_PATH=./flow.db`) absolute first so they open next to the
    // caller rather than at the filesystem root, and so a colon in a file
    // name cannot be read as a URL authority and port.
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let normalized = absolute.to_string_lossy().replace('\\', "/");
    let encoded = encode_uri_path(&normalized);
    if encoded.starts_with('/') {
        Ok(format!("sqlite:file:{encoded}"))
    } else {
        Ok(format!("sqlite:file:///{encoded}"))
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
            settings_json: None,
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
    fn empty_document_bounds_are_zero() {
        let db = Database::open(":memory:").expect("open");
        let bounds = db.bounds().expect("bounds");
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (0.0, 0.0, 0.0, 0.0)
        );
    }

    #[test]
    fn short_terms_all_match_in_a_mixed_query() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node(
                "a",
                "Generator",
                "AI image generation",
                &["image"],
                0.0,
                0.0,
            ),
            node("b", "图像生成器", "把文本变成图片", &["设计"], 300.0, 0.0),
        ])
        .expect("insert");

        let english = db
            .search("AI image".to_owned(), SearchFilters::default(), 20)
            .expect("mixed short query");
        assert_eq!(english.len(), 1);
        assert_eq!(english[0].id, "a");

        let chinese = db
            .search("图像 生成".to_owned(), SearchFilters::default(), 20)
            .expect("mixed CJK query");
        assert_eq!(chinese.len(), 1);
        assert_eq!(chinese[0].id, "b");

        assert!(
            db.search("AI missing".to_owned(), SearchFilters::default(), 20)
                .expect("all terms required")
                .is_empty()
        );
        assert!(
            db.search("image".to_owned(), SearchFilters::default(), 0)
                .expect("zero limit")
                .is_empty()
        );
    }

    #[test]
    fn undo_restores_a_deleted_node_its_edges_and_indexes() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "Generator", "Makes an image", &["image"], 0.0, 0.0),
            node("b", "Text panel", "A text node", &["text"], 300.0, 0.0),
        ])
        .expect("insert nodes");
        db.insert_edges(vec![EdgeInput {
            id: "a-b".to_owned(),
            from_id: "a".to_owned(),
            to_id: "b".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        }])
        .expect("insert edge");
        assert_eq!(db.edge_count().expect("edge count"), 1);

        let deleted = db.delete_nodes(vec!["a".to_owned()]).expect("delete");
        assert_eq!(deleted.changes.edges_removed, vec!["a-b"]);
        assert_eq!(db.edge_count().expect("edge count after delete"), 0);
        assert!(
            db.search("Generator".to_owned(), SearchFilters::default(), 20)
                .expect("search after delete")
                .is_empty()
        );

        let undone = db.undo().expect("undo delete");
        assert!(undone.changed.iter().any(|node| node.id == "a"));
        assert_eq!(db.count().expect("count after undo"), 2);
        assert_eq!(db.edge_count().expect("edge count after undo"), 1);
        assert_eq!(
            db.search("Generator".to_owned(), SearchFilters::default(), 20)
                .expect("search after undo")
                .len(),
            1
        );

        let redone = db.redo().expect("redo delete");
        assert_eq!(redone.removed, vec!["a"]);
        assert_eq!(db.count().expect("count after redo"), 1);
        assert_eq!(db.edge_count().expect("edge count after redo"), 0);
    }

    #[test]
    fn rejects_self_and_duplicate_connections() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "Source", "", &["text"], 0.0, 0.0),
            node("b", "Target", "", &["image"], 300.0, 0.0),
        ])
        .expect("insert nodes");
        let edge = |id: &str, from: &str, to: &str| EdgeInput {
            id: id.to_owned(),
            from_id: from.to_owned(),
            to_id: to.to_owned(),
            from_port: Some("out".to_owned()),
            to_port: Some("in".to_owned()),
            kind: "flow".to_owned(),
            data_json: None,
        };

        db.connect_edge(edge("a-b", "a", "b")).expect("connect");
        let duplicate = match db.connect_edge(edge("a-b-again", "a", "b")) {
            Ok(_) => panic!("a duplicate edge was accepted"),
            Err(error) => error,
        };
        assert!(duplicate.contains("already connected"), "{duplicate}");
        let own = match db.connect_edge(edge("a-a", "a", "a")) {
            Ok(_) => panic!("a self edge was accepted"),
            Err(error) => error,
        };
        assert!(own.contains("cannot connect to itself"), "{own}");
        assert_eq!(db.edge_count().expect("edge count"), 1);
    }

    #[test]
    fn updates_searchable_text_and_undoes_the_index_change() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("a", "Old title", "Old body", &["old"], 0.0, 0.0)])
            .expect("insert");

        let changed = db
            .set_node_text(
                "a".to_owned(),
                "New title".to_owned(),
                "New body".to_owned(),
                vec!["new".to_owned()],
            )
            .expect("set text");
        assert_eq!(changed.changes.changed[0].title, "New title");
        assert_eq!(
            db.search("New title".to_owned(), SearchFilters::default(), 20)
                .expect("new search")
                .len(),
            1
        );
        assert!(
            db.search("Old title".to_owned(), SearchFilters::default(), 20)
                .expect("old search")
                .is_empty()
        );

        db.undo().expect("undo text");
        assert_eq!(
            db.search("Old title".to_owned(), SearchFilters::default(), 20)
                .expect("restored search")
                .len(),
            1
        );
        db.redo().expect("redo text");
        assert!(
            db.search("Old title".to_owned(), SearchFilters::default(), 20)
                .expect("removed again")
                .is_empty()
        );
    }

    #[test]
    fn sqlite_url_makes_a_relative_path_absolute() {
        let url = sqlite_url("my data/notes:2024.db").expect("url");
        assert!(url.starts_with("sqlite:file:"));
        assert!(url.contains("my%20data/notes:2024.db"));
        assert!(!url.contains("sqlite://my"));
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
                created_at: Set(0),
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

    #[test]
    fn snapshots_edges_into_ordered_inputs_and_undoes_their_removal() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("text", "Text", "A lake", &[], 0.0, 0.0),
            node("image", "Image", "", &[], 400.0, 0.0),
        ])
        .expect("insert nodes");

        db.save_run(
            ResultBatchInput {
                id: "batch-text".to_owned(),
                node_id: "text".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![
                ResultItemInput {
                    id: "item-a".to_owned(),
                    position: 0.0,
                    kind: "text".to_owned(),
                    text: "A lake".to_owned(),
                    asset_id: None,
                    meta_json: None,
                },
                ResultItemInput {
                    id: "item-b".to_owned(),
                    position: 1.0,
                    kind: "text".to_owned(),
                    text: "At dawn".to_owned(),
                    asset_id: None,
                    meta_json: None,
                },
            ],
        )
        .expect("save source batch");

        db.connect_edge(EdgeInput {
            id: "edge-text-image".to_owned(),
            from_id: "text".to_owned(),
            to_id: "image".to_owned(),
            from_port: Some("out".to_owned()),
            to_port: Some("in".to_owned()),
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        let detail = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(detail.inputs.len(), 2);
        assert_eq!(detail.inputs[0].item_id.as_deref(), Some("item-a"));
        assert_eq!(detail.inputs[1].item_id.as_deref(), Some("item-b"));
        assert_eq!(detail.inputs[0].origin, "edge");

        let removed = db
            .remove_input(detail.inputs[0].id.clone())
            .expect("remove first input");
        assert_eq!(removed.changes.changed.len(), 1);
        assert_eq!(removed.changes.changed[0].id, "image");
        assert_eq!(removed.changes.changed[0].status, "idle");
        let after = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(after.inputs.len(), 1);
        assert_eq!(after.inputs[0].item_id.as_deref(), Some("item-b"));

        // A run's input sync clears removals and recreates the snapshots;
        // undoing the earlier removal must still succeed idempotently.
        db.sync_inputs("image".to_owned()).expect("sync after run");
        let undone = db.undo().expect("undo input removal");
        assert!(undone.changed.iter().any(|node| node.id == "image"));
        let restored = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(restored.inputs.len(), 2);
    }

    #[test]
    fn sync_rebuilds_edge_inputs_and_keeps_local_items() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("text", "Text", "A lake", &[], 0.0, 0.0),
            node("image", "Image", "", &[], 400.0, 0.0),
        ])
        .expect("insert nodes");
        db.save_run(
            ResultBatchInput {
                id: "batch-old".to_owned(),
                node_id: "text".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-old".to_owned(),
                position: 0.0,
                kind: "text".to_owned(),
                text: "Old".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("old batch");
        db.connect_edge(EdgeInput {
            id: "edge".to_owned(),
            from_id: "text".to_owned(),
            to_id: "image".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");
        db.add_input(InputItemInput {
            id: "local".to_owned(),
            node_id: "image".to_owned(),
            position: 99.0,
            kind: "text".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: None,
            text: "Local".to_owned(),
            meta_json: None,
        })
        .expect("local input");

        db.save_run(
            ResultBatchInput {
                id: "batch-new".to_owned(),
                node_id: "text".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-new".to_owned(),
                position: 0.0,
                kind: "text".to_owned(),
                text: "New".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("new batch");

        let inputs = db.sync_inputs("image".to_owned()).expect("sync");
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].text, "Local");
        assert_eq!(inputs[1].item_id.as_deref(), Some("item-new"));
    }

    #[test]
    fn deleting_a_source_removes_downstream_inputs_and_undo_restores_them() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("text", "Text", "A lake", &[], 0.0, 0.0),
            node("image", "Image", "", &[], 400.0, 0.0),
        ])
        .expect("insert nodes");
        db.save_run(
            ResultBatchInput {
                id: "batch".to_owned(),
                node_id: "text".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item".to_owned(),
                position: 0.0,
                kind: "text".to_owned(),
                text: "A lake".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("batch");
        db.connect_edge(EdgeInput {
            id: "edge".to_owned(),
            from_id: "text".to_owned(),
            to_id: "image".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        db.delete_nodes(vec!["text".to_owned()])
            .expect("delete source");
        let after = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(after.inputs.len(), 0);
        assert_eq!(db.edge_count().expect("edges"), 0);

        db.undo().expect("undo delete");
        let restored = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(restored.inputs.len(), 1);
        assert_eq!(db.edge_count().expect("edges after undo"), 1);

        db.redo().expect("redo delete");
        let after_redo = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(after_redo.inputs.len(), 0);
        assert_eq!(db.edge_count().expect("edges after redo"), 0);
    }

    #[test]
    fn a_manual_text_edit_is_one_undoable_batch() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("text", "Text", "Before", &[], 0.0, 0.0)])
            .expect("insert");
        let changes = db
            .set_manual_text(
                "text".to_owned(),
                "After".to_owned(),
                ResultBatchInput {
                    id: "batch-manual".to_owned(),
                    node_id: "text".to_owned(),
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
                    kind: "text".to_owned(),
                    text: "After".to_owned(),
                    asset_id: None,
                    meta_json: None,
                },
            )
            .expect("manual edit");
        assert_eq!(changes.changes.changed[0].body, "After");
        let detail = db
            .node_detail("text".to_owned())
            .expect("detail")
            .expect("text detail");
        assert_eq!(
            detail.batch.as_ref().map(|batch| batch.id.as_str()),
            Some("batch-manual")
        );
        assert_eq!(
            detail.batch.as_ref().map(|batch| batch.items.len()),
            Some(1)
        );

        db.undo().expect("undo manual edit");
        let restored = db
            .node_detail("text".to_owned())
            .expect("detail")
            .expect("text detail");
        assert_eq!(restored.node.body, "Before");
        assert_eq!(restored.node.output_batch_id, None);
        // The batch itself is immutable and stays for any downstream snapshot.
        assert_eq!(
            db.node_detail("text".to_owned())
                .expect("detail")
                .expect("detail")
                .batch
                .map(|batch| batch.id),
            None
        );
    }

    #[test]
    fn bodies_written_by_manual_edits_and_runs_are_searchable() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("text", "Panel", "Before", &[], 0.0, 0.0)])
            .expect("insert");

        db.set_manual_text(
            "text".to_owned(),
            "Orchid petals".to_owned(),
            ResultBatchInput {
                id: "batch-manual".to_owned(),
                node_id: "text".to_owned(),
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
                kind: "text".to_owned(),
                text: "Orchid petals".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        )
        .expect("manual edit");
        assert_eq!(
            db.search("Orchid".to_owned(), SearchFilters::default(), 20)
                .expect("manual search")
                .len(),
            1
        );
        assert!(
            db.search("Before".to_owned(), SearchFilters::default(), 20)
                .expect("old body search")
                .is_empty()
        );

        db.save_run(
            ResultBatchInput {
                id: "batch-run".to_owned(),
                node_id: "text".to_owned(),
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
                kind: "text".to_owned(),
                text: "Marigold fields".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run");
        assert_eq!(
            db.search("Marigold".to_owned(), SearchFilters::default(), 20)
                .expect("run search")
                .len(),
            1
        );
        assert!(
            db.search("Orchid".to_owned(), SearchFilters::default(), 20)
                .expect("replaced body search")
                .is_empty()
        );
    }

    #[test]
    fn undoing_a_settings_edit_keeps_a_later_run_output() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("a", "A", "Original", &[], 0.0, 0.0)])
            .expect("insert");
        db.set_node_settings("a".to_owned(), "{\"prompt\":\"one\"}".to_owned())
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
                kind: "text".to_owned(),
                text: "Run output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run");

        db.undo().expect("undo settings");
        let detail = db
            .node_detail("a".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.settings_json, "{}");
        assert_eq!(detail.node.body, "Run output");
        assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch"));
        // The settings no longer match the output, so it cannot be "done".
        assert_eq!(detail.node.status, "stale");

        db.redo().expect("redo settings");
        let redone = db
            .node_detail("a".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(redone.node.settings_json, "{\"prompt\":\"one\"}");
        assert_eq!(redone.node.body, "Run output");
        assert_eq!(redone.node.output_batch_id.as_deref(), Some("batch"));
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
            from_port: None,
            to_port: None,
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
    fn reordering_inputs_is_undoable() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, text) in [("one", "One"), ("two", "Two")] {
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                position: 0.0,
                kind: "text".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: None,
                text: text.to_owned(),
                meta_json: None,
            })
            .expect("add input");
        }
        let before = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node")
            .inputs;
        assert!(before.iter().any(|input| input.id == "one"));
        db.reorder_inputs("n".to_owned(), vec!["two".to_owned(), "one".to_owned()])
            .expect("reorder");
        let after = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node")
            .inputs;
        assert_eq!(after[0].id, "two");
        assert_eq!(after[1].id, "one");

        db.undo().expect("undo reorder");
        let restored = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node")
            .inputs;
        let restored_ids: Vec<&str> = restored.iter().map(|input| input.id.as_str()).collect();
        let before_ids: Vec<&str> = before.iter().map(|input| input.id.as_str()).collect();
        assert_eq!(restored_ids, before_ids);
    }

    #[test]
    fn reconnecting_an_edge_moves_its_input_snapshot_and_undoes_it() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("source", "Source", "A lake", &[], 0.0, 0.0),
            node("old", "Old target", "", &[], 400.0, 0.0),
            node("new", "New target", "", &[], 800.0, 0.0),
        ])
        .expect("insert nodes");
        db.save_run(
            ResultBatchInput {
                id: "batch".to_owned(),
                node_id: "source".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item".to_owned(),
                position: 0.0,
                kind: "text".to_owned(),
                text: "A lake".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("batch");
        db.connect_edge(EdgeInput {
            id: "edge".to_owned(),
            from_id: "source".to_owned(),
            to_id: "old".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        db.update_edge(EdgeInput {
            id: "edge".to_owned(),
            from_id: "source".to_owned(),
            to_id: "new".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("reconnect");

        let old = db
            .node_detail("old".to_owned())
            .expect("detail")
            .expect("old detail");
        let new = db
            .node_detail("new".to_owned())
            .expect("detail")
            .expect("new detail");
        assert_eq!(old.inputs.len(), 0);
        assert_eq!(new.inputs.len(), 1);
        assert_eq!(new.inputs[0].edge_id.as_deref(), Some("edge"));

        db.undo().expect("undo reconnect");
        let old = db
            .node_detail("old".to_owned())
            .expect("detail")
            .expect("old detail");
        let new = db
            .node_detail("new".to_owned())
            .expect("detail")
            .expect("new detail");
        assert_eq!(old.inputs.len(), 1);
        assert_eq!(new.inputs.len(), 0);

        db.redo().expect("redo reconnect");
        let old = db
            .node_detail("old".to_owned())
            .expect("detail")
            .expect("old detail");
        let new = db
            .node_detail("new".to_owned())
            .expect("detail")
            .expect("new detail");
        assert_eq!(old.inputs.len(), 0);
        assert_eq!(new.inputs.len(), 1);
        assert_eq!(new.inputs[0].edge_id.as_deref(), Some("edge"));
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
        let Ok(path) = std::env::var("FLOW_BENCH_DB") else {
            println!("FLOW_BENCH_DB is not set; skipping the 100k fixture");
            return;
        };
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
