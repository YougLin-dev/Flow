use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveValue::Set, ActiveValue::Unchanged, ConnectionTrait, DatabaseConnection, EntityTrait,
    FromQueryResult, QuerySelect,
};

use crate::asset;
use crate::detail;
use crate::document;
use crate::entity::{document as document_row, nodes};
#[cfg(test)]
use crate::history::HistoryOp;
use crate::history::{History, HistoryEntry, HistoryRefs};
use crate::mutation::{self, Mutation};
use crate::scene;
use crate::schema;
use crate::search;
use crate::types::{
    AssetInput, AssetSummary, ChangeSet, EdgeInput, InputItemInput, InputItemSummary, NodeBounds,
    NodeDetail, NodeInput, NodePreview, NodeSummary, Overview, ProjectInfo, ResultBatchInput,
    ResultItemInput, SceneSnapshot, SearchFilters, SearchHit, SeedDocumentInput, Viewport,
};
use crate::viewport;

/// A unit of work for the database thread.
enum Job {
    Run(Box<dyn FnOnce(&DatabaseConnection) + Send + 'static>),
    /// Marks the package cleanly closed, acknowledges, and stops the worker.
    Close(Sender<Result<(), String>>),
}

/// The asset directory shared by a database's clones. An in-memory database
/// gets a private temporary directory; removing it on the last drop keeps
/// the test temp root from accumulating.
struct AssetsDir {
    path: PathBuf,
    temporary: bool,
}

impl std::ops::Deref for AssetsDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl Drop for AssetsDir {
    fn drop(&mut self) {
        if self.temporary {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

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
    assets_dir: Arc<AssetsDir>,
    /// The last document bounds, tagged with the revision they describe:
    /// Fit and the minimap's overview ask at the same revision at startup.
    bounds_cache: Arc<Mutex<Option<(i64, Viewport)>>>,
    closed: Arc<AtomicBool>,
}

impl Database {
    pub fn open(path: &str) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let path = path.to_owned();
        let assets_dir = Arc::new(AssetsDir {
            path: asset::assets_dir_for(&path),
            temporary: path == ":memory:",
        });

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
            bounds_cache: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// The package identity, title, camera and derived counts.
    pub fn project_info(&self) -> Result<ProjectInfo, String> {
        self.run(|conn| {
            let document = document::current(conn).map_err(|error| error.to_string())?;
            Ok(ProjectInfo {
                project_id: document.project_id,
                title: document.title,
                camera_x: document.camera_x,
                camera_y: document.camera_y,
                camera_zoom: document.camera_zoom,
                node_count: document.node_count as f64,
                edge_count: document.edge_count as f64,
                demo_seeded: document.demo_seeded != 0,
            })
        })
    }

    /// Persists the camera without bumping the undo-independent revision.
    pub fn save_view(&self, x: f64, y: f64, zoom: f64) -> Result<(), String> {
        if !schema::v1::is_valid_camera(x, y, zoom) {
            return Err("the camera is outside the supported range".to_owned());
        }
        self.run(move |conn| {
            document_row::Entity::update(document_row::ActiveModel {
                id: Unchanged(document::ROW_ID),
                camera_x: Set(x),
                camera_y: Set(y),
                camera_zoom: Set(zoom),
                ..Default::default()
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    /// Checks the SQLite file and its foreign keys. Kept off the open path:
    /// the 100k fixture makes a full check expensive.
    pub fn verify(&self) -> Result<(), String> {
        self.run(|conn| {
            let integrity = conn
                .query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "PRAGMA quick_check".to_owned(),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "quick_check returned no row".to_owned())?
                .try_get_by_index::<String>(0)
                .map_err(|error| error.to_string())?;
            if integrity != "ok" {
                return Err(format!(
                    "the database failed its integrity check: {integrity}"
                ));
            }
            let violations = conn
                .query_all_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "PRAGMA foreign_key_check".to_owned(),
                ))
                .map_err(|error| error.to_string())?;
            if !violations.is_empty() {
                return Err(format!(
                    "the database has {} foreign-key violation(s)",
                    violations.len()
                ));
            }
            Ok(())
        })
    }

    /// Tightens the conservative document bounds after deletes, and records
    /// that they are exact. Maintenance only: it does not bump the revision.
    pub fn compact_bounds(&self) -> Result<(), String> {
        let result = self.run(|conn| {
            conn.transaction::<_, _, sea_orm::DbErr>(|txn| {
                #[derive(FromQueryResult)]
                struct Bounds {
                    min_x: Option<f64>,
                    max_x: Option<f64>,
                    min_y: Option<f64>,
                    max_y: Option<f64>,
                }
                let bounds = nodes::Entity::find()
                    .select_only()
                    .expr_as(Expr::col(nodes::Column::X).min(), "min_x")
                    .expr_as(
                        Expr::col(nodes::Column::X)
                            .add(Expr::col(nodes::Column::Width))
                            .max(),
                        "max_x",
                    )
                    .expr_as(Expr::col(nodes::Column::Y).min(), "min_y")
                    .expr_as(
                        Expr::col(nodes::Column::Y)
                            .add(Expr::col(nodes::Column::Height))
                            .max(),
                        "max_y",
                    )
                    .into_model::<Bounds>()
                    .one(txn)?
                    .unwrap_or(Bounds {
                        min_x: None,
                        max_x: None,
                        min_y: None,
                        max_y: None,
                    });
                document_row::Entity::update(document_row::ActiveModel {
                    id: Unchanged(document::ROW_ID),
                    bounds_exact: Set(1),
                    min_x: Set(bounds.min_x),
                    max_x: Set(bounds.max_x),
                    min_y: Set(bounds.min_y),
                    max_y: Set(bounds.max_y),
                    ..Default::default()
                })
                .exec(txn)?;
                Ok(())
            })
            .map_err(|error| error.to_string())
        });
        if result.is_ok()
            && let Ok(mut cache) = self.bounds_cache.lock()
        {
            *cache = None;
        }
        result
    }

    /// Marks the package cleanly closed and stops the worker. Idempotent: a
    /// second call (or a call after the worker stopped) does nothing.
    pub fn close(&self) -> Result<(), String> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let (result_tx, result_rx) = mpsc::channel();
        let sent = self
            .tx
            .lock()
            .map_err(|_| "the database worker lock is poisoned".to_owned())?
            .send(Job::Close(result_tx));
        if sent.is_err() {
            return Ok(());
        }
        result_rx
            .recv()
            .map_err(|_| "the database worker stopped during close".to_owned())?
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
        tags: Vec<String>,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::set_node_text(conn, id, title, tags))
    }

    pub fn set_node_settings(
        &self,
        id: String,
        settings_json: String,
        valid_ports: Option<Vec<String>>,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| {
            mutation::set_node_settings(conn, id, settings_json, valid_ports)
        })
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

    /// A local upload's output: the batch, the node's derived ports, its
    /// body and its fitted card rectangle in one undoable write.
    pub fn set_manual_upload(
        &self,
        id: String,
        settings_json: String,
        body: String,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
        bounds: Option<NodeBounds>,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| {
            mutation::set_manual_upload(conn, id, settings_json, body, batch, items, bounds)
        })
    }

    /// Inserts a node with its uploaded output already in place, in one
    /// undoable write: a copied upload card must not exist empty until a
    /// second history entry fills it.
    pub fn insert_upload_node(
        &self,
        node: NodeInput,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
    ) -> Result<Mutation, String> {
        self.run_mutation(move |conn| mutation::insert_upload_node(conn, node, batch, items))
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
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let refs = mutation::sync_inputs(conn, node_id.clone())?;
            invalidate_history(&history, &refs);
            detail::inputs(conn, &node_id)
        })
    }

    /// Persists a completed, failed or cancelled provider run in one call.
    /// Provider runs use `begin_run`/`settle_run` instead. Not undoable.
    pub fn save_run(
        &self,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
    ) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (changes, refs) = mutation::save_run(conn, batch, items)?;
            invalidate_history(&history, &refs);
            Ok(changes)
        })
    }

    /// Starts a provider run: a running batch and a running node. Not
    /// undoable; a later non-history write invalidates pending entries.
    pub fn begin_run(&self, batch: ResultBatchInput) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (changes, refs) = mutation::begin_run(conn, batch)?;
            invalidate_history(&history, &refs);
            Ok(changes)
        })
    }

    /// Settles the running batch a provider call started, adding its items.
    /// A late or repeated settle is a no-op.
    pub fn settle_run(
        &self,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
    ) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (changes, refs) = mutation::settle_run(conn, batch, items)?;
            invalidate_history(&history, &refs);
            Ok(changes)
        })
    }

    /// Writes the demo seed in one transaction and clears the undo history.
    pub fn seed_document(&self, input: SeedDocumentInput) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let changes = mutation::seed_document(conn, input)?;
            if let Ok(mut history) = history.lock() {
                history.clear();
            }
            Ok(changes)
        })
    }

    pub fn set_node_status(&self, id: String, status: String) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (changes, refs) = mutation::set_node_status(conn, id, status)?;
            invalidate_history(&history, &refs);
            Ok(changes)
        })
    }

    /// Marks runs left running by a previous process as interrupted.
    pub fn recover_runs(&self) -> Result<u32, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (count, refs) = mutation::recover_runs(conn)?;
            invalidate_history(&history, &refs);
            Ok(count)
        })
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
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let summary = asset::import_asset(conn, &assets_dir, input)?;
            let mut refs = HistoryRefs::default();
            refs.asset(Some(&summary.id));
            invalidate_history(&history, &refs);
            Ok(summary)
        })
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
        self.run(move |conn| match mutation::apply_ops(conn, &ops)? {
            mutation::ApplyOutcome::Applied(changes) => Ok(changes),
            mutation::ApplyOutcome::Stale => empty_change(conn),
        })
    }

    /// Reverts the last command. The history entry is taken and returned in
    /// the same worker job as the database writes.
    pub fn undo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let entry = {
                let mut history = lock_history(&history)?;
                history.take_undo()
            };
            let Some(entry) = entry else {
                return empty_change(conn);
            };
            let mut ops = entry.inverse.clone();
            ops.reverse();
            match mutation::apply_ops(conn, &ops) {
                Ok(mutation::ApplyOutcome::Applied(changes)) => {
                    // The undo is committed. A poisoned lock loses the redo
                    // entry rather than reporting a failure and inviting a
                    // duplicate retry.
                    if let Ok(mut history) = history.lock() {
                        history.push_redo(entry);
                    }
                    Ok(changes)
                }
                Ok(mutation::ApplyOutcome::Stale) => {
                    // The entry can never apply again; drop it rather than
                    // leaving it on the redo stack.
                    empty_change(conn)
                }
                Err(error) => {
                    if let Ok(mut history) = history.lock() {
                        history.restore_undo(entry);
                    }
                    Err(error)
                }
            }
        })
    }

    /// Reapplies the last undone command, on the same worker job.
    pub fn redo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let entry = {
                let mut history = lock_history(&history)?;
                history.take_redo()
            };
            let Some(entry) = entry else {
                return empty_change(conn);
            };
            let ops = entry.forward.clone();
            match mutation::apply_ops(conn, &ops) {
                Ok(mutation::ApplyOutcome::Applied(changes)) => {
                    if let Ok(mut history) = history.lock() {
                        history.push_undo_after_redo(entry);
                    }
                    Ok(changes)
                }
                Ok(mutation::ApplyOutcome::Stale) => empty_change(conn),
                Err(error) => {
                    if let Ok(mut history) = history.lock() {
                        history.push_redo(entry);
                    }
                    Err(error)
                }
            }
        })
    }

    /// Drops the undo and redo stacks; used after seeding demo data.
    ///
    /// Queued on the worker so it cannot overtake a preceding command and
    /// leave that command's entry behind. Do not call it from inside a job:
    /// the worker is busy executing that job.
    pub fn clear_history(&self) -> Result<(), String> {
        let history = Arc::clone(&self.history);
        self.run(move |_| {
            lock_history(&history)?.clear();
            Ok(())
        })
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
        let cache = self.bounds_cache.clone();
        self.run(move |conn| cached_bounds(conn, &cache))
    }

    pub fn overview(&self) -> Result<Overview, String> {
        let cache = self.bounds_cache.clone();
        self.run(move |conn| {
            let bounds = cached_bounds(conn, &cache)?;
            scene::overview(conn, bounds)
        })
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

    /// Whether the open document has neither nodes nor edges. One worker job
    /// answers startup's seed question with two existence reads, not counts.
    pub fn is_empty(&self) -> Result<bool, String> {
        self.run(|conn| Ok(!has_nodes(conn)? && !has_edges(conn)?))
    }

    /// Runs a document mutation and records its inverse in the same worker
    /// job, so command order and history order can never diverge.
    fn run_mutation<F>(&self, work: F) -> Result<Mutation, String>
    where
        F: FnOnce(&DatabaseConnection) -> Result<Mutation, String> + Send + 'static,
    {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            // Fail before the write if the history is already poisoned.
            ensure_history(&history)?;
            let mutation = work(conn)?;
            // The write is committed. If the lock is poisoned between the
            // preflight and here, lose this undo entry rather than report a
            // failure that invites a duplicate retry.
            if let Ok(mut history) = history.lock() {
                history.push(HistoryEntry::new(
                    mutation.forward.clone(),
                    mutation.inverse.clone(),
                    &mutation.refs,
                ));
            }
            Ok(mutation)
        })
    }

    fn run<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&DatabaseConnection) -> Result<T, String> + Send + 'static,
    {
        if self.closed.load(Ordering::SeqCst) {
            return Err("the database is closed".to_owned());
        }
        let (result_tx, result_rx) = mpsc::channel();
        let job = Job::Run(Box::new(move |conn| {
            // A panic that unwinds through a SeaORM transaction can still
            // abort if its rollback also fails; this covers the job body.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(conn)));
            let _ = result_tx.send(match result {
                Ok(result) => result,
                Err(_) => Err("the database job panicked".to_owned()),
            });
        }));

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
        match job {
            // A Run body reports its own error. This outer guard keeps a
            // panicking job from killing the only worker thread.
            Job::Run(run) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&conn)));
            }
            Job::Close(ack) => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    conn.execute_unprepared("UPDATE document SET clean_shutdown = 1 WHERE id = 1")
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }))
                .unwrap_or_else(|_| Err("the database job panicked".to_owned()));
                let _ = ack.send(result);
                break;
            }
        }
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
    schema::v1::configure(&conn).map_err(|error| package_error(path, error))?;

    // Inspect before tuning the file: setting WAL would write to a foreign
    // database even though the guard then refuses it.
    match schema::v1::inspect(&conn).map_err(|error| package_error(path, error))? {
        schema::v1::FileState::New => {
            schema::v1::create(&conn, "Flow").map_err(|error| package_error(path, error))?;
        }
        schema::v1::FileState::Current(_) => {}
    }
    configure(&conn, path)?;

    // The flag stays 0 for the whole session; `close` sets it once the
    // document has been written out cleanly.
    conn.execute_unprepared("UPDATE document SET clean_shutdown = 0 WHERE id = 1")
        .map_err(|error| error.to_string())?;

    Ok(conn)
}

