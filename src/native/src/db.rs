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

    /// Connects several edges in one transaction and one history step.
    pub fn connect_edges(&self, edges: Vec<EdgeInput>) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::connect_edges(conn, edges))
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
        self.run(move |conn| viewport::viewport(conn, rect, margin, viewport::NODE_LIMIT))
    }

    pub fn scene(
        &self,
        rect: Viewport,
        margin: f64,
        max_cards: u64,
    ) -> Result<SceneSnapshot, String> {
        self.run(move |conn| scene::snapshot(conn, rect, margin, max_cards))
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
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::types::EdgePoint;

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
    fn connects_several_sources_in_one_history_step() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 0.0, 200.0),
            node("c", "C", "", &[], 400.0, 100.0),
        ])
        .expect("insert nodes");

        // One output item per source exercises the snapshot path for each.
        for (source, item) in [("a", "item-a"), ("b", "item-b")] {
            db.save_run(
                ResultBatchInput {
                    id: format!("batch-{source}"),
                    node_id: source.to_owned(),
                    trigger: "manual".to_owned(),
                    provider: "manual".to_owned(),
                    model: String::new(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                vec![ResultItemInput {
                    id: item.to_owned(),
                    position: 0.0,
                    kind: "text".to_owned(),
                    text: item.to_owned(),
                    asset_id: None,
                    meta_json: None,
                }],
            )
            .expect("save run");
        }

        let edge = |id: &str, from: &str| EdgeInput {
            id: id.to_owned(),
            from_id: from.to_owned(),
            to_id: "c".to_owned(),
            from_port: Some("out".to_owned()),
            to_port: Some("in".to_owned()),
            kind: "flow".to_owned(),
            data_json: None,
        };
        let mutation = db
            .connect_edges(vec![edge("a-c", "a"), edge("b-c", "b")])
            .expect("connect many");
        assert_eq!(mutation.changes.edges_changed.len(), 2);
        // Both edges touch one target: its summary appears once.
        assert_eq!(mutation.changes.changed.len(), 1);
        assert_eq!(db.edge_count().expect("edges"), 2);
        assert_eq!(
            db.node_detail("c".to_owned())
                .expect("detail")
                .expect("c detail")
                .inputs
                .len(),
            2
        );

        // One undo removes both edges and their snapshotted inputs.
        let undone = db.undo().expect("undo");
        assert_eq!(undone.edges_removed.len(), 2);
        assert_eq!(db.edge_count().expect("edges after undo"), 0);
        assert_eq!(
            db.node_detail("c".to_owned())
                .expect("detail")
                .expect("c detail")
                .inputs
                .len(),
            0
        );

        // One redo restores both edges.
        let redone = db.redo().expect("redo");
        assert_eq!(redone.edges_changed.len(), 2);
        assert_eq!(db.edge_count().expect("edges after redo"), 2);
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
    fn two_phase_scene_matches_the_single_statement_reference() {
        let db = Database::open(":memory:").expect("open");
        let dense: Vec<NodeInput> = (0..12)
            .map(|i| {
                let mut input = node(
                    &format!("dense-{i:02}"),
                    &format!("Dense {i}"),
                    "",
                    &[],
                    (i % 4) as f64 * 210.0,
                    (i / 4) as f64 * 130.0,
                );
                input.z = (i % 3) as f64;
                input
            })
            .collect();
        db.insert_nodes(dense).expect("insert dense nodes");

        let rect = Viewport {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let snapshot = db.scene(rect.clone(), 0.0, 5).expect("two-phase scene");
        // Run the legacy single statement on the same worker/connection so
        // the RTree and every ordering input are identical.
        let reference = db
            .run(move |conn| {
                let statement = viewport::viewport_statement_reference(rect, 0.0, 5);
                viewport::rows_from_statement(conn, &statement)
            })
            .expect("legacy reference read");

        assert_eq!(snapshot.nodes.len(), 5);
        assert_eq!(reference.len(), 5);
        let scene_rows: Vec<(&str, f64, f64)> = snapshot
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.z, node.rev))
            .collect();
        let reference_rows: Vec<(&str, f64, f64)> = reference
            .iter()
            .map(|node| (node.id.as_str(), node.z, node.rev))
            .collect();
        let scene_ids: Vec<&str> = scene_rows.iter().map(|row| row.0).collect();
        let reference_ids: Vec<&str> = reference_rows.iter().map(|row| row.0).collect();
        assert_eq!(
            scene_rows, reference_rows,
            "two-phase order {scene_ids:?} differs from the single statement {reference_ids:?}"
        );
    }

    #[test]
    fn a_scene_reads_the_far_port_of_an_edge_to_an_off_screen_card() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "Near", "", &[], 0.0, 0.0),
            node("far", "Far", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        db.connect_edge(EdgeInput {
            id: "a-far".to_owned(),
            from_id: "a".to_owned(),
            to_id: "far".to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        let scene = db
            .scene(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 400.0,
                    height: 300.0,
                },
                0.0,
                viewport::NODE_LIMIT,
            )
            .expect("scene");

        // The far card is outside the read; its port still travels with the
        // edge so the near card's connector can be drawn to it.
        assert_eq!(scene.nodes.len(), 1);
        assert_eq!(scene.nodes[0].id, "a");
        assert_eq!(scene.edges.len(), 1);
        let edge = &scene.edges[0];
        assert_eq!(edge.from_point, Some(EdgePoint { x: 200.0, y: 42.0 }));
        assert_eq!(
            edge.to_point,
            Some(EdgePoint {
                x: 5_000.0,
                y: 42.0
            })
        );
    }

    fn connect(db: &Database, id: &str, from: &str, to: &str) {
        db.connect_edge(EdgeInput {
            id: id.to_owned(),
            from_id: from.to_owned(),
            to_id: to.to_owned(),
            from_port: None,
            to_port: None,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");
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
    fn a_scene_reads_a_connector_between_two_off_screen_cards() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        // Both cards are far outside the read; the connector's curve crosses
        // it, so the edge RTree reports it with both endpoint ports.
        let scene = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
        assert!(scene.nodes.is_empty());
        assert_eq!(scene.edges.len(), 1);
        let edge = &scene.edges[0];
        assert_eq!(edge.id, "left-right");
        assert_eq!(
            edge.from_point,
            Some(EdgePoint {
                x: -4_800.0,
                y: 42.0
            })
        );
        assert_eq!(
            edge.to_point,
            Some(EdgePoint {
                x: 5_000.0,
                y: 42.0
            })
        );
    }

    #[test]
    fn a_capped_scene_read_does_not_return_uncrossable_offscreen_connectors() {
        let db = Database::open(":memory:").expect("open");
        let interiors = ["interior-0", "interior-1", "interior-2"];
        let mut inputs = Vec::new();
        for (index, id) in interiors.iter().enumerate() {
            inputs.push(node(id, id, "", &[], 50.0 + index as f64 * 240.0, 50.0));
        }
        // The long connector's cards sit below every in-view card's z, so the
        // in-view-first ordering can never promote one into a one-card sample.
        let mut left = node("left", "Left", "", &[], -5_000.0, 0.0);
        left.z = -1.0;
        let mut right = node("right", "Right", "", &[], 5_000.0, 0.0);
        right.z = -1.0;
        inputs.push(left);
        inputs.push(right);
        db.insert_nodes(inputs).expect("insert");
        // Only left -> right; none of the interior cards touches the long
        // connector.
        connect(&db, "left-right", "left", "right");

        let rect = Viewport {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };

        // The uncapped read still runs the RTree half and finds the crossing.
        let full = db
            .scene(rect.clone(), 0.0, viewport::NODE_LIMIT)
            .expect("uncapped scene");
        assert_eq!(full.nodes.len(), 3);
        assert!(full.edges.iter().all(|edge| edge.id == "left-right"));
        assert!(full.edges.iter().any(|edge| edge.id == "left-right"));

        // One kept card is a capped sample; the RTree half must not add a
        // connector that touches none of the kept cards.
        let one = db.scene(rect.clone(), 0.0, 1).expect("one-card scene");
        assert_eq!(one.nodes.len(), 1);
        assert!(
            interiors.contains(&one.nodes[0].id.as_str()),
            "the kept card was {}",
            one.nodes[0].id
        );
        assert!(!one.edges.iter().any(|edge| edge.id == "left-right"));

        // Reaching the cap exactly (three interior cards, budget three) is
        // still capped; the predicate is `>=`, not `>`.
        let three = db.scene(rect, 0.0, 3).expect("three-card scene");
        assert_eq!(three.nodes.len(), 3);
        assert!(!three.edges.iter().any(|edge| edge.id == "left-right"));
    }

    #[test]
    fn moving_a_card_moves_its_connector_in_the_edge_index() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        db.move_nodes(vec!["left".to_owned()], 9_000.0, 0.0)
            .expect("move");

        // The old crossing no longer exists; the moved connector is indexed
        // between the cards' new positions.
        assert!(
            scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
                .edges
                .is_empty()
        );
        let scene = scene_between(&db, 4_250.0, 0.0, 400.0, 600.0, viewport::NODE_LIMIT);
        assert!(scene.nodes.is_empty());
        assert_eq!(scene.edges.len(), 1);
        assert_eq!(
            scene.edges[0].from_point,
            Some(EdgePoint {
                x: 4_200.0,
                y: 42.0
            })
        );
    }

    #[test]
    fn deleting_and_undoing_edges_keeps_the_edge_index_in_step() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        db.delete_edges(vec!["left-right".to_owned()])
            .expect("delete edge");
        assert!(
            scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
                .edges
                .is_empty()
        );

        let undone = db.undo().expect("undo delete");
        // The change set itself carries both ports, so the scene redraws the
        // restored connector before the next viewport read arrives.
        assert_eq!(
            undone.edges_changed[0].from_point,
            Some(EdgePoint {
                x: -4_800.0,
                y: 42.0
            })
        );
        assert_eq!(
            undone.edges_changed[0].to_point,
            Some(EdgePoint {
                x: 5_000.0,
                y: 42.0
            })
        );
        assert_eq!(
            scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
                .edges
                .len(),
            1
        );
    }

    #[test]
    fn undoing_a_node_delete_restores_the_connector_index() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        db.delete_nodes(vec!["left".to_owned()]).expect("delete");
        assert!(
            scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
                .edges
                .is_empty()
        );

        // Undo restores the node before its edges (the history inverse is
        // reversed again on apply), so the edge insert indexes the curve.
        db.undo().expect("undo delete");
        let scene = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
        assert_eq!(scene.edges.len(), 1);
        assert_eq!(
            scene.edges[0].from_point,
            Some(EdgePoint {
                x: -4_800.0,
                y: 42.0
            })
        );
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

    /// The fixture's revision. Comparisons across revisions are invalid; a
    /// later change to the grid, edges or images must pick a new label.
    const FIXTURE_VERSION: &str = "100k-grid-edges-images-v1";
    const GRID_NODES: u32 = 100_000;
    const GRID_ROWS: u32 = 1_000;
    const ROW_NODES: u32 = 100;
    const IMAGE_STRIDE: u32 = 50;
    const IMAGE_NODES: u32 = GRID_NODES / IMAGE_STRIDE;
    const IMAGE_ITEMS: usize = 4;
    const SCENE_SAMPLES: usize = 5;
    const MOVE_SAMPLES: usize = 3;
    const SEARCH_COMMON_SAMPLES: usize = 20;
    const SEARCH_SAMPLES: usize = 5;
    const RECOVERY_ITERATIONS: u32 = 2;

    /// An explicitly owned temporary directory for the timed fixture. It
    /// only ever removes the directory it created; a failed cleanup leaves
    /// the path in the output for inspection.
    struct BenchmarkTempDir {
        path: PathBuf,
    }

    impl BenchmarkTempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "flow-bench-{FIXTURE_VERSION}-{}-{}-{}",
                std::process::id(),
                now_ms(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create benchmark temp directory");
            Self { path }
        }

        fn database_path(&self) -> String {
            self.path
                .join("flow-100k.db")
                .to_string_lossy()
                .into_owned()
        }

        fn path_string(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for BenchmarkTempDir {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.path) {
                println!(
                    "100k fixture cleanup left {} for inspection: {error}",
                    self.path.display()
                );
            }
        }
    }

    /// What the seeder actually built. `include_images=false` leaves the
    /// designated image nodes as text and stores no batches: the smoke
    /// shares only the node/edge graph with the release benchmark.
    struct BenchmarkFixture {
        version: &'static str,
        nodes: u32,
        edges: u32,
        images: u32,
        batches: u32,
        items: u32,
        assets: u32,
        path: String,
    }

    fn print_fixture(fixture: &BenchmarkFixture, include_images: bool) {
        println!(
            "100k fixture version={} include_images={include_images} nodes={} edges={} image_nodes={} image_batches={} image_items={} image_assets={} db={}",
            fixture.version,
            fixture.nodes,
            fixture.edges,
            fixture.images,
            fixture.batches,
            fixture.items,
            fixture.assets,
            fixture.path
        );
        if !include_images {
            println!(
                "100k fixture note: the release benchmark uses include_images=true with {IMAGE_NODES} image nodes, {IMAGE_NODES} four-item batches and {IMAGE_NODES} assets"
            );
        }
    }

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

    fn image_node_ids() -> Vec<String> {
        (0..IMAGE_NODES)
            .map(|k| format!("n{}", k * IMAGE_STRIDE))
            .collect()
    }

    /// The row-end text nodes used as outstanding runs: neither a running nor
    /// a successful batch can mark a downstream neighbor stale. The grid has
    /// 1,000 rows and therefore 1,000 row ends (`n99`, `n199`, ...); every
    /// tenth one, starting at `n99`, gives 100 sinks spread over the whole
    /// document.
    fn sink_node_ids() -> Vec<String> {
        (0..100u32)
            .map(|k| format!("n{}", 99 + k * 1_000))
            .collect()
    }

    /// The one fixture builder. Seeding history is cleared so mutation
    /// timings start from an empty stack.
    fn seed_grid(db: &Database, include_images: bool, path: &str) -> BenchmarkFixture {
        for chunk in 0..(GRID_NODES / 1_000) as usize {
            let mut nodes = benchmark_nodes(chunk);
            if include_images {
                for (offset, node) in nodes.iter_mut().enumerate() {
                    let i = (chunk * 1_000 + offset) as u32;
                    if i.is_multiple_of(IMAGE_STRIDE) {
                        node.kind = "image".to_owned();
                    }
                }
            }
            db.insert_nodes(nodes).expect("insert benchmark nodes");
        }

        // Each row has 99 right-neighbor connectors; the last card has none.
        for chunk in 0..(GRID_NODES / 1_000) as usize {
            let mut edges = Vec::with_capacity(1_000);
            for offset in 0..1_000usize {
                let i = chunk * 1_000 + offset;
                if i % ROW_NODES as usize == (ROW_NODES - 1) as usize {
                    continue;
                }
                edges.push(EdgeInput {
                    id: format!("e{i}"),
                    from_id: format!("n{i}"),
                    to_id: format!("n{}", i + 1),
                    from_port: None,
                    to_port: None,
                    kind: "flow".to_owned(),
                    data_json: None,
                });
            }
            db.insert_edges(edges).expect("insert benchmark edges");
        }

        let mut fixture = BenchmarkFixture {
            version: FIXTURE_VERSION,
            nodes: GRID_NODES,
            edges: GRID_NODES - GRID_ROWS,
            images: 0,
            batches: 0,
            items: 0,
            assets: 0,
            path: path.to_owned(),
        };

        if include_images {
            for k in 0..IMAGE_NODES {
                let image_index = k * IMAGE_STRIDE;
                let asset_id = format!("bench-asset-{image_index}");
                db.import_asset(AssetInput {
                    id: asset_id.clone(),
                    kind: "image".to_owned(),
                    name: format!("bench-image-{image_index}.png"),
                    mime: "image/png".to_owned(),
                    bytes: benchmark_png(image_index),
                    meta_json: Some(format!(r#"{{"image_index":{image_index}}}"#)),
                })
                .expect("import benchmark image asset");

                let batch_id = format!("bench-batch-{image_index}");
                let items = (0..IMAGE_ITEMS)
                    .map(|position| ResultItemInput {
                        id: format!("bench-item-{image_index}-{position}"),
                        position: position as f64,
                        kind: "image".to_owned(),
                        text: format!("Image {image_index} variant {position}"),
                        asset_id: Some(asset_id.clone()),
                        meta_json: Some(format!(
                            r#"{{"image_index":{image_index},"variant":{position}}}"#
                        )),
                    })
                    .collect();
                db.save_run(
                    ResultBatchInput {
                        id: batch_id,
                        node_id: format!("n{image_index}"),
                        trigger: "run".to_owned(),
                        provider: "mock-image".to_owned(),
                        model: "mock-image".to_owned(),
                        params_json: "{}".to_owned(),
                        status: "done".to_owned(),
                        error: None,
                    },
                    items,
                )
                .expect("save benchmark image batch");

                fixture.images += 1;
                fixture.batches += 1;
                fixture.items += IMAGE_ITEMS as u32;
                fixture.assets += 1;
            }
        }

        db.clear_history().expect("clear seed history");
        fixture
    }

    fn verify_fixture(db: &Database, fixture: &BenchmarkFixture, include_images: bool) {
        assert_eq!(
            db.count().expect("count fixture nodes"),
            fixture.nodes,
            "fixture node count"
        );
        assert_eq!(
            db.edge_count().expect("count fixture edges"),
            fixture.edges,
            "fixture edge count"
        );

        let ids = image_node_ids();
        assert_eq!(ids.len(), IMAGE_NODES as usize, "fixture image id count");
        let previews = db.previews(ids.clone()).expect("read fixture previews");
        if include_images {
            let (rows, items, assets) = validate_previews(&previews, &ids, "fixture");
            assert_eq!(rows, IMAGE_NODES as usize, "fixture image preview rows");
            assert_eq!(
                items,
                (IMAGE_NODES * IMAGE_ITEMS as u32) as usize,
                "fixture image item rows"
            );
            assert_eq!(
                assets, IMAGE_NODES as usize,
                "fixture distinct image assets"
            );
            let bytes = db
                .asset_bytes("bench-asset-0".to_owned())
                .expect("read fixture asset bytes");
            assert_eq!(bytes, benchmark_png(0), "fixture asset bytes round-trip");
        } else {
            assert!(
                previews.is_empty(),
                "the no-image fixture must return zero preview rows"
            );
            assert_eq!(fixture.images, 0, "no-image fixture image nodes");
            assert_eq!(fixture.batches, 0, "no-image fixture image batches");
        }
    }

    /// Checks the preview shape the card views rely on and returns the
    /// preview row, item row and distinct asset counts.
    fn validate_previews(
        previews: &[NodePreview],
        requested: &[String],
        label: &str,
    ) -> (usize, usize, usize) {
        assert_eq!(
            previews.len(),
            requested.len(),
            "{label}: returned preview rows"
        );
        let mut missing: BTreeSet<&str> = requested.iter().map(String::as_str).collect();
        let mut item_rows = 0;
        let mut asset_ids = BTreeSet::new();
        for preview in previews {
            assert_eq!(
                preview.item_count, IMAGE_ITEMS as f64,
                "{label}: {} item_count",
                preview.node_id
            );
            assert_eq!(
                preview.items.len(),
                IMAGE_ITEMS,
                "{label}: {} preview item rows",
                preview.node_id
            );
            assert!(
                missing.remove(preview.node_id.as_str()),
                "{label}: unexpected or repeated preview {}",
                preview.node_id
            );
            for item in &preview.items {
                assert_eq!(
                    item.kind, "image",
                    "{label}: {} item {} kind",
                    preview.node_id, item.id
                );
                let asset_id = item.asset_id.as_ref().unwrap_or_else(|| {
                    panic!("{label}: {} item {} asset id", preview.node_id, item.id)
                });
                let asset = item.asset.as_ref().unwrap_or_else(|| {
                    panic!(
                        "{label}: {} item {} asset metadata",
                        preview.node_id, item.id
                    )
                });
                assert_eq!(
                    &asset.id, asset_id,
                    "{label}: {} item {} asset link",
                    preview.node_id, item.id
                );
                item_rows += 1;
                asset_ids.insert(asset.id.clone());
            }
        }
        assert!(
            missing.is_empty(),
            "{label}: missing requested image ids {missing:?}"
        );
        (previews.len(), item_rows, asset_ids.len())
    }

    struct Stats {
        avg_ms: f64,
        p95_ms: f64,
        max_ms: f64,
    }

    /// Nearest-rank p95: `ceil(0.95 * n)` as the one-based rank.
    fn stats(samples: &mut [f64]) -> Stats {
        assert!(!samples.is_empty(), "a scenario needs at least one sample");
        samples.sort_by(f64::total_cmp);
        let count = samples.len();
        // Nearest rank is ceil(0.95 * n); the one-based rank minus one indexes
        // the sorted samples. `count >= 1` keeps the result in range.
        let p95_index = (count * 95).div_ceil(100).saturating_sub(1).min(count - 1);
        Stats {
            avg_ms: samples.iter().sum::<f64>() / count as f64,
            p95_ms: samples[p95_index],
            max_ms: samples[count - 1],
        }
    }

    fn print_stats(label: &str, samples: &mut [f64], detail: &str) {
        let count = samples.len();
        let stats = stats(samples);
        println!(
            "{label}: n={count} avg={:.2}ms p95={:.2}ms max={:.2}ms{detail}",
            stats.avg_ms, stats.p95_ms, stats.max_ms
        );
    }

    fn elapsed_ms(started: std::time::Instant) -> f64 {
        started.elapsed().as_secs_f64() * 1000.0
    }

    /// Mirrors `camera.fit` in `src/flow/camera.ts`: 48 points of padding on
    /// a 1920x1080 stage, capped at 1 and clamped to the 0.05 minimum.
    fn fit_scale(bounds: &Viewport) -> (f64, f64) {
        let available_width = (1920.0f64 - 48.0 * 2.0).max(1.0);
        let available_height = (1080.0f64 - 48.0 * 2.0).max(1.0);
        let raw = (available_width / bounds.width).min(available_height / bounds.height);
        (raw.clamp(0.05, 1.0), raw)
    }

    /// The world rectangle a centered Fit camera shows, expanded by the same
    /// `max(width, height) * 0.25` margin as the TSX viewport controller.
    fn scene_request(bounds: &Viewport, scale: f64) -> (Viewport, f64) {
        let padding = 48.0;
        let camera_x = 960.0 - (bounds.x + bounds.width / 2.0) * scale;
        let camera_y = 540.0 - (bounds.y + bounds.height / 2.0) * scale;
        let x = (-padding - camera_x) / scale;
        let y = (-padding - camera_y) / scale;
        let width = (1920.0 + padding - camera_x) / scale - x;
        let height = (1080.0 + padding - camera_y) / scale - y;
        let margin = width.max(height) * 0.25;
        (
            Viewport {
                x,
                y,
                width,
                height,
            },
            margin,
        )
    }

    fn measure_viewport(
        db: &Database,
        label: &str,
        rect: &Viewport,
        margin: f64,
        samples: usize,
    ) -> usize {
        let warmup = db.viewport(rect.clone(), margin).expect("viewport warmup");
        assert!(
            !warmup.is_empty(),
            "{label}: the viewport returned no nodes"
        );
        let rows = warmup.len();
        let mut times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = std::time::Instant::now();
            let found = db.viewport(rect.clone(), margin).expect("viewport sample");
            times.push(elapsed_ms(started));
            assert_eq!(
                found.len(),
                rows,
                "{label}: node rows changed between identical reads"
            );
        }
        print_stats(
            label,
            &mut times,
            &format!(
                " rect=({:.1},{:.1},{:.1},{:.1}) margin={margin:.1} nodes={rows}",
                rect.x, rect.y, rect.width, rect.height
            ),
        );
        rows
    }

    fn measure_scene(
        db: &Database,
        label: &str,
        rect: &Viewport,
        margin: f64,
        scale: f64,
        samples: usize,
    ) -> (usize, usize) {
        // The same card budget the canvas passes at this camera scale.
        let max_cards = if scale < 0.15 {
            300
        } else if scale < 0.4 {
            800
        } else {
            2_000
        };
        let warmup = db
            .scene(rect.clone(), margin, max_cards)
            .expect("scene warmup");
        assert!(
            !warmup.nodes.is_empty(),
            "{label}: the scene returned no nodes"
        );
        let (nodes, edges) = (warmup.nodes.len(), warmup.edges.len());
        let mut times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = std::time::Instant::now();
            let snapshot = db
                .scene(rect.clone(), margin, max_cards)
                .expect("scene sample");
            times.push(elapsed_ms(started));
            assert_eq!(
                snapshot.nodes.len(),
                nodes,
                "{label}: node rows changed between identical reads"
            );
            assert_eq!(
                snapshot.edges.len(),
                edges,
                "{label}: edge rows changed between identical reads"
            );
        }
        print_stats(
            label,
            &mut times,
            &format!(
                " scale={scale:.4} rect=({:.1},{:.1},{:.1},{:.1}) margin={margin:.1} nodes={nodes} edges={edges}",
                rect.x, rect.y, rect.width, rect.height
            ),
        );
        (nodes, edges)
    }

    fn measure_previews(db: &Database, ids: &[String], samples: usize) -> (usize, usize, usize) {
        let label = format!("previews images={}", ids.len());
        let warmup = db.previews(ids.to_vec()).expect("preview warmup");
        let (rows, items, assets) = validate_previews(&warmup, ids, &label);
        let mut times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = std::time::Instant::now();
            let previews = db.previews(ids.to_vec()).expect("preview sample");
            times.push(elapsed_ms(started));
            let (sampled_rows, sampled_items, sampled_assets) =
                validate_previews(&previews, ids, &label);
            assert_eq!(
                (sampled_rows, sampled_items, sampled_assets),
                (rows, items, assets),
                "{label}: preview shape changed between identical reads"
            );
        }
        print_stats(
            &label,
            &mut times,
            &format!(" rows={rows} items={items} assets={assets}"),
        );
        (rows, items, assets)
    }

    fn node_bounds(db: &Database, id: &str) -> NodeBounds {
        let summary = db
            .get_node(id.to_owned())
            .expect("read node bounds")
            .expect("the node exists");
        NodeBounds {
            id: summary.id,
            x: summary.x,
            y: summary.y,
            width: summary.width,
            height: summary.height,
        }
    }

    fn shifted(bounds: &NodeBounds, dx: f64, dy: f64) -> NodeBounds {
        NodeBounds {
            id: bounds.id.clone(),
            x: bounds.x + dx,
            y: bounds.y + dy,
            width: bounds.width,
            height: bounds.height,
        }
    }

    fn assert_bounds(db: &Database, expected: &[NodeBounds], context: &str) {
        for bounds in expected {
            assert_eq!(
                node_bounds(db, &bounds.id),
                *bounds,
                "{context}: {}",
                bounds.id
            );
        }
    }

    /// Runs the evidence pass outside the timed section: an interior edge has
    /// two moved ports, and the two boundary edges keep their far ports where
    /// they were. The mutation's own `edges_changed` is deliberately empty.
    fn validate_moved_connectors(
        db: &Database,
        target: &[NodeBounds],
        far_before: &[NodeBounds],
        cycle: usize,
    ) {
        let moved = |id: &str| -> NodeBounds {
            target
                .iter()
                .find(|bounds| bounds.id == id)
                .expect("moved node")
                .clone()
        };
        let far = |id: &str| -> NodeBounds {
            far_before
                .iter()
                .find(|bounds| bounds.id == id)
                .expect("unmoved node")
                .clone()
        };

        let row = db
            .scene(
                Viewport {
                    x: -100.0,
                    y: 68_500.0,
                    width: 1_000.0,
                    height: 600.0,
                },
                0.0,
                viewport::NODE_LIMIT,
            )
            .expect("scene over the moved row");
        let interior = row
            .edges
            .iter()
            .find(|edge| edge.id == "e49001")
            .expect("interior edge e49001");
        let from = moved("n49001");
        let to = moved("n49002");
        assert_eq!(
            interior.from_point,
            Some(EdgePoint::output(from.x, from.y, from.width, from.height)),
            "cycle {cycle}: interior from port"
        );
        assert_eq!(
            interior.to_point,
            Some(EdgePoint::input(to.x, to.y, to.height)),
            "cycle {cycle}: interior to port"
        );

        let crossing = row
            .edges
            .iter()
            .find(|edge| edge.id == "e49000")
            .expect("boundary edge e49000");
        let far_from = far("n49000");
        let moved_to = moved("n49001");
        assert_eq!(
            crossing.from_point,
            Some(EdgePoint::output(
                far_from.x,
                far_from.y,
                far_from.width,
                far_from.height
            )),
            "cycle {cycle}: boundary far from port"
        );
        assert_eq!(
            crossing.to_point,
            Some(EdgePoint::input(moved_to.x, moved_to.y, moved_to.height)),
            "cycle {cycle}: boundary moved to port"
        );

        let end = db
            .scene(
                Viewport {
                    x: -100.0,
                    y: 69_900.0,
                    width: 1_000.0,
                    height: 600.0,
                },
                0.0,
                viewport::NODE_LIMIT,
            )
            .expect("scene over the last moved row");
        let boundary = end
            .edges
            .iter()
            .find(|edge| edge.id == "e50000")
            .expect("boundary edge e50000");
        let moved_from = moved("n50000");
        let far_to = far("n50001");
        assert_eq!(
            boundary.from_point,
            Some(EdgePoint::output(
                moved_from.x,
                moved_from.y,
                moved_from.width,
                moved_from.height
            )),
            "cycle {cycle}: boundary moved from port"
        );
        assert_eq!(
            boundary.to_point,
            Some(EdgePoint::input(far_to.x, far_to.y, far_to.height)),
            "cycle {cycle}: boundary far to port"
        );

        assert_bounds(db, far_before, &format!("cycle {cycle} far endpoints"));
    }

    fn run_move_cycles(db: &Database) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
        // Offset by one card from a row start so both the first and last
        // cards have a connector to an unmoved neighbor.
        let ids: Vec<String> = (49_001..=50_000).map(|i| format!("n{i}")).collect();
        let far_ids = ["n49000", "n50001"];

        let warm_before: Vec<NodeBounds> = ids.iter().map(|id| node_bounds(db, id)).collect();
        let warm_target: Vec<NodeBounds> = warm_before
            .iter()
            .map(|bounds| shifted(bounds, 10.0, 10.0))
            .collect();
        db.set_node_bounds(warm_target).expect("warm move");
        db.undo().expect("warm undo");
        assert_bounds(db, &warm_before, "warmup undo");
        db.clear_history().expect("clear warmup history");
        println!("setNodeBounds moved=1000: one warmup on (+10,+10), undone, history cleared");

        let mut move_times = Vec::with_capacity(MOVE_SAMPLES);
        let mut undo_times = Vec::with_capacity(MOVE_SAMPLES);
        let mut redo_times = Vec::with_capacity(MOVE_SAMPLES);
        for cycle in 0..MOVE_SAMPLES {
            let before: Vec<NodeBounds> = ids.iter().map(|id| node_bounds(db, id)).collect();
            let far_before: Vec<NodeBounds> =
                far_ids.iter().map(|id| node_bounds(db, id)).collect();
            let dx = 31.0 + cycle as f64;
            let dy = 20.0;
            let target: Vec<NodeBounds> = before
                .iter()
                .map(|bounds| shifted(bounds, dx, dy))
                .collect();

            let started = std::time::Instant::now();
            let moved = db.set_node_bounds(target.clone()).expect("move bounds");
            move_times.push(elapsed_ms(started));
            assert_eq!(
                moved.changes.changed.len(),
                ids.len(),
                "cycle {cycle}: moved summaries"
            );
            for (actual, expected) in moved.changes.changed.iter().zip(target.iter()) {
                assert_eq!(actual.id, expected.id, "cycle {cycle}: moved id");
                assert_eq!(
                    (actual.x, actual.y, actual.width, actual.height),
                    (expected.x, expected.y, expected.width, expected.height),
                    "cycle {cycle}: moved geometry {}",
                    expected.id
                );
            }
            validate_moved_connectors(db, &target, &far_before, cycle);

            let started = std::time::Instant::now();
            let undone = db.undo().expect("undo move");
            undo_times.push(elapsed_ms(started));
            assert_eq!(
                undone.changed.len(),
                ids.len(),
                "cycle {cycle}: undone summaries"
            );
            assert_bounds(db, &before, &format!("cycle {cycle} undo"));

            let started = std::time::Instant::now();
            let redone = db.redo().expect("redo move");
            redo_times.push(elapsed_ms(started));
            assert_eq!(
                redone.changed.len(),
                ids.len(),
                "cycle {cycle}: redone summaries"
            );
            assert_bounds(db, &target, &format!("cycle {cycle} redo"));

            // Reset outside the timed section, then drop the reset's own
            // history entry so every cycle starts with exactly one move on
            // the stack.
            db.set_node_bounds(before.clone()).expect("reset bounds");
            db.clear_history().expect("clear reset history");
            println!(
                "setNodeBounds moved=1000 cycle={cycle} offset=({dx:.0},{dy:.0}) move={:.2}ms undo={:.2}ms redo={:.2}ms",
                move_times[cycle], undo_times[cycle], redo_times[cycle]
            );
        }
        (move_times, undo_times, redo_times)
    }

    fn measure_search(db: &Database, label: &str, query: &str, samples: usize) -> usize {
        let warmup = db
            .search(query.to_owned(), SearchFilters::default(), 20)
            .expect("search warmup");
        let hits = warmup.len();
        let mut times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = std::time::Instant::now();
            let found = db
                .search(query.to_owned(), SearchFilters::default(), 20)
                .expect("search sample");
            times.push(elapsed_ms(started));
            assert_eq!(
                found.len(),
                hits,
                "{label}: result count changed between identical queries"
            );
        }
        print_stats(label, &mut times, &format!(" hits={hits} query={query}"));
        hits
    }

    fn mark_running(db: &Database, iteration: u32, ids: &[String]) {
        for (k, id) in ids.iter().enumerate() {
            let batch_id = format!("bench-recover-{iteration}-{k}");
            db.save_run(
                ResultBatchInput {
                    id: batch_id.clone(),
                    node_id: id.clone(),
                    trigger: "run".to_owned(),
                    provider: "mock-text".to_owned(),
                    model: "mock-text".to_owned(),
                    params_json: "{}".to_owned(),
                    status: "running".to_owned(),
                    error: None,
                },
                Vec::new(),
            )
            .expect("mark a sink node running");
            let detail = db
                .node_detail(id.clone())
                .expect("read the running node")
                .expect("the running node exists");
            assert_eq!(
                detail.node.status, "running",
                "recovery {iteration}: {id} status before reopen"
            );
            let latest = detail.latest_batch.expect("the running batch exists");
            assert_eq!(
                latest.id, batch_id,
                "recovery {iteration}: {id} latest batch id"
            );
            assert_eq!(
                latest.status, "running",
                "recovery {iteration}: {id} latest batch status"
            );
        }
    }

    fn verify_recovered(db: &Database, ids: &[String], iteration: u32) {
        for id in ids {
            let detail = db
                .node_detail(id.clone())
                .expect("read the recovered node")
                .expect("the recovered node exists");
            assert_eq!(
                detail.node.status, "interrupted",
                "recovery {iteration}: {id} node status"
            );
            let latest = detail.latest_batch.expect("the recovered batch exists");
            assert_eq!(
                latest.status, "interrupted",
                "recovery {iteration}: {id} batch status"
            );
        }
    }

    #[test]
    fn benchmark_stats_use_nearest_rank_p95() {
        let mut five = [1.0, 2.0, 3.0, 4.0, 100.0];
        let summary = stats(&mut five);
        assert_eq!(summary.avg_ms, 22.0);
        assert_eq!(summary.p95_ms, 100.0);
        assert_eq!(summary.max_ms, 100.0);

        let mut twenty: Vec<f64> = (1..=20).map(f64::from).collect();
        let summary = stats(&mut twenty);
        assert_eq!(summary.avg_ms, 10.5);
        assert_eq!(summary.p95_ms, 19.0);
        assert_eq!(summary.max_ms, 20.0);
    }

    #[test]
    fn benchmark_png_is_a_deterministic_2x2_rgba_png() {
        let png = benchmark_png(0);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(
            u32::from_be_bytes(png[16..20].try_into().expect("IHDR width")),
            2
        );
        assert_eq!(
            u32::from_be_bytes(png[20..24].try_into().expect("IHDR height")),
            2
        );
        assert_eq!(png[24], 8, "bit depth");
        assert_eq!(png[25], 6, "colour type RGBA");
        assert_eq!(crc32(b"IEND"), 0xAE42_6082, "known CRC32 vector");
        assert_eq!(png, benchmark_png(0), "deterministic bytes");
        assert_ne!(png, benchmark_png(50), "distinct image indices");
    }

    #[test]
    #[ignore = "writes the 100k UI fixture; set FLOW_BENCH_DB=<path>"]
    fn seed_benchmark_database() {
        let Ok(path) = std::env::var("FLOW_BENCH_DB") else {
            println!("FLOW_BENCH_DB is not set; skipping the 100k fixture");
            return;
        };
        if let Some(parent) = Path::new(&path).parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        // Destructive re-seed for the dedicated benchmark database only: the
        // smoke recreates it on every run. Never point FLOW_BENCH_DB at an
        // ordinary FLOW_DB_PATH document.
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{path}{suffix}"));
        }

        let db = Database::open(&path).expect("open benchmark database");
        let fixture = seed_grid(&db, false, &path);
        verify_fixture(&db, &fixture, false);
        print_fixture(&fixture, false);
        println!(
            "100k fixture seed: the smoke shares the {} node / {} edge text graph but leaves image nodes as text",
            fixture.nodes, fixture.edges
        );
    }

    #[test]
    #[ignore = "100k enriched benchmark; run with --release -- --ignored --nocapture --test-threads=1"]
    fn hundred_thousand_nodes_benchmark() {
        let temp = BenchmarkTempDir::new();
        let path = temp.database_path();

        let seed_started = std::time::Instant::now();
        let fixture = {
            let db = Database::open(&path).expect("open the fixture database");
            let fixture = seed_grid(&db, true, &path);
            verify_fixture(&db, &fixture, true);
            fixture
        };
        let seed_ms = elapsed_ms(seed_started);
        print_fixture(&fixture, true);
        println!("100k fixture seed (open+insert+assets+batches)={seed_ms:.2}ms");

        let mut db = Database::open(&path).expect("reopen the seeded fixture");
        assert_eq!(
            db.count().expect("reopened node count"),
            GRID_NODES,
            "reopened fixture node count"
        );
        assert_eq!(
            db.edge_count().expect("reopened edge count"),
            GRID_NODES - GRID_ROWS,
            "reopened fixture edge count"
        );

        let bounds_started = std::time::Instant::now();
        let bounds = db.bounds().expect("measure document bounds");
        let bounds_ms = elapsed_ms(bounds_started);
        assert!(bounds.width > 0.0 && bounds.height > 0.0);
        println!("bounds (Fit source): {bounds:?} read={bounds_ms:.2}ms");

        let legacy_rect = Viewport {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        measure_viewport(
            &db,
            "legacy viewport scale=1.0000 (reference; edges and images present)",
            &legacy_rect,
            120.0,
            SCENE_SAMPLES,
        );
        measure_scene(
            &db,
            "legacy scene scale=1.0000 (reference; edges and images present)",
            &legacy_rect,
            120.0,
            1.0,
            SCENE_SAMPLES,
        );

        let (fit, fit_raw) = fit_scale(&bounds);
        println!(
            "camera fit: raw={fit_raw:.6} scale={fit:.6} clamp={}",
            if fit_raw < 0.05 {
                "MIN_SCALE 0.05"
            } else if fit_raw > 1.0 {
                "MAX_SCALE 1.0"
            } else {
                "none"
            }
        );
        let scales = [
            (format!("scene fit={fit:.4}"), fit),
            ("scene scale=0.15".to_owned(), 0.15),
            ("scene scale=0.40".to_owned(), 0.40),
        ];
        for (label, scale) in scales {
            let (rect, margin) = scene_request(&bounds, scale);
            measure_scene(&db, &label, &rect, margin, scale, SCENE_SAMPLES);
        }

        let image_ids = image_node_ids();
        measure_previews(&db, &image_ids, SCENE_SAMPLES);

        db.clear_history()
            .expect("clear history before move timing");
        println!("setNodeBounds moved=1000: history cleared immediately before timing");
        let (mut move_times, mut undo_times, mut redo_times) = run_move_cycles(&db);
        print_stats(
            "setNodeBounds moved=1000",
            &mut move_times,
            " nodes=1000 samples=3",
        );
        print_stats("undo moved=1000", &mut undo_times, " nodes=1000 samples=3");
        print_stats("redo moved=1000", &mut redo_times, " nodes=1000 samples=3");

        assert!(measure_search(&db, "search generator", "generator", SEARCH_COMMON_SAMPLES) > 0);
        assert!(measure_search(&db, "search Node 99999", "Node 99999", SEARCH_SAMPLES) > 0);
        assert!(measure_search(&db, "search 图片", "图片", SEARCH_SAMPLES) > 0);
        assert!(measure_search(&db, "search 生成器", "生成器", SEARCH_SAMPLES) > 0);

        let sinks = sink_node_ids();
        assert_eq!(sinks.len(), 100, "recovery sink count");
        for id in &sinks {
            let summary = db
                .get_node(id.clone())
                .expect("read recovery sink")
                .expect("the recovery sink exists");
            assert_eq!(summary.kind, "text", "recovery sink {id} kind");
            assert!(id.ends_with("99"), "recovery sink {id} is a row end");
        }
        println!(
            "recovery sinks: {} row-end text nodes first={} last={} (every tenth row; the grid ends at n99999)",
            sinks.len(),
            sinks.first().expect("the first sink"),
            sinks.last().expect("the last sink")
        );

        for iteration in 0..RECOVERY_ITERATIONS {
            mark_running(&db, iteration, &sinks);
            drop(db);

            let open_started = std::time::Instant::now();
            db = Database::open(&path).expect("reopen for recovery");
            let open_ms = elapsed_ms(open_started);

            let recover_started = std::time::Instant::now();
            let recovered = db.recover_runs().expect("recover running nodes");
            let recover_ms = elapsed_ms(recover_started);
            assert_eq!(
                recovered,
                sinks.len() as u32,
                "recovery iteration {iteration}: recovered rows"
            );
            verify_recovered(&db, &sinks, iteration);
            let second = db.recover_runs().expect("second recovery");
            assert_eq!(
                second, 0,
                "recovery iteration {iteration}: second recovery finds no running rows"
            );
            println!(
                "recovery iteration={iteration} batch_prefix=bench-recover-{iteration}- open/migrate only={open_ms:.2}ms recover_runs={recover_ms:.2}ms open+recover={:.2}ms recovered={recovered} second={second}",
                open_ms + recover_ms
            );
        }

        drop(db);
        let db = Database::open(&path).expect("final clean reopen");
        assert_eq!(
            db.count().expect("final reopen node count"),
            GRID_NODES,
            "final reopen node count"
        );
        assert_eq!(
            db.edge_count().expect("final reopen edge count"),
            GRID_NODES - GRID_ROWS,
            "final reopen edge count"
        );
        let previews = db
            .previews(image_ids.clone())
            .expect("final reopen previews");
        assert_eq!(
            previews.len(),
            IMAGE_NODES as usize,
            "final reopen image previews"
        );
        assert_eq!(
            db.recover_runs().expect("final recovery"),
            0,
            "final reopen has no running rows"
        );
        drop(db);

        let cleaned = temp.path_string();
        drop(temp);
        println!("100k fixture cleanup: removed {cleaned}");
    }
}