/// Adds the package path and a recovery suggestion to a guard error. The
/// guard itself sees only the connection.
fn package_error(path: &str, error: String) -> String {
    format!(
        "{path}: {error}. The file is not a compatible Flow project package; \
         delete it and its assets directory, or open a new project."
    )
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

fn ensure_history(history: &Arc<Mutex<History>>) -> Result<(), String> {
    lock_history(history).map(drop)
}

/// A non-history write has committed; drop the entries it made stale. A
/// poisoned lock is ignored here because the write already happened and an
/// error would invite a duplicate retry.
fn invalidate_history(history: &Arc<Mutex<History>>, refs: &HistoryRefs) {
    if let Ok(mut history) = history.lock() {
        history.invalidate(refs);
    }
}

/// The document bounds at the current revision, reusing the last read.
///
/// Every command bumps the document revision, so an entry from another
/// revision is never reused: a change that moves, adds or removes a node
/// invalidates the cache by construction. Fit and the minimap's overview ask
/// at the same revision at startup, and repeated Fit presses reuse the entry.
fn cached_bounds(
    conn: &DatabaseConnection,
    cache: &Arc<Mutex<Option<(i64, Viewport)>>>,
) -> Result<Viewport, String> {
    let rev = document::current_rev(conn).map_err(|error| error.to_string())?;
    {
        let cached = cache
            .lock()
            .map_err(|_| "the bounds cache lock is poisoned".to_owned())?;
        if let Some((cached_rev, bounds)) = cached.as_ref()
            && *cached_rev == rev
        {
            return Ok(bounds.clone());
        }
    }
    let bounds = scene::bounds(conn)?;
    *cache
        .lock()
        .map_err(|_| "the bounds cache lock is poisoned".to_owned())? = Some((rev, bounds.clone()));
    Ok(bounds)
}

fn count(conn: &DatabaseConnection) -> Result<u32, String> {
    let document = document::current(conn).map_err(|error| error.to_string())?;
    Ok(std::cmp::Ord::max(document.node_count, 0) as u32)
}

fn edge_count(conn: &DatabaseConnection) -> Result<u32, String> {
    let document = document::current(conn).map_err(|error| error.to_string())?;
    Ok(std::cmp::Ord::max(document.edge_count, 0) as u32)
}

/// Whether any node exists, read from the trigger-maintained document
/// counters in one primary-key row.
fn has_nodes(conn: &DatabaseConnection) -> Result<bool, String> {
    Ok(count(conn)? > 0)
}

/// Whether any edge exists, read from the trigger-maintained document
/// counters in one primary-key row.
fn has_edges(conn: &DatabaseConnection) -> Result<bool, String> {
    Ok(edge_count(conn)? > 0)
}

pub(crate) fn sqlite_url(path: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::clock::now_ms;
    use crate::entity::{edges, node_inputs, nodes, result_batches};
    use crate::types::EdgePoint;
    use sea_orm::{ColumnTrait, QueryFilter};

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

    #[test]
    fn a_panicking_job_is_reported_and_the_worker_survives() {
        let db = Database::open(":memory:").expect("open");
        let error = db
            .run(|_| -> Result<(), String> { panic!("deliberate job panic") })
            .expect_err("a panicking job must report an error");
        assert!(error.contains("panicked"), "{error}");
        assert_eq!(db.count().expect("count after a panic"), 0);
    }

    #[test]
    fn clear_history_is_ordered_after_an_earlier_job() {
        let db = Database::open(":memory:").expect("open");
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let history = Arc::clone(&db.history);
        let job_db = db.clone();
        let job = std::thread::spawn(move || {
            job_db.run(move |_| {
                started_tx.send(()).expect("signal the job started");
                release_rx.recv().expect("wait for release");
                lock_history(&history)?.push(HistoryEntry::new(
                    vec![HistoryOp::Delete {
                        id: "pending".to_owned(),
                    }],
                    Vec::new(),
                    &HistoryRefs::default(),
                ));
                Ok(())
            })
        });

        started_rx.recv().expect("worker started the job");
        let (clear_started_tx, clear_started_rx) = mpsc::channel();
        let (cleared_tx, cleared_rx) = mpsc::channel();
        let clear_db = db.clone();
        let clear = std::thread::spawn(move || {
            clear_started_tx.send(()).expect("signal clear started");
            let result = clear_db.clear_history();
            let _ = cleared_tx.send(());
            result
        });
        clear_started_rx.recv().expect("clear thread started");
        assert!(
            cleared_rx
                .recv_timeout(std::time::Duration::from_millis(500))
                .is_err(),
            "clear_history must wait for the earlier job"
        );
        release_tx.send(()).expect("release the job");

        job.join().expect("job thread").expect("blocking job");
        clear.join().expect("clear thread").expect("clear history");

        assert!(
            db.history.lock().expect("history").take_undo().is_none(),
            "clear_history must run after the earlier job pushed its entry"
        );
    }

    #[test]
    fn a_poisoned_history_lock_is_reported() {
        let db = Database::open(":memory:").expect("open");
        let history = Arc::clone(&db.history);
        let poisoned = std::thread::spawn(move || {
            let _guard = history.lock().expect("lock history");
            panic!("deliberate history poison");
        });
        assert!(poisoned.join().is_err(), "the helper thread must panic");

        let error = db
            .insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .map(|_| ())
            .expect_err("a poisoned history lock must fail before the write");
        assert!(error.contains("poisoned"), "{error}");
        assert_eq!(db.count().expect("count after a poisoned write"), 0);

        let error = db
            .clear_history()
            .expect_err("a poisoned history lock must report an error");
        assert!(error.contains("poisoned"), "{error}");
        assert_eq!(db.count().expect("count after a poisoned clear"), 0);
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
        let overview = db.overview().expect("overview");
        assert_eq!(
            (
                overview.bounds.x,
                overview.bounds.y,
                overview.bounds.width,
                overview.bounds.height
            ),
            (0.0, 0.0, 0.0, 0.0)
        );
        assert!(overview.cards.is_empty());
    }

    #[test]
    fn bounds_cache_follows_a_move() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .expect("insert");
        let first = db.bounds().expect("bounds");
        assert_eq!((first.x, first.y), (0.0, 0.0));
        // A second read at the same revision reuses the cached entry.
        assert_eq!(db.bounds().expect("cached bounds"), first);

        db.move_nodes(vec!["a".to_owned()], 50.0, 25.0)
            .expect("move");
        // The v1 trigger envelope covers the old and the new rect until
        // compaction; Fit therefore never clips a card that just moved.
        let moved = db.bounds().expect("bounds after move");
        assert_eq!(
            (moved.x, moved.y, moved.width, moved.height),
            (0.0, 0.0, 250.0, 109.0)
        );
        db.compact_bounds().expect("compact bounds");
        let exact = db.bounds().expect("bounds after compaction");
        assert_eq!(
            (exact.x, exact.y, exact.width, exact.height),
            (50.0, 25.0, 200.0, 84.0)
        );
    }

    #[test]
    fn overview_reads_every_card_and_the_document_bounds() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 100.0, 50.0),
            node("b", "B", "", &[], 700.0, 400.0),
        ])
        .expect("insert");

        let overview = db.overview().expect("overview");
        assert_eq!(
            (
                overview.bounds.x,
                overview.bounds.y,
                overview.bounds.width,
                overview.bounds.height
            ),
            (100.0, 50.0, 800.0, 434.0)
        );
        assert!(overview.rev > 0.0);
        let mut ids: Vec<&str> = overview.cards.iter().map(|card| card.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["a", "b"]);
        let card = overview
            .cards
            .iter()
            .find(|card| card.id == "b")
            .expect("card b");
        assert_eq!(
            (card.x, card.y, card.width, card.height),
            (700.0, 400.0, 200.0, 84.0)
        );
    }

    #[test]
    fn overview_sample_stays_capped_on_a_large_document() {
        let db = Database::open(":memory:").expect("open");
        let nodes: Vec<NodeInput> = (0..scene::OVERVIEW_LIMIT + 5)
            .map(|index| {
                let mut input = node(
                    &format!("n{index}"),
                    "Card",
                    "",
                    &[],
                    index as f64 * 10.0,
                    0.0,
                );
                // A raised card must not crowd the sample: order comes from
                // the insertion hash, not from stacking or row order.
                input.z = index as f64;
                input
            })
            .collect();
        db.insert_nodes(nodes).expect("insert");

        let overview = db.overview().expect("overview");
        assert_eq!(overview.cards.len() as u64, scene::OVERVIEW_LIMIT);
        let unique: std::collections::BTreeSet<&str> =
            overview.cards.iter().map(|card| card.id.as_str()).collect();
        assert_eq!(unique.len(), overview.cards.len());
    }

    #[test]
    fn overview_sample_is_neither_the_first_nor_the_top_cards() {
        let db = Database::open(":memory:").expect("open");
        let nodes: Vec<NodeInput> = (0..40)
            .map(|index| {
                let mut input = node(
                    &format!("n{index:02}"),
                    "Card",
                    "",
                    &[],
                    index as f64 * 10.0,
                    0.0,
                );
                input.z = index as f64;
                input
            })
            .collect();
        db.insert_nodes(nodes).expect("insert");

        // The private read with a small cap: the full `overview()` cap is 400
        // and this fixture is smaller.
        let cards = db
            .run(|conn| viewport::overview_cards(conn, 40, 10))
            .expect("sample");
        assert_eq!(cards.len(), 10);
        let mut sampled: Vec<String> = cards.iter().map(|card| card.id.clone()).collect();
        sampled.sort_unstable();
        let first: Vec<String> = (0..10).map(|index| format!("n{index:02}")).collect();
        let top: Vec<String> = (30..40).map(|index| format!("n{index:02}")).collect();
        assert_ne!(sampled, first);
        assert_ne!(sampled, top);
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
                    port_id: "out".to_owned(),
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
        db.insert_nodes(vec![node(
            "a",
            "Old title",
            "Body text",
            &["old"],
            0.0,
            0.0,
        )])
        .expect("insert");

        let changed = db
            .set_node_text(
                "a".to_owned(),
                "New title".to_owned(),
                vec!["new".to_owned()],
            )
            .expect("set text");
        assert_eq!(changed.changes.changed[0].title, "New title");
        assert_eq!(
            changed.changes.changed[0].body, "Body text",
            "a title/tags edit leaves the output-derived body alone"
        );
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
        assert_eq!(
            db.search("Body text".to_owned(), SearchFilters::default(), 20)
                .expect("body search")
                .len(),
            1,
            "the untouched body stays searchable"
        );

        db.undo().expect("undo text");
        assert_eq!(
            db.search("Old title".to_owned(), SearchFilters::default(), 20)
                .expect("restored search")
                .len(),
            1
        );
        assert!(
            db.search("New title".to_owned(), SearchFilters::default(), 20)
                .expect("new title removed")
                .is_empty()
        );
        assert_eq!(
            db.search("Body text".to_owned(), SearchFilters::default(), 20)
                .expect("body search after undo")
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
    fn moving_both_ends_of_a_connector_in_one_command_writes_its_box_once() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        db.set_node_bounds(vec![
            NodeBounds {
                id: "left".to_owned(),
                x: -4_000.0,
                y: 2_000.0,
                width: 200.0,
                height: 84.0,
            },
            NodeBounds {
                id: "right".to_owned(),
                x: 6_000.0,
                y: 2_000.0,
                width: 200.0,
                height: 84.0,
            },
        ])
        .expect("move both ends");

        let scene = db
            .scene(
                Viewport {
                    x: -4_000.0,
                    y: 1_500.0,
                    width: 10_200.0,
                    height: 2_000.0,
                },
                2_000.0,
                viewport::NODE_LIMIT,
            )
            .expect("new-region scene");
        let left = scene
            .nodes
            .iter()
            .find(|node| node.id == "left")
            .expect("the moved left card");
        assert_eq!(
            (left.x, left.y, left.width, left.height),
            (-4_000.0, 2_000.0, 200.0, 84.0)
        );
        let right = scene
            .nodes
            .iter()
            .find(|node| node.id == "right")
            .expect("the moved right card");
        assert_eq!(
            (right.x, right.y, right.width, right.height),
            (6_000.0, 2_000.0, 200.0, 84.0)
        );

        let edges: Vec<_> = scene
            .edges
            .iter()
            .filter(|edge| edge.id == "left-right")
            .collect();
        assert_eq!(edges.len(), 1, "the connector is indexed once");
        assert_eq!(
            edges[0].from_point,
            Some(EdgePoint::output(-4_000.0, 2_000.0, 200.0, 42.0))
        );
        assert_eq!(
            edges[0].to_point,
            Some(EdgePoint::input(6_000.0, 2_000.0, 42.0))
        );

        // The old crossing is gone. Margin 0 keeps the moved cards and the
        // connector's new box out of the read.
        let old = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
        assert!(old.nodes.is_empty());
        assert!(old.edges.iter().all(|edge| edge.id != "left-right"));

        // A box between the new left port and the old right port would cross
        // this band; neither the genuine old nor new box does, and no card
        // touches it, so only the index can return the connector.
        let stale_probe = Viewport {
            x: -3_500.0,
            y: 1_000.0,
            width: 500.0,
            height: 300.0,
        };
        let after = db
            .scene(stale_probe, 0.0, viewport::NODE_LIMIT)
            .expect("stale-endpoint probe");
        assert!(after.nodes.is_empty());
        assert!(after.edges.iter().all(|edge| edge.id != "left-right"));
    }

    #[test]
    fn undo_of_a_two_end_move_restores_both_rtree_boxes() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("left", "Left", "", &[], -5_000.0, 0.0),
            node("right", "Right", "", &[], 5_000.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "left-right", "left", "right");

        db.set_node_bounds(vec![
            NodeBounds {
                id: "left".to_owned(),
                x: -4_000.0,
                y: 2_000.0,
                width: 200.0,
                height: 84.0,
            },
            NodeBounds {
                id: "right".to_owned(),
                x: 6_000.0,
                y: 2_000.0,
                width: 200.0,
                height: 84.0,
            },
        ])
        .expect("move both ends");
        db.undo().expect("undo the two-end move");

        let old = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
        assert!(old.nodes.is_empty(), "both original cards are outside");
        assert_eq!(old.edges.len(), 1, "the original box is indexed again");
        assert_eq!(old.edges[0].id, "left-right");
        assert_eq!(
            old.edges[0].from_point,
            Some(EdgePoint::output(-5_000.0, 0.0, 200.0, 42.0))
        );
        assert_eq!(
            old.edges[0].to_point,
            Some(EdgePoint::input(5_000.0, 0.0, 42.0))
        );

        // The new box is gone. Use the new region without its usual margin:
        // margin 2,000 would include the restored connector at y=42.
        let new_region = scene_between(
            &db,
            -4_000.0,
            1_500.0,
            10_200.0,
            2_000.0,
            viewport::NODE_LIMIT,
        );
        assert!(new_region.edges.iter().all(|edge| edge.id != "left-right"));

        let stale_probe = Viewport {
            x: -3_500.0,
            y: 1_000.0,
            width: 500.0,
            height: 300.0,
        };
        let stale = db
            .scene(stale_probe.clone(), 0.0, viewport::NODE_LIMIT)
            .expect("stale-endpoint probe after undo");
        assert!(stale.nodes.is_empty());
        assert!(stale.edges.iter().all(|edge| edge.id != "left-right"));

        db.redo().expect("redo the two-end move");
        let scene = db
            .scene(
                Viewport {
                    x: -4_000.0,
                    y: 1_500.0,
                    width: 10_200.0,
                    height: 2_000.0,
                },
                2_000.0,
                viewport::NODE_LIMIT,
            )
            .expect("new-region scene after redo");
        let left = scene
            .nodes
            .iter()
            .find(|node| node.id == "left")
            .expect("the redone left card");
        assert_eq!(
            (left.x, left.y, left.width, left.height),
            (-4_000.0, 2_000.0, 200.0, 84.0)
        );
        let right = scene
            .nodes
            .iter()
            .find(|node| node.id == "right")
            .expect("the redone right card");
        assert_eq!(
            (right.x, right.y, right.width, right.height),
            (6_000.0, 2_000.0, 200.0, 84.0)
        );
        let edges: Vec<_> = scene
            .edges
            .iter()
            .filter(|edge| edge.id == "left-right")
            .collect();
        assert_eq!(edges.len(), 1, "the connector is indexed once after redo");
        assert_eq!(
            edges[0].from_point,
            Some(EdgePoint::output(-4_000.0, 2_000.0, 200.0, 42.0))
        );
        assert_eq!(
            edges[0].to_point,
            Some(EdgePoint::input(6_000.0, 2_000.0, 42.0))
        );

        let old_after_redo = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
        assert!(old_after_redo.nodes.is_empty());
        assert!(
            old_after_redo
                .edges
                .iter()
                .all(|edge| edge.id != "left-right")
        );
        let after = db
            .scene(stale_probe, 0.0, viewport::NODE_LIMIT)
            .expect("stale-endpoint probe after redo");
        assert!(after.nodes.is_empty());
        assert!(after.edges.iter().all(|edge| edge.id != "left-right"));
    }

    #[test]
    fn set_node_bounds_change_set_shape_matches_baseline() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![NodeInput {
            id: "styled".to_owned(),
            kind: "image".to_owned(),
            title: "Styled".to_owned(),
            body: "Body".to_owned(),
            tags: vec!["alpha".to_owned(), "β".to_owned()],
            x: 10.0,
            y: 20.0,
            width: 200.0,
            height: 84.0,
            z: 3.5,
            data_json: Some("{\"prompt\":\"a cat\"}".to_owned()),
            settings_json: Some("{\"model\":\"m1\"}".to_owned()),
        }])
        .expect("insert");
        db.save_run(
            ResultBatchInput {
                id: "batch-1".to_owned(),
                node_id: "styled".to_owned(),
                trigger: "run".to_owned(),
                provider: "test".to_owned(),
                model: "m1".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-1".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "Result text".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save run");

        let before = db
            .get_node("styled".to_owned())
            .expect("read before")
            .expect("the node exists");
        let document_rev = db
            .scene(
                Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: 1_000.0,
                    height: 1_000.0,
                },
                0.0,
                viewport::NODE_LIMIT,
            )
            .expect("before scene")
            .rev;
        let read_stored = || {
            db.run(|conn| {
                nodes::Entity::find()
                    .filter(nodes::Column::Id.eq("styled"))
                    .one(conn)
                    .map_err(|error| error.to_string())
            })
            .expect("read stored row")
            .expect("the stored row exists")
        };
        let before_row = read_stored();

        let target = NodeBounds {
            id: "styled".to_owned(),
            x: 100.0,
            y: 200.0,
            width: 300.0,
            height: 120.0,
        };
        let result = db
            .set_node_bounds(vec![target.clone()])
            .expect("move bounds");

        assert_eq!(result.changes.rev, document_rev + 1.0);
        assert_eq!(result.changes.changed.len(), 1);
        let mut expected = before.clone();
        expected.x = target.x;
        expected.y = target.y;
        expected.width = target.width;
        expected.height = target.height;
        expected.rev = before.rev + 1.0;
        assert_eq!(
            result.changes.changed[0], expected,
            "every non-geometry summary field is carried through"
        );

        let [
            HistoryOp::NodeGeometry {
                id,
                x,
                y,
                width,
                height,
            },
        ] = result.forward.as_slice()
        else {
            panic!("one forward NodeGeometry op, got {:?}", result.forward);
        };
        assert_eq!(id.as_str(), "styled");
        assert_eq!(
            (*x, *y, *width, *height),
            (target.x, target.y, target.width, target.height)
        );
        let [
            HistoryOp::NodeGeometry {
                id,
                x,
                y,
                width,
                height,
            },
        ] = result.inverse.as_slice()
        else {
            panic!("one inverse NodeGeometry op, got {:?}", result.inverse);
        };
        assert_eq!(id.as_str(), "styled");
        assert_eq!(
            (*x, *y, *width, *height),
            (before.x, before.y, before.width, before.height)
        );

        let after_row = read_stored();
        assert_eq!(after_row.tags, before_row.tags);
        assert_eq!(after_row.tags, "alpha\nβ");
        assert_eq!(after_row.kind, before_row.kind);
        assert_eq!(after_row.seq, before_row.seq);
        assert_eq!(after_row.created_at, before_row.created_at);
        assert_eq!(after_row.data_json, before_row.data_json);
        assert_eq!(after_row.settings_json, before_row.settings_json);
        assert_eq!(after_row.status, "done");
        assert_eq!(after_row.output_batch_id.as_deref(), Some("batch-1"));
        assert_eq!(
            (after_row.x, after_row.y, after_row.width, after_row.height),
            (target.x, target.y, target.width, target.height)
        );
        assert_eq!(after_row.rev, before_row.rev + 1);
        assert!(after_row.updated_at >= before_row.updated_at);

        let undone = db.undo().expect("undo bounds");
        assert_eq!(undone.changed.len(), 1);
        assert_eq!(undone.rev, result.changes.rev + 1.0);
        assert_eq!(undone.changed[0].rev, before.rev + 2.0);
        assert_eq!(
            (
                undone.changed[0].x,
                undone.changed[0].y,
                undone.changed[0].width,
                undone.changed[0].height
            ),
            (before.x, before.y, before.width, before.height)
        );
        assert_eq!(undone.changed[0].status, before.status);
        assert_eq!(undone.changed[0].output_batch_id, before.output_batch_id);
        let undone_row = read_stored();
        assert_eq!(undone_row.rev, before_row.rev + 2);
        assert!(undone_row.updated_at >= after_row.updated_at);

        let redone = db.redo().expect("redo bounds");
        assert_eq!(redone.changed.len(), 1);
        assert_eq!(redone.rev, undone.rev + 1.0);
        assert_eq!(redone.changed[0].rev, before.rev + 3.0);
        assert_eq!(
            (
                redone.changed[0].x,
                redone.changed[0].y,
                redone.changed[0].width,
                redone.changed[0].height
            ),
            (target.x, target.y, target.width, target.height)
        );
        assert_eq!(redone.changed[0].status, before.status);
        assert_eq!(redone.changed[0].output_batch_id, before.output_batch_id);
        let redone_row = read_stored();
        assert_eq!(redone_row.rev, before_row.rev + 3);
        assert!(redone_row.updated_at >= undone_row.updated_at);
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
            remove_path_retrying(std::path::Path::new(&format!("{path}{suffix}")));
        }
        remove_path_retrying(&dir);
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
    fn deleting_a_node_cascades_its_edges_and_inputs() {
        use sea_orm::{ActiveValue::Set, PaginatorTrait};

        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 300.0, 0.0),
        ])
        .expect("insert nodes");
        test_asset(&db, "asset-local");

        db.run(|conn| {
            edges::Entity::insert(edges::ActiveModel {
                seq: sea_orm::ActiveValue::NotSet,
                id: Set("edge".to_owned()),
                from_id: Set("a".to_owned()),
                to_id: Set("b".to_owned()),
                from_port: Set("out".to_owned()),
                to_port: Set("in".to_owned()),
                port_kind: Set("text".to_owned()),
                from_offset: Set(42.0),
                to_offset: Set(42.0),
                kind: Set("link".to_owned()),
                data_json: Set("{}".to_owned()),
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;
            node_inputs::Entity::insert(node_inputs::ActiveModel {
                id: Set("local-input".to_owned()),
                node_id: Set("b".to_owned()),
                port_id: Set("references".to_owned()),
                position: Set(0),
                kind: Set("image".to_owned()),
                origin: Set("local".to_owned()),
                edge_id: Set(None),
                item_id: Set(None),
                asset_id: Set(Some("asset-local".to_owned())),
                text: Set("local".to_owned()),
                meta_json: Set("{}".to_owned()),
                created_at: Set(0),
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("insert relations");

        db.delete_nodes(vec!["b".to_owned()]).expect("delete node");

        let counts = db
            .run(|conn| {
                let edges = edges::Entity::find()
                    .count(conn)
                    .map_err(|error| error.to_string())?;
                let inputs = node_inputs::Entity::find()
                    .count(conn)
                    .map_err(|error| error.to_string())?;
                Ok((edges, inputs))
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
                    port_id: "out".to_owned(),
                    kind: "text".to_owned(),
                    text: "A lake".to_owned(),
                    asset_id: None,
                    meta_json: None,
                },
                ResultItemInput {
                    id: "item-b".to_owned(),
                    position: 1.0,
                    port_id: "out".to_owned(),
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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

        db.undo().expect("undo input removal");
        let restored = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(restored.inputs.len(), 2);
        assert_eq!(restored.inputs[0].item_id.as_deref(), Some("item-a"));

        db.redo().expect("redo input removal");
        let after_redo = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(after_redo.inputs.len(), 1);

        // A run's input sync clears removals and recreates the snapshots; it
        // is not history, so it invalidates the pending removal entry.
        db.sync_inputs("image".to_owned()).expect("sync after run");
        let undone = db.undo().expect("undo after sync");
        assert!(
            undone.changed.is_empty(),
            "sync invalidates the input removal entry"
        );
        let restored = db
            .node_detail("image".to_owned())
            .expect("detail")
            .expect("image detail");
        assert_eq!(restored.inputs.len(), 2);
    }

    #[test]
    fn input_restores_tolerate_a_missing_or_existing_row() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        test_asset(&db, "asset-input");
        let row = crate::history::InputRow {
            id: "input-1".to_owned(),
            node_id: "n".to_owned(),
            position: 0,
            port_id: "out".to_owned(),
            kind: "image".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: Some("asset-input".to_owned()),
            text: "one".to_owned(),
            meta_json: "{}".to_owned(),
            created_at: 0,
        };

        db.apply_ops(&[HistoryOp::InsertInput(row.clone())])
            .expect("insert the input");
        db.apply_ops(&[HistoryOp::InsertInput(row.clone())])
            .expect("an existing input is tolerated");
        let inputs = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail")
            .inputs;
        assert_eq!(inputs.len(), 1);

        db.apply_ops(&[HistoryOp::DeleteInput {
            id: "missing".to_owned(),
        }])
        .expect("a missing input is tolerated");
        db.apply_ops(&[HistoryOp::DeleteInput { id: row.id }])
            .expect("delete the input");
        assert!(
            db.node_detail("n".to_owned())
                .expect("detail")
                .expect("node detail")
                .inputs
                .is_empty()
        );
    }

    #[test]
    fn snapshots_only_the_connected_output_port_and_reports_incoming_edges() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("image", "Image", "", &[], 0.0, 0.0),
            node("target", "Target", "", &[], 400.0, 0.0),
        ])
        .expect("insert nodes");
        test_asset(&db, "asset-image");

        // One batch, two output ports: only the connected port's items may
        // snapshot into the target.
        db.save_run(
            ResultBatchInput {
                id: "batch-image".to_owned(),
                node_id: "image".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![
                ResultItemInput {
                    id: "item-image".to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-image".to_owned()),
                    meta_json: None,
                },
                ResultItemInput {
                    id: "item-text".to_owned(),
                    position: 1.0,
                    port_id: "text".to_owned(),
                    kind: "text".to_owned(),
                    text: "sidecar".to_owned(),
                    asset_id: None,
                    meta_json: None,
                },
            ],
        )
        .expect("save source batch");

        db.connect_edge(EdgeInput {
            id: "edge-image".to_owned(),
            from_id: "image".to_owned(),
            to_id: "target".to_owned(),
            from_port: "image".to_owned(),
            to_port: "references".to_owned(),
            port_kind: "image".to_owned(),
            from_offset: 28.0,
            to_offset: 56.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        let detail = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(detail.inputs.len(), 1, "only the image port snapshots");
        assert_eq!(detail.inputs[0].item_id.as_deref(), Some("item-image"));
        assert_eq!(detail.inputs[0].port_id, "references");
        assert_eq!(detail.inputs[0].edge_id.as_deref(), Some("edge-image"));
        assert_eq!(detail.incoming.len(), 1);
        assert_eq!(detail.incoming[0].port_id, "references");
        assert_eq!(detail.incoming[0].edges, 1.0);

        // A source whose new batch has nothing on the connected port leaves
        // no rows, but the connector still occupies the port's slot: capacity
        // counts edges, not rows.
        db.save_run(
            ResultBatchInput {
                id: "batch-empty".to_owned(),
                node_id: "image".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-image".to_owned(),
                model: "mock-image".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-other".to_owned(),
                position: 0.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "sidecar".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("batch without the connected port");
        db.sync_inputs("target".to_owned()).expect("sync");
        let after = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(after.inputs.len(), 0);
        assert_eq!(after.incoming.len(), 1);
        assert_eq!(after.incoming[0].edges, 1.0);
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
                port_id: "out".to_owned(),
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");
        test_asset(&db, "asset-local");
        db.add_input(InputItemInput {
            id: "local".to_owned(),
            node_id: "image".to_owned(),
            port_id: "in".to_owned(),
            kind: "image".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: Some("asset-local".to_owned()),
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
                port_id: "out".to_owned(),
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
                port_id: "out".to_owned(),
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
                    port_id: "out".to_owned(),
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
    fn an_upload_writes_its_ports_and_output_in_one_undoable_step() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
        db.insert_nodes(vec![upload]).expect("insert");
        test_asset(&db, "asset-cat");

        let changes = db
            .set_manual_upload(
                "upload".to_owned(),
                r#"{"version":1,"media":["image"]}"#.to_owned(),
                "cat.png".to_owned(),
                ResultBatchInput {
                    id: "batch-upload".to_owned(),
                    node_id: "upload".to_owned(),
                    trigger: "upload".to_owned(),
                    provider: "local".to_owned(),
                    model: String::new(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                vec![ResultItemInput {
                    id: "item-upload".to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-cat".to_owned()),
                    meta_json: Some(r#"{"width":2,"height":1}"#.to_owned()),
                }],
                Some(NodeBounds {
                    id: "upload".to_owned(),
                    x: -10.0,
                    y: 30.0,
                    width: 320.0,
                    height: 160.0,
                }),
            )
            .expect("upload");
        let changed = &changes.changes.changed[0];
        assert_eq!(changed.settings_json, r#"{"version":1,"media":["image"]}"#);
        assert_eq!(changed.body, "cat.png");
        assert_eq!(changed.status, "done");
        assert_eq!((changed.width, changed.height), (320.0, 160.0));

        let detail = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        let batch = detail.batch.expect("batch");
        assert_eq!(batch.id, "batch-upload");
        assert_eq!(batch.items[0].port_id, "image");
        assert_eq!(batch.items[0].asset_id.as_deref(), Some("asset-cat"));
        assert_eq!(
            db.search("cat".to_owned(), SearchFilters::default(), 20)
                .expect("search")
                .len(),
            1
        );

        db.undo().expect("undo upload");
        let restored = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        assert_eq!(restored.node.settings_json, r#"{"version":1,"media":[]}"#);
        assert_eq!(restored.node.body, "");
        assert_eq!(restored.node.output_batch_id, None);
        // The same undo also restores the rectangle the upload fitted.
        assert_eq!(
            (
                restored.node.x,
                restored.node.y,
                restored.node.width,
                restored.node.height
            ),
            (0.0, 0.0, 200.0, 84.0)
        );

        db.redo().expect("redo upload");
        let again = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        assert_eq!(
            again.node.settings_json,
            r#"{"version":1,"media":["image"]}"#
        );
        assert_eq!(again.node.output_batch_id.as_deref(), Some("batch-upload"));
    }

    #[test]
    fn an_intervening_settings_edit_does_not_block_an_upload_undo() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some("{}".to_owned());
        db.insert_nodes(vec![upload]).expect("insert");
        test_asset(&db, "asset-cat");
        db.set_manual_upload(
            "upload".to_owned(),
            r#"{"version":1,"media":["image"]}"#.to_owned(),
            "cat.png".to_owned(),
            ResultBatchInput {
                id: "batch-upload".to_owned(),
                node_id: "upload".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-upload".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-cat".to_owned()),
                meta_json: None,
            }],
            Some(NodeBounds {
                id: "upload".to_owned(),
                x: 40.0,
                y: 10.0,
                width: 320.0,
                height: 160.0,
            }),
        )
        .expect("upload");
        db.set_node_settings(
            "upload".to_owned(),
            r#"{"version":1,"media":["image"],"edited":true}"#.to_owned(),
            Some(vec!["image".to_owned()]),
        )
        .expect("settings");
        // Undoing the settings edit restores settings but leaves the stale
        // marker; the upload's batch and body are unchanged, so its undo must
        // still apply as one whole entry.
        db.undo().expect("undo settings");
        db.undo().expect("undo upload");

        let detail = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        assert_eq!(detail.node.settings_json, "{}");
        assert_eq!(detail.node.body, "");
        assert_eq!(detail.node.output_batch_id, None);
        assert_eq!(detail.node.status, "idle");
        assert_eq!(
            (
                detail.node.x,
                detail.node.y,
                detail.node.width,
                detail.node.height
            ),
            (0.0, 0.0, 200.0, 84.0)
        );
    }

    #[test]
    fn a_second_upload_replaces_and_undoes_the_first_output() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
        db.insert_nodes(vec![upload]).expect("insert");
        test_asset(&db, "asset-cat");
        test_asset(&db, "asset-dog");

        let upload = |batch_id: &str,
                      item_id: &str,
                      asset_id: &str,
                      settings: &str,
                      body: &str,
                      x: f64,
                      width: f64| {
            db.set_manual_upload(
                "upload".to_owned(),
                settings.to_owned(),
                body.to_owned(),
                ResultBatchInput {
                    id: batch_id.to_owned(),
                    node_id: "upload".to_owned(),
                    trigger: "upload".to_owned(),
                    provider: "local".to_owned(),
                    model: String::new(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                vec![ResultItemInput {
                    id: item_id.to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some(asset_id.to_owned()),
                    meta_json: None,
                }],
                Some(NodeBounds {
                    id: "upload".to_owned(),
                    x,
                    y: 0.0,
                    width,
                    height: 160.0,
                }),
            )
            .expect("upload")
        };

        upload(
            "batch-1",
            "item-1",
            "asset-cat",
            r#"{"version":1,"media":["image"]}"#,
            "cat.png",
            0.0,
            320.0,
        );
        upload(
            "batch-2",
            "item-2",
            "asset-dog",
            r#"{"version":1,"media":["image","video"]}"#,
            "dog.png",
            40.0,
            400.0,
        );

        db.undo().expect("undo the second upload");
        let first = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        assert_eq!(
            first.node.settings_json,
            r#"{"version":1,"media":["image"]}"#
        );
        assert_eq!(first.node.body, "cat.png");
        assert_eq!(first.node.output_batch_id.as_deref(), Some("batch-1"));
        assert_eq!(first.node.status, "done");
        assert_eq!((first.node.x, first.node.width), (0.0, 320.0));

        db.redo().expect("redo the second upload");
        let second = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        assert_eq!(
            second.node.settings_json,
            r#"{"version":1,"media":["image","video"]}"#
        );
        assert_eq!(second.node.body, "dog.png");
        assert_eq!(second.node.output_batch_id.as_deref(), Some("batch-2"));
        assert_eq!(second.node.status, "done");
        assert_eq!((second.node.x, second.node.width), (40.0, 400.0));
    }

    #[test]
    fn copies_an_upload_in_one_undoable_step() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("copy", "Upload", "cat.png", &["upload"], 24.0, 24.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some(r#"{"version":1,"media":["image"]}"#.to_owned());
        test_asset(&db, "asset-cat");
        db.insert_upload_node(
            upload,
            ResultBatchInput {
                id: "batch-copy".to_owned(),
                node_id: "copy".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-copy".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-cat".to_owned()),
                meta_json: Some(r#"{"width":2,"height":1}"#.to_owned()),
            }],
        )
        .expect("copy");

        let copy = db
            .node_detail("copy".to_owned())
            .expect("detail")
            .expect("copy detail");
        assert_eq!(copy.node.status, "done");
        assert_eq!(copy.node.output_batch_id.as_deref(), Some("batch-copy"));
        assert_eq!(copy.batch.expect("batch").items.len(), 1);

        // One undo removes the whole copy, output included.
        db.undo().expect("undo copy");
        assert_eq!(db.get_node("copy".to_owned()).expect("get"), None);

        // Redo puts the card back with its output, not empty.
        db.redo().expect("redo copy");
        let again = db
            .node_detail("copy".to_owned())
            .expect("detail")
            .expect("copy detail");
        assert_eq!(again.node.output_batch_id.as_deref(), Some("batch-copy"));
        assert_eq!(again.batch.expect("batch").items.len(), 1);
    }

    #[test]
    fn undoing_an_upload_restores_its_edge_anchors() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
        db.insert_nodes(vec![upload, node("target", "Target", "", &[], 400.0, 0.0)])
            .expect("insert");
        test_asset(&db, "asset-cat");
        db.connect_edge(EdgeInput {
            id: "edge-upload".to_owned(),
            from_id: "upload".to_owned(),
            to_id: "target".to_owned(),
            from_port: "image".to_owned(),
            to_port: "references".to_owned(),
            port_kind: "image".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("edge");

        db.set_manual_upload(
            "upload".to_owned(),
            r#"{"version":1,"media":["image"]}"#.to_owned(),
            "cat.png".to_owned(),
            ResultBatchInput {
                id: "batch-upload".to_owned(),
                node_id: "upload".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-upload".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-cat".to_owned()),
                meta_json: None,
            }],
            Some(NodeBounds {
                id: "upload".to_owned(),
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 160.0,
            }),
        )
        .expect("upload");

        // 84 → 160 scales the connector anchor by 160/84.
        let grown = db
            .scene(
                Viewport {
                    x: -100.0,
                    y: -100.0,
                    width: 1000.0,
                    height: 1000.0,
                },
                0.0,
                100,
            )
            .expect("scene");
        let edge = grown
            .edges
            .iter()
            .find(|edge| edge.id == "edge-upload")
            .expect("the connector was indexed");
        assert!((edge.from_offset - 80.0).abs() < 0.001);

        db.undo().expect("undo upload");
        let restored = db
            .scene(
                Viewport {
                    x: -100.0,
                    y: -100.0,
                    width: 1000.0,
                    height: 1000.0,
                },
                0.0,
                100,
            )
            .expect("scene");
        let edge = restored
            .edges
            .iter()
            .find(|edge| edge.id == "edge-upload")
            .expect("the connector is still indexed");
        assert!((edge.from_offset - 42.0).abs() < 0.001);

        db.redo().expect("redo upload");
        let again = db
            .scene(
                Viewport {
                    x: -100.0,
                    y: -100.0,
                    width: 1000.0,
                    height: 1000.0,
                },
                0.0,
                100,
            )
            .expect("scene");
        let edge = again
            .edges
            .iter()
            .find(|edge| edge.id == "edge-upload")
            .expect("the connector is indexed after redo");
        assert!((edge.from_offset - 80.0).abs() < 0.001);
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
                port_id: "out".to_owned(),
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
                port_id: "out".to_owned(),
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
        let dir =
            std::env::temp_dir().join(format!("flow assets {} {}", std::process::id(), now_ms()));
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
        std::fs::write(db.assets_dir.join(&asset.hash), b"broken")
            .expect("tamper the stored bytes");

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
    fn a_no_op_move_settings_and_reorder_do_not_touch_history_or_the_rev() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, text) in [("one", "One"), ("two", "Two")] {
            test_asset(&db, &format!("asset-{id}"));
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                port_id: "out".to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(format!("asset-{id}")),
                text: text.to_owned(),
                meta_json: None,
            })
            .expect("add input");
        }
        db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
            .expect("settings");
        let setup_ids: Vec<String> = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail")
            .inputs
            .iter()
            .map(|input| input.id.clone())
            .collect();
        db.reorder_inputs("n".to_owned(), setup_ids)
            .expect("normalise input positions");
        db.clear_history().expect("clear setup history");
        let before = current_rev(&db);

        let moved = db
            .move_nodes(vec!["n".to_owned()], 0.0, 0.0)
            .expect("no-op move");
        assert!(moved.forward.is_empty());
        assert!(moved.changes.changed.is_empty());
        assert_eq!(moved.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);
        assert!(db.undo().expect("undo no-op move").changed.is_empty());
        assert_eq!(current_rev(&db), before);

        let current = db
            .get_node("n".to_owned())
            .expect("get node")
            .expect("node");
        let bounds = db
            .set_node_bounds(vec![NodeBounds {
                id: "n".to_owned(),
                x: current.x,
                y: current.y,
                width: current.width,
                height: current.height,
            }])
            .expect("no-op bounds");
        assert!(bounds.forward.is_empty());
        assert_eq!(bounds.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);

        let settings = db
            .set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
            .expect("no-op settings");
        assert!(settings.forward.is_empty());
        assert_eq!(settings.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);

        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        let ids: Vec<String> = detail.inputs.iter().map(|input| input.id.clone()).collect();
        let reordered = db
            .reorder_inputs("n".to_owned(), ids)
            .expect("no-op reorder");
        assert!(reordered.forward.is_empty());
        assert_eq!(reordered.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);

        for mutation in [
            db.set_node_text("n".to_owned(), "N".to_owned(), Vec::new())
                .expect("no-op text"),
            db.insert_nodes(Vec::new()).expect("no-op insert nodes"),
            db.insert_edges(Vec::new()).expect("no-op insert edges"),
            db.connect_edges(Vec::new()).expect("no-op connect edges"),
            db.delete_nodes(Vec::new()).expect("no-op delete nodes"),
            db.delete_edges(Vec::new()).expect("no-op delete edges"),
        ] {
            assert!(mutation.forward.is_empty());
            assert_eq!(mutation.changes.rev, before as f64);
            assert_eq!(current_rev(&db), before);
        }

        assert!(db.undo().expect("nothing left to undo").changed.is_empty());
        assert_eq!(current_rev(&db), before);
    }

    #[test]
    fn a_batch_change_skips_a_manual_text_entry() {
        let db = manual_text_db();
        // A writer that bypasses history replaces the output pointer. The
        // guarded entry must be dropped, not restore the manual snapshot.
        direct_write(
            &db,
            "UPDATE nodes SET output_batch_id = NULL, status = 'idle' WHERE id = 'n'",
        );
        let before = current_rev(&db);

        let undone = db.undo().expect("undo the stale entry");
        assert!(undone.changed.is_empty());
        assert_eq!(undone.rev, before as f64);
        assert_eq!(current_rev(&db), before);
        assert!(
            db.history.lock().expect("history").take_redo().is_none(),
            "a stale entry is dropped, not left on the redo stack"
        );
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.body, "after");
        assert_eq!(detail.node.output_batch_id, None);
    }

    #[test]
    fn a_body_change_skips_a_manual_text_entry() {
        let db = manual_text_db();
        direct_write(&db, "UPDATE nodes SET body = 'other' WHERE id = 'n'");
        let before = current_rev(&db);

        let undone = db.undo().expect("undo the stale entry");
        assert!(undone.changed.is_empty());
        assert_eq!(undone.rev, before as f64);
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.body, "other");
        assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-manual"));
    }

    #[test]
    fn a_status_only_change_does_not_skip_a_manual_text_entry() {
        let db = manual_text_db();
        // Undoable input/settings edits mark a node stale without replacing
        // its output; that alone must not block an older output undo.
        direct_write(&db, "UPDATE nodes SET status = 'stale' WHERE id = 'n'");

        let undone = db.undo().expect("undo the manual entry");
        assert_eq!(undone.changed.len(), 1);
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.body, "before");
        assert_eq!(detail.node.output_batch_id, None);
        assert_eq!(detail.node.status, "idle");
    }

    #[test]
    fn a_colliding_edge_restore_is_stale_instead_of_wedging_undo() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("t", "T", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        db.clear_history().expect("clear insert history");
        connect(&db, "e1", "a", "t");
        db.delete_edges(vec!["e1".to_owned()]).expect("delete e1");
        connect(&db, "e2", "a", "t");

        // Simulate invalidation removing the entry that created e2 while the
        // edge itself survives; restoring e1 would collide on its port pair.
        let removed = db
            .history
            .lock()
            .expect("history")
            .take_undo()
            .expect("e2 connect entry");
        assert!(matches!(
            removed.forward.first(),
            Some(HistoryOp::InsertEdge(_))
        ));

        let undone = db.undo().expect("a colliding restore is stale");
        assert!(undone.changed.is_empty());
        assert_eq!(db.edge_count().expect("edge count"), 1);
    }

    #[test]
    fn a_same_pair_reconnect_undoes_and_redoes() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("t", "T", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        connect(&db, "e1", "a", "t");
        db.update_edge(EdgeInput {
            id: "e1".to_owned(),
            from_id: "a".to_owned(),
            to_id: "t".to_owned(),
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 50.0,
            to_offset: 50.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("reconnect the same pair");
        let offset = || {
            db.run(|conn| {
                edges::Entity::find()
                    .filter(edges::Column::Id.eq("e1"))
                    .one(conn)
                    .map_err(|error| error.to_string())
            })
            .expect("read edge")
            .expect("edge exists")
            .from_offset
        };
        assert_eq!(offset(), 50.0);

        db.undo().expect("undo the same-pair reconnect");
        assert_eq!(offset(), 42.0);
        db.redo().expect("redo the same-pair reconnect");
        assert_eq!(offset(), 50.0);
    }

    #[test]
    fn a_colliding_reconnect_restore_is_stale() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("t", "T", "", &[], 400.0, 0.0),
            node("t2", "T2", "", &[], 800.0, 0.0),
        ])
        .expect("insert");
        db.clear_history().expect("clear insert history");
        connect(&db, "e1", "a", "t");
        db.update_edge(EdgeInput {
            id: "e1".to_owned(),
            from_id: "a".to_owned(),
            to_id: "t2".to_owned(),
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("reconnect to t2");
        connect(&db, "e3", "a", "t");

        // Simulate invalidation dropping the e3 connect entry while e3
        // survives; restoring e1's old pair would collide with e3.
        let removed = db
            .history
            .lock()
            .expect("history")
            .take_undo()
            .expect("e3 connect entry");
        assert!(matches!(
            removed.forward.first(),
            Some(HistoryOp::InsertEdge(_))
        ));

        let undone = db.undo().expect("a colliding reconnect restore is stale");
        assert!(undone.changed.is_empty());
        let edge = db
            .run(|conn| {
                edges::Entity::find()
                    .filter(edges::Column::Id.eq("e1"))
                    .one(conn)
                    .map_err(|error| error.to_string())
            })
            .expect("read e1")
            .expect("e1 exists");
        assert_eq!(edge.to_id, "t2");
        assert_eq!(db.edge_count().expect("edge count"), 2);
    }

    #[test]
    fn undoing_a_node_insert_cleans_edge_inputs_on_survivors() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("a", "A", "before", &[], 0.0, 0.0)])
            .expect("insert a");
        db.insert_nodes(vec![node("t", "T", "", &[], 400.0, 0.0)])
            .expect("insert t");
        test_asset(&db, "asset-local-t");
        db.add_input(InputItemInput {
            id: "local-t".to_owned(),
            node_id: "t".to_owned(),
            port_id: "out".to_owned(),
            kind: "image".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: Some("asset-local-t".to_owned()),
            text: "local".to_owned(),
            meta_json: None,
        })
        .expect("add a local input");
        db.set_manual_text(
            "a".to_owned(),
            "A output".to_owned(),
            ResultBatchInput {
                id: "batch-a".to_owned(),
                node_id: "a".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            ResultItemInput {
                id: "item-a".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "A output".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        )
        .expect("manual output");
        connect(&db, "a-t", "a", "t");
        db.save_run(
            ResultBatchInput {
                id: "batch-t".to_owned(),
                node_id: "t".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-t".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "T output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run t");

        // The run invalidated the connect entry, so undoing the manual output
        // and then the insert is the path that must clean T's snapshot.
        db.undo().expect("undo the manual output");
        let undone = db.undo().expect("undo the insert");
        assert!(
            undone.changed.iter().any(|row| row.id == "t"),
            "the survivor's touched summary is in the change set"
        );
        assert_eq!(db.get_node("a".to_owned()).expect("get a"), None);
        let target = db
            .node_detail("t".to_owned())
            .expect("detail")
            .expect("t detail");
        let input_ids: Vec<&str> = target
            .inputs
            .iter()
            .map(|input| input.id.as_str())
            .collect();
        assert_eq!(
            input_ids,
            ["local-t"],
            "only the deleted node's edge snapshot is removed; local inputs survive"
        );
    }

    #[test]
    fn a_missing_subject_drops_a_stale_entry_instead_of_wedging_undo() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert n");
        db.insert_nodes(vec![node("x", "X", "", &[], 400.0, 0.0)])
            .expect("insert x");
        connect(&db, "n-x", "n", "x");
        db.delete_nodes(vec!["n".to_owned()]).expect("delete n");
        db.save_run(
            ResultBatchInput {
                id: "batch-x".to_owned(),
                node_id: "x".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-x".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "x".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run x");

        // The run invalidated the delete and connect entries; only the older
        // insert-n entry remains, and its subject is gone. It must be dropped
        // instead of failing and blocking every later undo.
        let undone = db.undo().expect("undo the stale insert");
        assert!(undone.changed.is_empty());
        assert_eq!(db.count().expect("count"), 1);
        let again = db.undo().expect("undo after the drop");
        assert!(again.changed.is_empty());
        assert_eq!(db.count().expect("count after the second undo"), 1);
    }

    #[test]
    fn undoing_a_source_output_marks_downstream_stale() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("source", "Source", "", &[], 0.0, 0.0),
            node("target", "Target", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        db.save_run(
            ResultBatchInput {
                id: "batch-source".to_owned(),
                node_id: "source".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-source".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "source output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("source batch");
        connect(&db, "source-target", "source", "target");
        db.save_run(
            ResultBatchInput {
                id: "batch-target".to_owned(),
                node_id: "target".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-target".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "target output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("target batch");
        db.set_manual_text(
            "source".to_owned(),
            "manual source".to_owned(),
            ResultBatchInput {
                id: "batch-manual".to_owned(),
                node_id: "source".to_owned(),
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
                text: "manual source".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        )
        .expect("manual source");
        // Rerun the target after the manual edit so it is done again; the
        // manual entry is on the source, so the target run leaves it pending.
        db.save_run(
            ResultBatchInput {
                id: "batch-target-two".to_owned(),
                node_id: "target".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-target-two".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "target again".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("target rerun");

        let undone = db.undo().expect("undo the manual source output");
        assert!(
            undone
                .changed
                .iter()
                .any(|row| row.id == "target" && row.status == "stale"),
            "the change set carries the downstream stale row"
        );
        let source = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(source.node.output_batch_id.as_deref(), Some("batch-source"));
        let target = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(
            target.node.status, "stale",
            "reverting the source output invalidates the target snapshot"
        );
        assert_eq!(
            target.node.output_batch_id.as_deref(),
            Some("batch-target-two")
        );
    }

    #[test]
    fn a_redo_after_a_body_change_is_skipped() {
        let db = manual_text_db();
        db.undo().expect("undo the manual entry");
        direct_write(&db, "UPDATE nodes SET body = 'other' WHERE id = 'n'");
        let before = current_rev(&db);

        let redone = db.redo().expect("redo the stale entry");
        assert!(redone.changed.is_empty());
        assert_eq!(redone.rev, before as f64);
        assert_eq!(current_rev(&db), before);
        let top = db
            .history
            .lock()
            .expect("history")
            .take_undo()
            .expect("the insert entry remains");
        assert!(
            matches!(top.forward.as_slice(), [HistoryOp::Insert(_)]),
            "a stale redo entry is dropped, not returned to undo"
        );
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.body, "other");
        assert_eq!(detail.node.output_batch_id, None);
    }

    #[test]
    fn a_stale_upload_entry_applies_nothing() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some("{}".to_owned());
        db.insert_nodes(vec![upload]).expect("insert");
        test_asset(&db, "asset-cat");
        db.set_manual_upload(
            "upload".to_owned(),
            r#"{"version":1,"media":["image"]}"#.to_owned(),
            "cat.png".to_owned(),
            ResultBatchInput {
                id: "batch-upload".to_owned(),
                node_id: "upload".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-upload".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-cat".to_owned()),
                meta_json: None,
            }],
            Some(NodeBounds {
                id: "upload".to_owned(),
                x: 40.0,
                y: 10.0,
                width: 320.0,
                height: 160.0,
            }),
        )
        .expect("upload");
        direct_write(
            &db,
            "UPDATE nodes SET output_batch_id = NULL, status = 'idle' WHERE id = 'upload'",
        );
        let before = current_rev(&db);

        let undone = db.undo().expect("undo the stale upload");
        assert!(undone.changed.is_empty());
        assert_eq!(undone.rev, before as f64);
        assert_eq!(current_rev(&db), before);
        assert!(db.history.lock().expect("history").take_redo().is_none());
        let detail = db
            .node_detail("upload".to_owned())
            .expect("detail")
            .expect("upload detail");
        // No settings or geometry half-apply: the whole entry was skipped.
        assert_eq!(
            detail.node.settings_json,
            r#"{"version":1,"media":["image"]}"#
        );
        assert_eq!(
            (
                detail.node.x,
                detail.node.y,
                detail.node.width,
                detail.node.height
            ),
            (40.0, 10.0, 320.0, 160.0)
        );
        assert_eq!(detail.node.body, "cat.png");
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
    fn a_downstream_sync_keeps_an_upstream_move_entry() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("source", "Source", "A lake", &[], 0.0, 0.0),
            node("target", "Target", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        db.save_run(
            ResultBatchInput {
                id: "batch-source".to_owned(),
                node_id: "source".to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-source".to_owned(),
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

        db.move_nodes(vec!["source".to_owned()], 10.0, 0.0)
            .expect("move source");
        db.sync_inputs("target".to_owned()).expect("sync target");

        let undone = db.undo().expect("undo the source move");
        assert_eq!(undone.changed.len(), 1);
        let source = db
            .get_node("source".to_owned())
            .expect("get source")
            .expect("source");
        assert_eq!(source.x, 0.0, "the upstream move survives a target sync");
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
    fn a_redo_of_settings_marks_an_existing_output_stale() {
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
        db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
            .expect("settings");

        db.undo().expect("undo settings");
        db.undo().expect("undo manual output");
        db.redo().expect("redo manual output");
        db.redo().expect("redo settings");

        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.settings_json, "{\"a\":1}");
        assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-manual"));
        assert_eq!(
            detail.node.status, "stale",
            "a redone settings change invalidates an existing output"
        );
    }

    #[test]
    fn a_settings_edit_undoes_and_redoes() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
            .expect("settings");

        db.undo().expect("undo settings");
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.settings_json, "{}");
        assert_eq!(detail.node.status, "idle");

        db.redo().expect("redo settings");
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(detail.node.settings_json, "{\"a\":1}");
    }

    #[test]
    fn removing_an_output_port_removes_its_edge_and_undo_restores_both() {
        let db = Database::open(":memory:").expect("open");
        upload_with_edge_to_target(&db);
        assert_eq!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .len(),
            1
        );
        db.clear_history().expect("clear setup history");

        let changes = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"media":[]}"#.to_owned(),
                Some(Vec::new()),
            )
            .expect("remove the output port");
        assert_eq!(
            changes.changes.edges_removed,
            vec!["edge-source".to_owned()]
        );
        assert!(scene_edge_ids(&db).is_empty());
        assert!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );

        db.undo().expect("undo the settings edit");
        let restored = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            restored.node.settings_json,
            r#"{"version":1,"media":["image"]}"#
        );
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        let target = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(target.inputs.len(), 1);
        let input = &target.inputs[0];
        assert_eq!(input.edge_id.as_deref(), Some("edge-source"));
        assert_eq!(input.item_id.as_deref(), Some("item-first"));
        assert_eq!(input.asset_id.as_deref(), Some("asset-cat"));
        assert_eq!(input.port_id, "references");

        db.redo().expect("redo the settings edit");
        assert!(scene_edge_ids(&db).is_empty());
        assert!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );
    }

    #[test]
    fn removing_an_input_port_removes_the_incoming_edge_and_undo_restores_it() {
        let db = Database::open(":memory:").expect("open");
        text_target_with_incoming_edge(&db);
        db.clear_history().expect("clear setup history");

        let changes = db
            .set_node_settings(
                "target".to_owned(),
                r#"{"version":1,"prompt":"changed"}"#.to_owned(),
                Some(vec!["references".to_owned(), "text".to_owned()]),
            )
            .expect("remove the input port");
        assert_eq!(
            changes.changes.edges_removed,
            vec!["edge-target".to_owned()]
        );
        assert!(scene_edge_ids(&db).is_empty());
        assert!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );

        db.undo().expect("undo the settings edit");
        assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
        let restored = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(restored.node.settings_json, "{}");
        assert_eq!(restored.inputs.len(), 1);
        let input = &restored.inputs[0];
        assert_eq!(input.edge_id.as_deref(), Some("edge-target"));
        assert_eq!(input.item_id.as_deref(), Some("item-source"));
        assert_eq!(input.asset_id, None);
        assert_eq!(input.text, "hello");
        assert_eq!(input.port_id, "prompt");

        db.redo().expect("redo the settings edit");
        assert!(scene_edge_ids(&db).is_empty());
    }

    #[test]
    fn a_settings_change_that_keeps_its_ports_keeps_the_edges() {
        let db = Database::open(":memory:").expect("open");
        text_target_with_incoming_edge(&db);
        db.clear_history().expect("clear setup history");
        let before = current_rev(&db);

        let changes = db
            .set_node_settings(
                "target".to_owned(),
                r#"{"version":1,"prompt":"changed"}"#.to_owned(),
                Some(vec![
                    "prompt".to_owned(),
                    "references".to_owned(),
                    "text".to_owned(),
                ]),
            )
            .expect("valid settings change");
        assert_eq!(
            changes.changes.changed[0].settings_json,
            r#"{"version":1,"prompt":"changed"}"#
        );
        assert!(changes.forward.iter().any(|op| matches!(
            op,
            HistoryOp::NodeSettings {
                id,
                mark_stale: true,
                ..
            } if id == "target"
        )));
        assert_eq!(current_rev(&db), before + 1);
        assert!(changes.changes.edges_removed.is_empty());
        assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
        assert_eq!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .len(),
            1
        );

        db.undo().expect("undo the valid change");
        assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
    }

    #[test]
    fn a_no_op_settings_change_keeps_edges_even_with_no_valid_ports() {
        let db = Database::open(":memory:").expect("open");
        text_target_with_incoming_edge(&db);
        db.set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec![
                "prompt".to_owned(),
                "references".to_owned(),
                "text".to_owned(),
            ]),
        )
        .expect("settings");
        db.clear_history().expect("clear setup history");
        let before = current_rev(&db);

        let no_op = db
            .set_node_settings(
                "target".to_owned(),
                r#"{"version":1,"prompt":"changed"}"#.to_owned(),
                Some(Vec::new()),
            )
            .expect("no-op settings");
        assert!(no_op.forward.is_empty());
        assert_eq!(no_op.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);
        assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
    }

    #[test]
    fn replacing_an_upload_drops_an_edge_whose_output_port_is_gone() {
        let db = Database::open(":memory:").expect("open");
        upload_with_edge_to_target(&db);
        test_asset(&db, "asset-clip");
        db.clear_history().expect("clear setup history");

        let changes = db
            .set_manual_upload(
                "source".to_owned(),
                r#"{"version":1,"media":["video"]}"#.to_owned(),
                "clip.mp4".to_owned(),
                ResultBatchInput {
                    id: "batch-second".to_owned(),
                    node_id: "source".to_owned(),
                    trigger: "upload".to_owned(),
                    provider: "local".to_owned(),
                    model: String::new(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                vec![ResultItemInput {
                    id: "item-second".to_owned(),
                    position: 0.0,
                    port_id: "video".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-clip".to_owned()),
                    meta_json: None,
                }],
                None,
            )
            .expect("replace the upload");
        assert_eq!(
            changes.changes.edges_removed,
            vec!["edge-source".to_owned()]
        );
        assert!(scene_edge_ids(&db).is_empty());
        let replaced = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            replaced.node.settings_json,
            r#"{"version":1,"media":["video"]}"#
        );
        assert_eq!(
            replaced.node.output_batch_id.as_deref(),
            Some("batch-second")
        );
        assert!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );

        db.undo().expect("undo the replacement");
        let restored = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            restored.node.settings_json,
            r#"{"version":1,"media":["image"]}"#
        );
        assert_eq!(
            restored.node.output_batch_id.as_deref(),
            Some("batch-first")
        );
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        let target = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(target.inputs.len(), 1);
        let input = &target.inputs[0];
        assert_eq!(input.edge_id.as_deref(), Some("edge-source"));
        assert_eq!(input.item_id.as_deref(), Some("item-first"));
        assert_eq!(input.asset_id.as_deref(), Some("asset-cat"));
        assert_eq!(input.port_id, "references");

        db.redo().expect("redo the replacement");
        assert!(scene_edge_ids(&db).is_empty());
        let redone = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            redone.node.settings_json,
            r#"{"version":1,"media":["video"]}"#
        );
        assert_eq!(redone.node.output_batch_id.as_deref(), Some("batch-second"));
        assert!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );
    }

    #[test]
    fn a_settings_change_without_a_port_schema_keeps_every_edge() {
        let db = Database::open(":memory:").expect("open");
        upload_with_edge_to_target(&db);
        db.clear_history().expect("clear setup history");
        let before = current_rev(&db);

        // A newer document's kind: this build cannot tell which ports it
        // has, so the settings write must land but must not delete edges.
        let changes = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"media":[]}"#.to_owned(),
                None,
            )
            .expect("settings without a port schema");
        assert_eq!(current_rev(&db), before + 1);
        assert_eq!(
            changes.changes.changed[0].settings_json,
            r#"{"version":1,"media":[]}"#
        );
        assert!(changes.forward.iter().any(|op| matches!(
            op,
            HistoryOp::NodeSettings {
                id,
                mark_stale: true,
                ..
            } if id == "source"
        )));
        let persisted = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(persisted.node.settings_json, r#"{"version":1,"media":[]}"#);
        assert!(changes.changes.edges_removed.is_empty());
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        assert_eq!(
            db.node_detail("target".to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .len(),
            1
        );
    }

    #[test]
    fn a_settings_change_removes_every_edge_on_a_gone_port() {
        let db = Database::open(":memory:").expect("open");
        let mut upload = node("source", "Source", "", &[], 0.0, 0.0);
        upload.kind = "upload".to_owned();
        upload.settings_json = Some(r#"{"version":1,"media":["image"]}"#.to_owned());
        db.insert_nodes(vec![
            upload,
            node("target-a", "A", "", &[], 400.0, 0.0),
            node("target-b", "B", "", &[], 800.0, 0.0),
        ])
        .expect("insert");
        test_asset(&db, "asset-cat");
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
            &db,
            "edge-a",
            "source",
            "image",
            "target-a",
            "references",
            "image",
        );
        connect_ports(
            &db,
            "edge-b",
            "source",
            "image",
            "target-b",
            "references",
            "image",
        );
        db.clear_history().expect("clear setup history");

        let changes = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"media":[]}"#.to_owned(),
                Some(Vec::new()),
            )
            .expect("remove the output port");
        assert_eq!(
            changes.changes.edges_removed,
            vec!["edge-a".to_owned(), "edge-b".to_owned()]
        );
        assert!(scene_edge_ids(&db).is_empty());
        for target in ["target-a", "target-b"] {
            assert!(
                db.node_detail(target.to_owned())
                    .expect("detail")
                    .expect("target detail")
                    .inputs
                    .is_empty()
            );
        }

        db.undo().expect("undo the settings edit");
        assert_eq!(
            scene_edge_ids(&db),
            vec!["edge-a".to_owned(), "edge-b".to_owned()]
        );
        for target in ["target-a", "target-b"] {
            let restored = db
                .node_detail(target.to_owned())
                .expect("detail")
                .expect("target detail");
            assert_eq!(restored.inputs.len(), 1);
            assert_eq!(restored.inputs[0].item_id.as_deref(), Some("item-first"));
            assert_eq!(restored.inputs[0].asset_id.as_deref(), Some("asset-cat"));
        }

        db.redo().expect("redo the settings edit");
        assert!(scene_edge_ids(&db).is_empty());
        for target in ["target-a", "target-b"] {
            assert!(
                db.node_detail(target.to_owned())
                    .expect("detail")
                    .expect("target detail")
                    .inputs
                    .is_empty()
            );
        }
    }

    #[test]
    fn successive_settings_changes_undo_and_redo_in_order() {
        let db = Database::open(":memory:").expect("open");
        let mut source = node("source", "Source", "", &[], 0.0, 0.0);
        source.kind = "future".to_owned();
        source.settings_json = Some(r#"{"version":1,"ports":["image","video"]}"#.to_owned());
        db.insert_nodes(vec![
            source,
            node("target-a", "A", "", &[], 400.0, 0.0),
            node("target-b", "B", "", &[], 800.0, 0.0),
        ])
        .expect("insert");
        test_asset(&db, "asset-image");
        test_asset(&db, "asset-video");
        db.save_run(
            ResultBatchInput {
                id: "batch-source".to_owned(),
                node_id: "source".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-image".to_owned(),
                model: "mock-image".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![
                ResultItemInput {
                    id: "item-image".to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-image".to_owned()),
                    meta_json: None,
                },
                ResultItemInput {
                    id: "item-video".to_owned(),
                    position: 1.0,
                    port_id: "video".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-video".to_owned()),
                    meta_json: None,
                },
            ],
        )
        .expect("run");
        connect_ports(
            &db,
            "edge-image",
            "source",
            "image",
            "target-a",
            "references",
            "image",
        );
        connect_ports(
            &db,
            "edge-video",
            "source",
            "video",
            "target-b",
            "references",
            "image",
        );
        db.clear_history().expect("clear setup history");

        let first = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"ports":["image"]}"#.to_owned(),
                Some(vec!["image".to_owned()]),
            )
            .expect("first settings edit");
        assert_eq!(first.changes.edges_removed, vec!["edge-video".to_owned()]);
        assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);

        let second = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"ports":[]}"#.to_owned(),
                Some(Vec::new()),
            )
            .expect("second settings edit");
        assert_eq!(second.changes.edges_removed, vec!["edge-image".to_owned()]);
        assert!(scene_edge_ids(&db).is_empty());

        db.undo().expect("undo the second edit");
        let after_first_undo = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            after_first_undo.node.settings_json,
            r#"{"version":1,"ports":["image"]}"#
        );
        assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);

        db.undo().expect("undo the first edit");
        let after_second_undo = db
            .node_detail("source".to_owned())
            .expect("detail")
            .expect("source detail");
        assert_eq!(
            after_second_undo.node.settings_json,
            r#"{"version":1,"ports":["image","video"]}"#
        );
        assert_eq!(
            scene_edge_ids(&db),
            vec!["edge-image".to_owned(), "edge-video".to_owned()]
        );
        let target_b = db
            .node_detail("target-b".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(target_b.inputs[0].item_id.as_deref(), Some("item-video"));

        db.redo().expect("redo the first edit");
        assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);
        db.redo().expect("redo the second edit");
        assert!(scene_edge_ids(&db).is_empty());
    }

    #[test]
    fn removing_an_edge_marks_a_downstream_target_stale_once() {
        let db = Database::open(":memory:").expect("open");
        upload_with_edge_to_target(&db);
        db.save_run(
            ResultBatchInput {
                id: "batch-target".to_owned(),
                node_id: "target".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-target".to_owned(),
                position: 0.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "result".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("target run");
        db.clear_history().expect("clear setup history");
        let before = db
            .get_node("target".to_owned())
            .expect("get target")
            .expect("target");

        let changes = db
            .set_node_settings(
                "source".to_owned(),
                r#"{"version":1,"media":[]}"#.to_owned(),
                Some(Vec::new()),
            )
            .expect("remove the output port");
        let touched: Vec<_> = changes
            .changes
            .changed
            .iter()
            .filter(|node| node.id == "target")
            .collect();
        assert_eq!(touched.len(), 1, "the target is refreshed exactly once");
        assert_eq!(touched[0].status, "stale");
        assert_eq!(touched[0].rev, before.rev + 1.0);

        db.undo().expect("undo the settings edit");
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        let restored = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(restored.inputs.len(), 1);
        assert_eq!(restored.inputs[0].edge_id.as_deref(), Some("edge-source"));
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
    fn replacing_an_upload_keeps_an_edge_whose_port_survives() {
        let db = Database::open(":memory:").expect("open");
        upload_with_edge_to_target(&db);
        test_asset(&db, "asset-dog");
        db.save_run(
            ResultBatchInput {
                id: "batch-target".to_owned(),
                node_id: "target".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-target".to_owned(),
                position: 0.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "result".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("target run");
        db.clear_history().expect("clear setup history");

        let changes = db
            .set_manual_upload(
                "source".to_owned(),
                r#"{"version":1,"media":["image"]}"#.to_owned(),
                "dog.png".to_owned(),
                ResultBatchInput {
                    id: "batch-second".to_owned(),
                    node_id: "source".to_owned(),
                    trigger: "upload".to_owned(),
                    provider: "local".to_owned(),
                    model: String::new(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                vec![ResultItemInput {
                    id: "item-second".to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-dog".to_owned()),
                    meta_json: None,
                }],
                None,
            )
            .expect("replace the upload");
        assert!(changes.changes.edges_removed.is_empty());
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        let touched: Vec<_> = changes
            .changes
            .changed
            .iter()
            .filter(|node| node.id == "target")
            .collect();
        assert_eq!(touched.len(), 1, "the target is refreshed exactly once");
        assert_eq!(touched[0].status, "stale");
        let target = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(target.inputs.len(), 1);
        assert_eq!(target.inputs[0].item_id.as_deref(), Some("item-first"));

        db.undo().expect("undo the replacement");
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
        db.redo().expect("redo the replacement");
        assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    }

    #[test]
    fn add_input_appends_to_its_port_without_a_caller_position() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, port, text) in [
            ("a", "references", "A"),
            ("b", "references", "B"),
            ("c", "prompt", "C"),
        ] {
            test_asset(&db, &format!("asset-{id}"));
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                port_id: port.to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(format!("asset-{id}")),
                text: text.to_owned(),
                meta_json: None,
            })
            .expect("add input");
        }

        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        let references = port_inputs(&detail, "references");
        assert_eq!(
            references
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("a", 0.0), ("b", 1.0)]
        );
        let prompt = port_inputs(&detail, "prompt");
        assert_eq!(
            prompt
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("c", 0.0)]
        );
    }

    #[test]
    fn reordering_inputs_renumbers_per_port_and_undoes() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, port, text) in [
            ("a", "references", "A"),
            ("b", "references", "B"),
            ("c", "prompt", "C"),
        ] {
            test_asset(&db, &format!("asset-{id}"));
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                port_id: port.to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(format!("asset-{id}")),
                text: text.to_owned(),
                meta_json: None,
            })
            .expect("add input");
        }

        db.reorder_inputs(
            "n".to_owned(),
            vec!["b".to_owned(), "a".to_owned(), "c".to_owned()],
        )
        .expect("reorder");
        let reordered = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        let references = port_inputs(&reordered, "references");
        assert_eq!(
            references
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("b", 0.0), ("a", 1.0)]
        );
        let prompt = port_inputs(&reordered, "prompt");
        assert_eq!(
            prompt
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("c", 0.0)]
        );

        db.undo().expect("undo reorder");
        let restored = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&restored, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("a", 0.0), ("b", 1.0)]
        );

        db.redo().expect("redo reorder");
        let redone = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&redone, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("b", 0.0), ("a", 1.0)]
        );
    }

    #[test]
    fn sync_inputs_renumbers_each_port_under_unique_positions() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![
            node("source", "Source", "", &[], 0.0, 0.0),
            node("target", "Target", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        test_asset(&db, "asset-one");
        test_asset(&db, "asset-two");
        test_asset(&db, "asset-a");
        test_asset(&db, "asset-b");
        db.save_run(
            ResultBatchInput {
                id: "batch-source".to_owned(),
                node_id: "source".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-image".to_owned(),
                model: "mock-image".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![
                ResultItemInput {
                    id: "item-one".to_owned(),
                    position: 0.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-one".to_owned()),
                    meta_json: None,
                },
                ResultItemInput {
                    id: "item-two".to_owned(),
                    position: 1.0,
                    port_id: "image".to_owned(),
                    kind: "image".to_owned(),
                    text: String::new(),
                    asset_id: Some("asset-two".to_owned()),
                    meta_json: None,
                },
            ],
        )
        .expect("source run");
        for (id, asset) in [("local-a", "asset-a"), ("local-b", "asset-b")] {
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "target".to_owned(),
                port_id: "references".to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(asset.to_owned()),
                text: String::new(),
                meta_json: None,
            })
            .expect("local input");
        }
        connect_ports(
            &db,
            "edge-source",
            "source",
            "image",
            "target",
            "references",
            "image",
        );

        db.sync_inputs("target".to_owned()).expect("sync");
        let detail = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        let references = port_inputs(&detail, "references");
        let ids: Vec<&str> = references.iter().map(|input| input.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "local-a",
                "local-b",
                "input-edge-source-item-one",
                "input-edge-source-item-two"
            ]
        );
        let positions: Vec<f64> = references.iter().map(|input| input.position).collect();
        assert_eq!(positions, vec![0.0, 1.0, 2.0, 3.0]);
    }

    #[test]
    fn restoring_a_removed_snapshot_shifts_an_occupied_position() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![
            node("source", "Source", "", &[], 0.0, 0.0),
            node("source-2", "Source 2", "", &[], 200.0, 0.0),
            node("target", "Target", "", &[], 400.0, 0.0),
        ])
        .expect("insert");
        db.save_run(
            ResultBatchInput {
                id: "batch-old".to_owned(),
                node_id: "source".to_owned(),
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
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "old".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("old run");
        connect_ports(
            &db, "edge-old", "source", "text", "target", "prompt", "text",
        );
        db.clear_history().expect("clear setup history");
        db.set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec!["references".to_owned(), "text".to_owned()]),
        )
        .expect("remove the prompt port");
        assert!(scene_edge_ids(&db).is_empty());

        db.save_run(
            ResultBatchInput {
                id: "batch-new".to_owned(),
                node_id: "source-2".to_owned(),
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
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "new".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("new run");
        connect_ports(
            &db, "edge-new", "source-2", "text", "target", "prompt", "text",
        );
        // The run invalidates the connect entry (it references source-2) but
        // not the settings entry, whose restored edge references source and
        // target.
        db.save_run(
            ResultBatchInput {
                id: "batch-later".to_owned(),
                node_id: "source-2".to_owned(),
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
        .expect("later run");

        db.undo().expect("undo the settings edit");
        let mut edges = scene_edge_ids(&db);
        edges.sort();
        assert_eq!(edges, vec!["edge-new".to_owned(), "edge-old".to_owned()]);
        let detail = db
            .node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(detail.node.settings_json, "{}");
        let prompt = port_inputs(&detail, "prompt");
        assert_eq!(
            prompt
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![
                ("input-edge-old-item-old", 0.0),
                ("input-edge-new-item-new", 1.0)
            ]
        );
    }

    #[test]
    fn undoing_a_reorder_then_a_remove_restores_stored_positions() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, text) in [("a", "A"), ("b", "B"), ("c", "C")] {
            test_asset(&db, &format!("asset-{id}"));
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                port_id: "references".to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(format!("asset-{id}")),
                text: text.to_owned(),
                meta_json: None,
            })
            .expect("add input");
        }
        db.remove_input("b".to_owned()).expect("remove b");
        db.reorder_inputs("n".to_owned(), vec!["c".to_owned(), "a".to_owned()])
            .expect("reorder");

        db.undo().expect("undo reorder");
        db.undo().expect("undo remove");
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&detail, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("a", 0.0), ("b", 1.0), ("c", 2.0)]
        );

        db.redo().expect("redo remove");
        db.redo().expect("redo reorder");
        let redone = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&redone, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("c", 0.0), ("a", 1.0)]
        );
    }

    #[test]
    fn undoing_a_sparse_reorder_clears_the_target_range() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, text) in [("a", "A"), ("b", "B"), ("c", "C"), ("d", "D"), ("e", "E")] {
            add_local_input(&db, "n", id, "references", text);
        }
        db.remove_input("b".to_owned()).expect("remove b");
        db.remove_input("d".to_owned()).expect("remove d");
        db.reorder_inputs(
            "n".to_owned(),
            vec!["e".to_owned(), "a".to_owned(), "c".to_owned()],
        )
        .expect("reorder");

        // Undo restores the sparse positions 0, 2 and 4. The lift must clear
        // the highest target as well as the current range, or assigning e=4
        // hits a at 4 before a is moved.
        db.undo().expect("undo the sparse reorder");
        let restored = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&restored, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("a", 0.0), ("c", 2.0), ("e", 4.0)]
        );

        db.redo().expect("redo the sparse reorder");
        let redone = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&redone, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("e", 0.0), ("a", 1.0), ("c", 2.0)]
        );
    }

    #[test]
    fn restoring_a_deleted_node_keeps_the_captured_input_order() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        // Input ids sort differently from their positions, so an id-ordered
        // restore would permute the port.
        add_local_input(&db, "n", "local-b", "references", "B");
        add_local_input(&db, "n", "local-a", "references", "A");
        add_local_input(&db, "n", "local-c", "references", "C");
        db.delete_nodes(vec!["n".to_owned()]).expect("delete node");

        db.undo().expect("undo the node delete");
        let detail = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&detail, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("local-b", 0.0), ("local-a", 1.0), ("local-c", 2.0)]
        );
    }

    #[test]
    fn restoring_an_input_does_not_move_an_earlier_upload() {
        let db = Database::open(":memory:").expect("open");
        enforce_unique_input_positions(&db);
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        add_local_input(&db, "n", "cat", "references", "cat");
        add_local_input(&db, "n", "dog", "references", "dog");
        db.remove_input("cat".to_owned()).expect("remove cat");
        add_local_input(&db, "n", "fox", "references", "fox");

        db.undo().expect("undo the fox upload");
        db.undo().expect("undo the cat removal");
        let restored = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&restored, "references")
                .iter()
                .map(|input| (input.id.as_str(), input.position))
                .collect::<Vec<_>>(),
            vec![("cat", 0.0), ("dog", 1.0)]
        );

        db.redo().expect("redo the cat removal");
        db.redo().expect("redo the fox upload");
        let redone = db
            .node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail");
        assert_eq!(
            port_inputs(&redone, "references")
                .iter()
                .map(|input| input.id.as_str())
                .collect::<Vec<_>>(),
            vec!["dog", "fox"]
        );
    }

    #[test]
    fn reordering_inputs_is_undoable() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
            .expect("insert");
        for (id, text) in [("one", "One"), ("two", "Two")] {
            test_asset(&db, &format!("asset-{id}"));
            db.add_input(InputItemInput {
                id: id.to_owned(),
                node_id: "n".to_owned(),
                port_id: "out".to_owned(),
                kind: "image".to_owned(),
                origin: "local".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some(format!("asset-{id}")),
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
                port_id: "out".to_owned(),
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
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
            kind: "flow".to_owned(),
            data_json: None,
        })
        .expect("connect");

        db.update_edge(EdgeInput {
            id: "edge".to_owned(),
            from_id: "source".to_owned(),
            to_id: "new".to_owned(),
            from_port: "out".to_owned(),
            to_port: "in".to_owned(),
            port_kind: "text".to_owned(),
            from_offset: 42.0,
            to_offset: 42.0,
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
    fn tags_are_stored_in_canonical_newline_form() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node(
            "tagged",
            "Tagged",
            "",
            &[" alpha ", "", "beta\ngamma"],
            0.0,
            0.0,
        )])
        .expect("insert");
        let tags = db
            .run(|conn| {
                nodes::Entity::find()
                    .filter(nodes::Column::Id.eq("tagged"))
                    .one(conn)
                    .map(|row| row.map(|row| row.tags))
                    .map_err(|error| error.to_string())
            })
            .expect("read tags")
            .expect("tagged node");
        assert_eq!(tags, "alpha\nbeta\ngamma");
        let hits = db
            .search("gamma".to_owned(), SearchFilters::default(), 20)
            .expect("search a tag");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "tagged");
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
                    .map(|row| {
                        row.map(|row| (row.status, row.error, row.item_count, row.finished_at))
                    })
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

        // A second seed is a no-op even after the user deletes every node:
        // only a new project or a reset seeds again.
        db.delete_nodes(vec!["seed-text".to_owned(), "seed-image".to_owned()])
            .expect("delete the demo");
        assert_eq!(db.count().expect("empty nodes"), 0);
        let second = db.seed_document(seed_input()).expect("second seed");
        assert!(second.changed.is_empty());
        assert_eq!(db.count().expect("still empty"), 0);

        // The seed is not undo history.
        assert!(db.undo().expect("undo after seed").changed.is_empty());
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

        let conn = open_connection(":memory:").expect("open memory database");
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

    #[test]
    fn deleting_the_last_node_cascades_its_edges() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 300.0, 0.0),
        ])
        .expect("insert nodes");
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
        .expect("insert edge");
        assert_eq!(db.edge_count().expect("edge count"), 1);
        assert!(!db.is_empty().expect("populated document"));

        db.run(|conn| {
            nodes::Entity::delete_many()
                .exec(conn)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .expect("delete nodes");

        assert_eq!(db.count().expect("node count"), 0);
        assert_eq!(
            db.edge_count()
                .expect("edge count after deleting both nodes"),
            0,
            "sea-orm enables foreign keys, so the edge relation's Cascade removes the edge"
        );
        // `has_edges` stays in `is_empty` as defense in depth: if foreign
        // keys or the edge schema stop cascading, this assertion fails and
        // the edge-only branch must be proven again rather than dropped.
        assert!(
            db.is_empty().expect("empty after the cascade"),
            "the document is empty only after both nodes and their edge are gone"
        );
    }

    #[test]
    fn running_work_queries_use_partial_indexes() {
        use sea_orm::{QueryTrait, Statement};

        fn plan(conn: &DatabaseConnection, built: Statement) -> String {
            let statement = Statement {
                sql: format!("EXPLAIN QUERY PLAN {}", built.sql),
                values: built.values,
                db_backend: built.db_backend,
            };
            let rows = conn.query_all_raw(statement).expect("explain query plan");
            rows.iter()
                .map(|row| row.try_get::<String>("", "detail").expect("plan detail"))
                .collect::<Vec<_>>()
                .join("\n")
        }

        let conn = open_connection(":memory:").expect("open memory database");
        let nodes_statement = nodes::Entity::find()
            .filter(nodes::Column::Status.eq("running"))
            .select_only()
            .column(nodes::Column::Id)
            .build(conn.get_database_backend());
        let nodes_plan = plan(&conn, nodes_statement);
        assert!(
            nodes_plan.contains("nodes_running"),
            "the nodes recovery query uses its partial index: {nodes_plan}"
        );

        let batches_statement = result_batches::Entity::update_many()
            .col_expr(result_batches::Column::Status, Expr::value("interrupted"))
            .filter(result_batches::Column::Status.eq("running"))
            .build(conn.get_database_backend());
        let batches_plan = plan(&conn, batches_statement);
        assert!(
            batches_plan.contains("result_batches_running"),
            "the batch recovery query uses its partial index: {batches_plan}"
        );
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

    #[test]
    fn preview_items_stay_bounded_without_losing_total_count() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![
            // A node with no output has no current batch to preview.
            node("empty", "Empty", "", &[], 0.0, 0.0),
            node("single", "Single", "", &[], 300.0, 0.0),
            node("six", "Six", "", &[], 600.0, 0.0),
        ])
        .expect("insert preview nodes");

        preview_run(
            &db,
            "single",
            "preview-single",
            vec![preview_item("single-0".to_owned(), 0, None)],
        );
        preview_run(
            &db,
            "six",
            "preview-six",
            (0..6)
                .map(|position| preview_item(format!("six-{position}"), position, None))
                .collect(),
        );
        // v1 refuses to settle a `done` batch with no items, so a node with
        // an output always has something to preview.
        let empty_done = db.save_run(
            ResultBatchInput {
                id: "preview-empty".to_owned(),
                node_id: "empty".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-image".to_owned(),
                model: "mock-image".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            Vec::new(),
        );
        assert!(empty_done.is_err(), "a done batch needs an item");

        let ids = vec!["empty".to_owned(), "single".to_owned(), "six".to_owned()];
        let previews = db.previews(ids.clone()).expect("previews");
        let reference = db
            .run(move |conn| detail::previews_reference(conn, ids))
            .expect("reference previews");
        assert_eq!(previews, reference);
        assert!(
            previews.iter().all(|preview| preview.node_id != "empty"),
            "a node without an output has no preview"
        );

        let by_node = |id: &str| {
            previews
                .iter()
                .find(|preview| preview.node_id == id)
                .unwrap_or_else(|| panic!("missing {id} preview"))
        };
        let single = by_node("single");
        assert_eq!(single.item_count, 1.0);
        assert_eq!(single.items.len(), 1);
        let six = by_node("six");
        assert_eq!(
            six.item_count, 6.0,
            "the count is the full batch, not the preview cap"
        );
        assert_eq!(six.items.len(), 4, "a preview carries at most four items");
        let returned: Vec<&str> = six.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(returned, vec!["six-0", "six-1", "six-2", "six-3"]);
    }

    #[test]
    fn preview_items_order_by_position_with_an_id_tiebreak() {
        let db = Database::open(":memory:").expect("open");
        db.insert_nodes(vec![node("ordered", "Ordered", "", &[], 0.0, 0.0)])
            .expect("insert preview node");
        preview_run(
            &db,
            "ordered",
            "preview-ordered",
            vec![
                preview_item("b".to_owned(), 2, None),
                preview_item("a".to_owned(), 1, None),
                preview_item("z".to_owned(), 0, None),
                preview_item("c".to_owned(), 3, None),
            ],
        );

        let ids = vec!["ordered".to_owned()];
        let previews = db.previews(ids.clone()).expect("previews");
        let reference = db
            .run(move |conn| detail::previews_reference(conn, ids))
            .expect("reference previews");
        assert_eq!(previews, reference);
        let ordered = &previews[0];
        assert_eq!(ordered.item_count, 4.0);
        let returned: Vec<&str> = ordered.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(returned, vec!["z", "a", "b", "c"], "position order");

        // v1 makes positions unique per `(batch, port)`, so stored ties
        // cannot occur; the query still names id as the deterministic
        // tiebreak.
        let (sql, _) = detail::preview_items_statement(&["batch".to_owned()])
            .build(sea_orm::sea_query::SqliteQueryBuilder);
        let upper = sql.to_ascii_uppercase();
        assert!(upper.contains("ORDER BY \"BATCH_ID\" ASC"), "{sql}");
        assert!(upper.contains("\"POSITION\" ASC"), "{sql}");
        assert!(upper.contains("\"ID\" ASC"), "{sql}");
    }

    #[test]
    fn previews_batch_chunks_and_share_assets() {
        let db = Database::open(":memory:").expect("open");
        db.import_asset(AssetInput {
            id: "shared-asset".to_owned(),
            kind: "image".to_owned(),
            name: "shared.png".to_owned(),
            mime: "image/png".to_owned(),
            bytes: benchmark_png(0),
            meta_json: None,
        })
        .expect("import shared asset");

        // 401 ids cross the 400-id chunk boundary once; every batch shares one
        // asset, so a per-node asset query would repeat the same read 401 times.
        let mut nodes = Vec::with_capacity(401);
        for index in 0..401usize {
            let mut preview = node(
                &format!("preview-node-{index}"),
                "Preview",
                "",
                &[],
                index as f64 * 240.0,
                0.0,
            );
            preview.kind = "image".to_owned();
            nodes.push(preview);
        }
        db.insert_nodes(nodes).expect("insert preview nodes");
        for index in 0..401usize {
            preview_run(
                &db,
                &format!("preview-node-{index}"),
                &format!("preview-batch-{index}"),
                (0..4)
                    .map(|position| {
                        preview_item(
                            format!("preview-item-{index}-{position}"),
                            position,
                            Some("shared-asset"),
                        )
                    })
                    .collect(),
            );
        }

        let ids: Vec<String> = (0..401)
            .map(|index| format!("preview-node-{index}"))
            .collect();
        let previews = db.previews(ids.clone()).expect("previews");
        let reference = db
            .run({
                let ids = ids.clone();
                move |conn| detail::previews_reference(conn, ids)
            })
            .expect("reference previews");
        assert_eq!(previews, reference);
        assert_eq!(previews.len(), 401, "no requested preview crosses a chunk");
        for preview in &previews {
            assert_eq!(preview.item_count, 4.0, "{} count", preview.node_id);
            assert_eq!(preview.items.len(), 4, "{} items", preview.node_id);
            for item in &preview.items {
                assert_eq!(item.asset_id.as_deref(), Some("shared-asset"));
                assert!(item.asset.is_some(), "{} shared asset", item.id);
            }
        }
    }

    #[test]
    fn previews_keep_the_old_node_and_item_summaries() {
        let db = Database::open(":memory:").expect("open");
        db.import_asset(AssetInput {
            id: "shared-asset".to_owned(),
            kind: "image".to_owned(),
            name: "shared.png".to_owned(),
            mime: "image/png".to_owned(),
            bytes: benchmark_png(0),
            meta_json: None,
        })
        .expect("import shared asset");
        db.import_asset(AssetInput {
            id: "other-asset".to_owned(),
            kind: "image".to_owned(),
            name: "other.png".to_owned(),
            mime: "image/png".to_owned(),
            bytes: benchmark_png(1),
            meta_json: None,
        })
        .expect("import second asset");
        let mut first = node("image-a", "Image A", "", &[], 0.0, 0.0);
        first.kind = "image".to_owned();
        let mut second = node("image-b", "Image B", "", &[], 400.0, 0.0);
        second.kind = "image".to_owned();
        db.insert_nodes(vec![first, second])
            .expect("insert preview nodes");
        preview_run(
            &db,
            "image-a",
            "batch-a",
            vec![
                preview_item("a-0".to_owned(), 0, Some("shared-asset")),
                preview_item("a-1".to_owned(), 1, Some("other-asset")),
                preview_item("a-2".to_owned(), 2, None),
                preview_item("a-3".to_owned(), 3, Some("shared-asset")),
            ],
        );
        preview_run(
            &db,
            "image-b",
            "batch-b",
            vec![
                preview_item("b-0".to_owned(), 0, Some("shared-asset")),
                preview_item("b-1".to_owned(), 1, Some("other-asset")),
            ],
        );

        let ids = vec!["image-a".to_owned(), "image-b".to_owned()];
        let previews = db.previews(ids.clone()).expect("previews");
        let reference = db
            .run(move |conn| detail::previews_reference(conn, ids))
            .expect("reference previews");
        assert_eq!(previews, reference);

        let a = previews
            .iter()
            .find(|preview| preview.node_id == "image-a")
            .expect("image-a preview");
        assert_eq!(a.item_count, 4.0);
        assert_eq!(a.items.len(), 4);
        assert_eq!(a.items[0].asset_id.as_deref(), Some("shared-asset"));
        assert!(a.items[0].asset.is_some());
        assert_eq!(a.items[1].asset_id.as_deref(), Some("other-asset"));
        assert!(a.items[1].asset.is_some());
        assert!(a.items[2].asset.is_none(), "an item without an asset id");
        assert_eq!(a.items[3].asset_id.as_deref(), Some("shared-asset"));
        assert!(
            a.items[3].asset.is_some(),
            "a repeated asset still resolves"
        );

        // v1 refuses an item whose asset row does not exist, so a preview can
        // never meet the missing-asset case this test used to model.
        let missing = db.save_run(
            ResultBatchInput {
                id: "batch-missing".to_owned(),
                node_id: "image-a".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-image".to_owned(),
                model: "mock-image".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![preview_item("missing".to_owned(), 0, Some("missing-asset"))],
        );
        assert!(missing.is_err(), "a missing asset row must be refused");

        let b = previews
            .iter()
            .find(|preview| preview.node_id == "image-b")
            .expect("image-b preview");
        assert_eq!(b.item_count, 2.0);
        assert_eq!(b.items.len(), 2);
        assert_eq!(b.items[1].asset_id.as_deref(), Some("other-asset"));
        assert!(b.items[1].asset.is_some());
    }

    #[test]
    fn preview_query_caps_rows_in_the_outer_window_query() {
        use sea_orm::sea_query::SqliteQueryBuilder;

        let statement = detail::preview_items_statement(&["batch-id".to_owned()]);
        let (sql, values) = statement.build(SqliteQueryBuilder);
        let upper = sql.to_ascii_uppercase();
        assert!(upper.contains("ROW_NUMBER()"), "{sql}");
        assert!(upper.contains("OVER"), "{sql}");
        assert!(upper.contains("PARTITION BY"), "{sql}");
        assert_eq!(
            upper.matches("ROW_NUMBER()").count(),
            1,
            "one window ranks the whole chunk: {sql}"
        );
        assert!(
            sql.contains("\"preview_row_number\" <= ?"),
            "the cap is an outer bound value, not an interpolated id: {sql}"
        );
        assert_eq!(
            sql.matches('?').count(),
            2,
            "the batch id and cap stay bound values: {sql}"
        );
        assert!(
            !sql.contains("batch-id"),
            "batch ids never enter the statement text: {sql}"
        );
        assert_eq!(values.0.len(), 2, "one id list and the cap are bound");
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
    const FIXTURE_VERSION: &str = "100k-grid-edges-images-v2-typed-ports";
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
                    from_port: "text".to_owned(),
                    to_port: "prompt".to_owned(),
                    port_kind: "text".to_owned(),
                    from_offset: 42.0,
                    to_offset: 28.0,
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
                        port_id: "out".to_owned(),
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

    /// Mirrors `camera.fit` in `src/flow/canvas/model/camera.ts`: 48 points of padding on
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

    /// Paired before/after read of one preview request on the same unchanged
    /// database; the pre-bounded reader is the result oracle.
    fn measure_preview_readers(db: &Database, ids: &[String], samples: usize) {
        let expected = db
            .run({
                let ids = ids.to_vec();
                move |conn| detail::previews_reference(conn, ids)
            })
            .expect("reference preview warmup");
        let (rows, items, assets) = validate_previews(&expected, ids, "preview readers");
        assert_eq!(
            db.previews(ids.to_vec()).expect("bounded preview warmup"),
            expected,
            "the bounded preview reader changed the result"
        );

        let mut old_times = Vec::with_capacity(samples);
        let mut new_times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = std::time::Instant::now();
            let old = db
                .run({
                    let ids = ids.to_vec();
                    move |conn| detail::previews_reference(conn, ids)
                })
                .expect("reference preview sample");
            old_times.push(elapsed_ms(started));
            assert_eq!(old, expected, "the reference preview reader is stable");

            let started = std::time::Instant::now();
            let bounded = db.previews(ids.to_vec()).expect("bounded preview sample");
            new_times.push(elapsed_ms(started));
            assert_eq!(bounded, expected, "the bounded preview reader is stable");
        }
        let detail = format!(
            " images={} rows={rows} items={items} assets={assets}",
            ids.len()
        );
        print_stats("old_preview_reader", &mut old_times, &detail);
        print_stats("bounded_preview_reader", &mut new_times, &detail);
    }

    /// Both startup emptiness predicates on the same unchanged database. The
    /// historical count pair is the reference; `is_empty` is one worker call
    /// with two existence reads.
    fn measure_startup_empty(db: &Database, samples: usize) -> bool {
        let nodes = db.count().expect("startup node count");
        let edges = db.edge_count().expect("startup edge count");
        let detail = format!(" fixture nodes={nodes} edges={edges} unchanged");
        let mut count_times = Vec::with_capacity(samples);
        let mut empty_times = Vec::with_capacity(samples);
        let mut historical = false;
        let mut current = false;
        for _ in 0..samples {
            let started = std::time::Instant::now();
            historical = db.count().expect("startup count") == 0
                && db.edge_count().expect("startup edge count") == 0;
            count_times.push(elapsed_ms(started));

            let started = std::time::Instant::now();
            current = db.is_empty().expect("startup emptiness");
            empty_times.push(elapsed_ms(started));
        }
        assert_eq!(
            historical, current,
            "the count pair and is_empty disagree about startup emptiness"
        );
        print_stats(
            "startup emptiness count reference",
            &mut count_times,
            &detail,
        );
        print_stats("startup emptiness is_empty", &mut empty_times, &detail);
        current
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
            Some(EdgePoint::output(
                from.x,
                from.y,
                from.width,
                from.height / 2.0
            )),
            "cycle {cycle}: interior from port"
        );
        assert_eq!(
            interior.to_point,
            Some(EdgePoint::input(to.x, to.y, to.height / 3.0)),
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
                far_from.height / 2.0
            )),
            "cycle {cycle}: boundary far from port"
        );
        assert_eq!(
            crossing.to_point,
            Some(EdgePoint::input(
                moved_to.x,
                moved_to.y,
                moved_to.height / 3.0
            )),
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
                moved_from.height / 2.0
            )),
            "cycle {cycle}: boundary moved from port"
        );
        assert_eq!(
            boundary.to_point,
            Some(EdgePoint::input(far_to.x, far_to.y, far_to.height / 3.0)),
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
        assert!(
            !measure_startup_empty(&db, SCENE_SAMPLES),
            "the seeded fixture is not empty"
        );

        let bounds_started = std::time::Instant::now();
        let bounds = db.bounds().expect("measure document bounds");
        let bounds_ms = elapsed_ms(bounds_started);
        assert!(bounds.width > 0.0 && bounds.height > 0.0);
        println!("bounds (Fit source): {bounds:?} read={bounds_ms:.2}ms");

        // The startup order: Fit reads the bounds, then the minimap's overview
        // at the same revision reuses them and reads the capped sample.
        let overview_started = std::time::Instant::now();
        let overview = db.overview().expect("measure document overview");
        let overview_ms = elapsed_ms(overview_started);
        assert_eq!(overview.cards.len() as u64, scene::OVERVIEW_LIMIT);
        println!(
            "overview (minimap, bounds cached): cards={} read={overview_ms:.2}ms",
            overview.cards.len()
        );

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
        measure_preview_readers(&db, &image_ids, SCENE_SAMPLES);

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

        let mut recover_times = Vec::with_capacity(RECOVERY_ITERATIONS as usize);
        for iteration in 0..RECOVERY_ITERATIONS {
            mark_running(&db, iteration, &sinks);
            drop(db);

            let open_started = std::time::Instant::now();
            db = Database::open(&path).expect("reopen for recovery");
            let open_ms = elapsed_ms(open_started);

            let recover_started = std::time::Instant::now();
            let recovered = db.recover_runs().expect("recover running nodes");
            let recover_ms = elapsed_ms(recover_started);
            recover_times.push(recover_ms);
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
        print_stats(
            "recover_runs populated-running",
            &mut recover_times,
            " 100 row-end nodes marked running before each fresh reopen; the clean second call is not compared",
        );

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
