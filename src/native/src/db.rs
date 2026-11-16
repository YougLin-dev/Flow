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
use crate::edge_index;
use crate::entity::{document as document_row, nodes};
use crate::gc;
#[cfg(test)]
use crate::history::HistoryOp;
use crate::history::{History, HistoryEntry, HistoryRefs};
use crate::mutation::{self, Mutation};
use crate::scene;
use crate::schema;
use crate::search;
use crate::types::{
    AssetInput, AssetSummary, ChangeSet, EdgeInput, GcReport, InputItemInput, InputItemSummary,
    NodeBounds, NodeDetail, NodeInput, NodePreview, NodeSummary, Overview, ProjectInfo,
    ResultBatchInput, ResultItemInput, SceneSnapshot, SearchFilters, SearchHit, SeedDocumentInput,
    Viewport,
};
use crate::viewport;

/// A unit of work for the database thread.
enum Job {
    Run(Box<dyn FnOnce(&DatabaseConnection) + Send + 'static>),
    /// Saves the camera (when given), checkpoints, records the shutdown
    /// state, acknowledges, and stops the worker.
    Close {
        ack: Sender<Result<(), String>>,
        camera: Option<(f64, f64, f64)>,
        /// Shared with the handle: a close job reads it in the worker, after
        /// any earlier verify job has stored its outcome (FIFO order).
        recovery_pending: Arc<AtomicBool>,
    },
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

/// How a database connection treats its file.
#[derive(Clone, Debug)]
enum OpenMode {
    /// Create the file and its release schema when missing. The legacy and
    /// dev path.
    Create,
    /// Require an existing compatible package whose document carries this
    /// identity. Never creates the file or a parent directory.
    Existing { project_id: String },
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
    /// Set as soon as a close is requested. Queued reads answer "closed"
    /// without touching SQLite so a quit does not wait for stale reads;
    /// commands already accepted still run ahead of the close job.
    closing: Arc<AtomicBool>,
    /// True while the package is due for the recovery check: an unclean open
    /// starts pending; only a verify job that completes successfully clears
    /// it, and only then may close mark the package clean.
    recovery_pending: Arc<AtomicBool>,
    /// Whether the package was clean before this open marked it dirty. A new
    /// package counts as clean: there is nothing from a previous session.
    opened_clean: bool,
}

impl Database {
    /// Opens `path`, creating the file and its schema when missing. This is
    /// the legacy/dev path (`FLOW_DB_PATH`, tests and the 100k smoke).
    pub fn open(path: &str) -> Result<Self, String> {
        Self::open_with(path, OpenMode::Create)
    }

    /// Opens an existing package and requires its document identity. A
    /// missing or empty file is refused without creating it or its parent
    /// directory, and the package is only marked dirty after the identity
    /// matches.
    pub(crate) fn open_package(path: &str, project_id: String) -> Result<Self, String> {
        Self::open_with(path, OpenMode::Existing { project_id })
    }

    fn open_with(path: &str, mode: OpenMode) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let path = path.to_owned();
        let assets_dir = Arc::new(AssetsDir {
            path: asset::assets_dir_for(&path),
            temporary: path == ":memory:",
        });

        std::thread::Builder::new()
            .name("flow-db".to_owned())
            .spawn(move || worker(&path, mode, ready_tx, job_rx))
            .map_err(|error| error.to_string())?;

        let opened_clean = ready_rx
            .recv()
            .map_err(|_| "the database worker stopped during startup".to_owned())??;

        Ok(Self {
            tx: Arc::new(Mutex::new(job_tx)),
            history: Arc::new(Mutex::new(History::default())),
            assets_dir,
            bounds_cache: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            closing: Arc::new(AtomicBool::new(false)),
            recovery_pending: Arc::new(AtomicBool::new(!opened_clean)),
            opened_clean,
        })
    }

    /// Collects unreachable terminal batches, their items, unreferenced assets
    /// and asset files with no row. Maintenance only: refuses while the undo
    /// history holds an entry, because an entry may name one of those rows.
    pub fn gc(&self) -> Result<GcReport, String> {
        let history = Arc::clone(&self.history);
        let assets_dir = Arc::clone(&self.assets_dir);
        self.run(move |conn| {
            let empty = history
                .lock()
                .map_err(|_| "the undo history lock is poisoned".to_owned())?
                .is_empty();
            if !empty {
                return Err("a package collection needs an empty undo history".to_owned());
            }
            gc::collect(conn, &assets_dir)
        })
    }

    /// Dev-only destructive reset: drops every content row and recreates the
    /// frozen schema, keeping the project id, title and creation time. The
    /// asset directory is parked during the transaction and restored if it
    /// fails; on success the trash is removed. Clears the undo history.
    pub fn reset(&self) -> Result<(), String> {
        let history = Arc::clone(&self.history);
        let assets_dir = Arc::clone(&self.assets_dir);
        let result = self.run(move |conn| {
            let current = document::current(conn).map_err(|error| error.to_string())?;
            let trash = park_assets(&assets_dir)?;
            let outcome = schema::reset::reset_schema(
                conn,
                &current.project_id,
                &current.title,
                current.created_at,
            );
            match outcome {
                Ok(()) => {
                    if let Some(trash) = &trash {
                        remove_asset_path(trash);
                    }
                    if let Ok(mut history) = history.lock() {
                        history.clear();
                    }
                    Ok(())
                }
                Err(error) => {
                    if let Some(trash) = &trash {
                        // Best effort: the original directory is still intact
                        // under the trash name if this fails.
                        let _ = fs::rename(trash, &assets_dir.path);
                    }
                    Err(error)
                }
            }
        });
        if result.is_ok() {
            self.clear_bounds_cache();
        }
        result
    }

    /// The package identity, title, camera and derived counts.
    pub fn project_info(&self) -> Result<ProjectInfo, String> {
        let opened_clean = self.opened_clean;
        self.run_read(move |conn| {
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
                opened_clean,
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

    /// The recovery check for a package that was not closed cleanly: SQLite's
    /// integrity and foreign-key checks, then the FTS/RTree parity repairs, a
    /// dirty-connector flush and exact bounds in one transaction. Kept off
    /// the open path: the 100k fixture makes a full check expensive.
    ///
    /// The outcome is stored from inside the worker job, so a close queued
    /// after it always sees the result. A close requested while the check
    /// runs aborts it between phases and leaves the package due for recovery.
    pub fn verify(&self) -> Result<(), String> {
        let recovery_pending = Arc::clone(&self.recovery_pending);
        let closing = Arc::clone(&self.closing);
        let result = self.run_job(
            move |conn| {
                let outcome = verify_connection(conn, || closing.load(Ordering::SeqCst));
                recovery_pending.store(outcome.is_err(), Ordering::SeqCst);
                outcome
            },
            true,
        );
        if result.is_ok() {
            self.clear_bounds_cache();
        }
        result
    }

    /// Tightens the conservative document bounds after deletes, and records
    /// that they are exact. Maintenance only: it does not bump the revision.
    pub fn compact_bounds(&self) -> Result<(), String> {
        let result = self.run(|conn| {
            conn.transaction::<_, _, sea_orm::DbErr>(compact_bounds_tx)
                .map_err(|error| error.to_string())
        });
        if result.is_ok() {
            self.clear_bounds_cache();
        }
        result
    }

    fn clear_bounds_cache(&self) {
        if let Ok(mut cache) = self.bounds_cache.lock() {
            *cache = None;
        }
    }

    /// Marks the package cleanly closed and stops the worker. Idempotent: a
    /// second call (or a call after the worker stopped) does nothing. A
    /// failed `verify` keeps the package due for recovery: the checkpoint
    /// still runs, but `clean_shutdown` stays 0.
    pub fn close(&self) -> Result<(), String> {
        self.close_with_camera(None)
    }

    /// Saves the camera, then closes like `close`. Folding both into one
    /// worker job lets a quit reach the checkpoint without a second round
    /// trip and without a chained await that a short quit budget can cut.
    pub fn close_with_view(&self, x: f64, y: f64, zoom: f64) -> Result<(), String> {
        if !schema::v1::is_valid_camera(x, y, zoom) {
            return Err("the camera is outside the supported range".to_owned());
        }
        self.close_with_camera(Some((x, y, zoom)))
    }

    fn close_with_camera(&self, camera: Option<(f64, f64, f64)>) -> Result<(), String> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.closing.store(true, Ordering::SeqCst);
        let (result_tx, result_rx) = mpsc::channel();
        let sent = self
            .tx
            .lock()
            .map_err(|_| "the database worker lock is poisoned".to_owned())?
            .send(Job::Close {
                ack: result_tx,
                camera,
                recovery_pending: Arc::clone(&self.recovery_pending),
            });
        if sent.is_err() {
            return Ok(());
        }
        let acked = result_rx
            .recv()
            .map_err(|_| "the database worker stopped during close".to_owned())?;
        // An error from the acknowledged job means the worker already dropped
        // its connection and stopped; the package is merely dirty and will
        // verify on its next open. The marker lets the workspace release the
        // package lease in that case while keeping it when no job ran.
        acked.map_err(|error| format!("{CLOSE_FAILED_AFTER_STOP}{error}"))
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

    /// Writes the demo seed in one transaction. It clears the undo history
    /// only when it wrote; an already-seeded document is left untouched.
    pub fn seed_document(&self, input: SeedDocumentInput) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let (changes, seeded) = mutation::seed_document(conn, input)?;
            if seeded && let Ok(mut history) = history.lock() {
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
        self.run_read(move |conn| detail::node_detail(conn, &id))
    }

    /// The first items of several nodes' current batches, for card previews.
    pub fn previews(&self, ids: Vec<String>) -> Result<Vec<NodePreview>, String> {
        self.run_read(move |conn| detail::previews(conn, ids))
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
        self.run_read(move |conn| asset::asset_bytes(conn, &assets_dir, id))
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
        self.run_read(move |conn| viewport::viewport(conn, rect, margin, viewport::NODE_LIMIT))
    }

    pub fn scene(
        &self,
        rect: Viewport,
        margin: f64,
        max_cards: u64,
    ) -> Result<SceneSnapshot, String> {
        self.run_read(move |conn| scene::snapshot(conn, rect, margin, max_cards))
    }

    pub fn bounds(&self) -> Result<Viewport, String> {
        let cache = self.bounds_cache.clone();
        self.run_read(move |conn| cached_bounds(conn, &cache))
    }

    pub fn overview(&self) -> Result<Overview, String> {
        let cache = self.bounds_cache.clone();
        self.run_read(move |conn| {
            let bounds = cached_bounds(conn, &cache)?;
            scene::overview(conn, bounds)
        })
    }

    pub fn get_node(&self, id: String) -> Result<Option<NodeSummary>, String> {
        self.run_read(move |conn| scene::get_node(conn, &id))
    }

    pub fn search(
        &self,
        query: String,
        filters: SearchFilters,
        limit: u32,
    ) -> Result<Vec<SearchHit>, String> {
        self.run_read(move |conn| search::search(conn, query, filters, limit))
    }

    pub fn count(&self) -> Result<u32, String> {
        self.run_read(count)
    }

    pub fn edge_count(&self) -> Result<u32, String> {
        self.run_read(edge_count)
    }

    /// Whether the open document has neither nodes nor edges. One worker job
    /// answers startup's seed question with two existence reads, not counts.
    pub fn is_empty(&self) -> Result<bool, String> {
        self.run_read(|conn| Ok(!has_nodes(conn)? && !has_edges(conn)?))
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

    /// Runs a command. A close requested while it sits in the queue still
    /// runs it: a flushed write must reach the checkpoint.
    fn run<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&DatabaseConnection) -> Result<T, String> + Send + 'static,
    {
        self.run_job(work, false)
    }

    /// Runs a read or maintenance job. A close requested while it sits in the
    /// queue answers "closed" without touching SQLite, so a quit does not
    /// wait for stale work; the owner is closing and will not use the value.
    fn run_read<T, F>(&self, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&DatabaseConnection) -> Result<T, String> + Send + 'static,
    {
        self.run_job(work, true)
    }

    fn run_job<T, F>(&self, work: F, skippable: bool) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&DatabaseConnection) -> Result<T, String> + Send + 'static,
    {
        if self.closed.load(Ordering::SeqCst) {
            return Err("the database is closed".to_owned());
        }
        let closing = Arc::clone(&self.closing);
        let (result_tx, result_rx) = mpsc::channel();
        let job = Job::Run(Box::new(move |conn| {
            if skippable && closing.load(Ordering::SeqCst) {
                let _ = result_tx.send(Err("the database is closed".to_owned()));
                return;
            }
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

/// Moves the package's asset directory aside before a destructive reset. The
/// reset transaction renames it back on failure; success deletes it.
fn park_assets(dir: &Path) -> Result<Option<PathBuf>, String> {
    match fs::metadata(dir) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let trash = dir.with_file_name(format!(
        "assets.trash-{}-{}",
        crate::clock::now_ms(),
        std::process::id()
    ));
    fs::rename(dir, &trash).map_err(|error| error.to_string())?;
    Ok(Some(trash))
}

/// Best-effort removal of a parked asset directory after a committed reset.
/// A leftover trash directory holds no live row, so failing here is harmless.
fn remove_asset_path(path: &Path) {
    let _ = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
}

fn worker(path: &str, mode: OpenMode, ready: Sender<Result<bool, String>>, jobs: Receiver<Job>) {
    let conn = match open_connection(path, mode) {
        Ok(opened) => {
            let _ = ready.send(Ok(opened.clean));
            opened.conn
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
            Job::Close {
                ack,
                camera,
                recovery_pending,
            } => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Read inside the worker: an earlier verify job that
                    // started has already stored its outcome here (FIFO); a
                    // verify still queued at close is skipped before it runs.
                    let mark_clean = !recovery_pending.load(Ordering::SeqCst);
                    if let Some((x, y, zoom)) = camera {
                        document_row::Entity::update(document_row::ActiveModel {
                            id: Unchanged(document::ROW_ID),
                            camera_x: Set(x),
                            camera_y: Set(y),
                            camera_zoom: Set(zoom),
                            ..Default::default()
                        })
                        .exec(&conn)
                        .map_err(|error| error.to_string())?;
                    }
                    // Fold committed WAL frames back into the package file
                    // first. Only a complete checkpoint may be called a clean
                    // close; the flag stays 0 otherwise.
                    schema::package::checkpoint_truncate(&conn)?;
                    if mark_clean {
                        schema::package::mark_clean(&conn)?;
                    }
                    Ok(())
                }))
                .unwrap_or_else(|_| Err("the database job panicked".to_owned()));
                // Release the file before acknowledging: a rename, delete or
                // backup the caller starts after close must not race the
                // connection.
                drop(conn);
                let _ = ack.send(result);
                return;
            }
        }
    }
}

/// An opened package connection and the shutdown state it had beforehand.
struct OpenConnection {
    conn: DatabaseConnection,
    /// A new package has nothing from a previous session to verify.
    clean: bool,
}

fn open_connection(path: &str, mode: OpenMode) -> Result<OpenConnection, String> {
    if matches!(mode, OpenMode::Create)
        && path != ":memory:"
        && let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let url = match &mode {
        OpenMode::Create => sqlite_url(path)?,
        OpenMode::Existing { .. } => {
            if path != ":memory:" && !Path::new(path).is_file() {
                return Err(missing_package_error(path));
            }
            sqlite_url_rw(path)?
        }
    };
    let conn = sea_orm::Database::connect(url.as_str()).map_err(|error| error.to_string())?;
    schema::v1::configure(&conn).map_err(|error| package_error(path, error))?;

    // Inspect before tuning the file: setting WAL would write to a foreign
    // database even though the guard then refuses it. The previous session's
    // flag is read here, before the open marks the package dirty.
    let clean = match schema::v1::inspect(&conn).map_err(|error| package_error(path, error))? {
        schema::v1::FileState::New => match &mode {
            OpenMode::Create => {
                schema::v1::create(&conn, "Flow").map_err(|error| package_error(path, error))?;
                true
            }
            OpenMode::Existing { .. } => {
                return Err(missing_package_error(path));
            }
        },
        schema::v1::FileState::Current(info) => {
            if let OpenMode::Existing { project_id } = &mode
                && info.project_id != *project_id
            {
                return Err(format!(
                    "the project package belongs to a different project: {path}"
                ));
            }
            document::current(&conn)
                .map_err(|error| error.to_string())?
                .clean_shutdown
                != 0
        }
    };
    configure(&conn, path)?;

    // The flag stays 0 for the whole session; `close` sets it once the
    // document has been written out cleanly.
    schema::package::mark_dirty(&conn).map_err(|error| error.to_string())?;

    Ok(OpenConnection { conn, clean })
}

fn missing_package_error(path: &str) -> String {
    format!(
        "the project package has no Flow database: {path}. \
         Create a project or choose an existing package."
    )
}

/// Adds the package path and a recovery suggestion to a guard error. The
/// guard itself sees only the connection.
fn package_error(path: &str, error: String) -> String {
    format!(
        "{path}: {error}. The file is not a compatible Flow project package; \
         delete it and its assets directory, or open a new project."
    )
}

/// Prefix of a close failure that ran to completion: the worker acknowledged
/// the job (and dropped its connection) but could not make the package
/// clean. The workspace releases the lease; the dirty package verifies on
/// the next open. A failure without this prefix may have left the worker
/// holding the connection.
pub(crate) const CLOSE_FAILED_AFTER_STOP: &str = "the document closed with a recovery warning: ";

/// The reason an in-flight recovery check stops early: the package is being
/// closed, and the next open re-runs the check.
const VERIFY_CLOSING: &str = "the database is closing";

/// The recovery body. The stop decision is sampled between phases, so a quit
/// aborts the check as soon as the current statement returns. `quick_check`
/// itself cannot be interrupted, so it still bounds the wait on a large
/// package; a package left dirty by that abort verifies on the next open.
/// The decision is a callback so tests can flip it at a chosen phase.
fn verify_connection(conn: &DatabaseConnection, stop: impl Fn() -> bool) -> Result<(), String> {
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    check_quick_check(conn)?;
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    check_foreign_keys(conn)?;
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    conn.transaction::<_, _, sea_orm::DbErr>(|txn| {
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        schema::maintenance::repair_fts(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        edge_index::flush_geometry_tx(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        schema::maintenance::repair_rtrees(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        compact_bounds_tx(txn)
    })
    .map_err(|error| format!("the document repair failed: {error}"))
}

fn check_quick_check(conn: &DatabaseConnection) -> Result<(), String> {
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
    Ok(())
}

fn check_foreign_keys(conn: &DatabaseConnection) -> Result<(), String> {
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
}

/// Recomputes the exact content bounds in the caller's transaction. Shared by
/// `compact_bounds` and `verify`, so a repair does not enqueue a second worker
/// job behind its own.
fn compact_bounds_tx(conn: &impl ConnectionTrait) -> Result<(), sea_orm::DbErr> {
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
        .one(conn)?
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
    .exec(conn)?;
    Ok(())
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
    // A late or repeated write that touched no row must not clear the redo
    // entry a user could still apply.
    if refs.is_empty() {
        return;
    }
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
    absolute_sqlite_url(path)
}

/// A read-only URL for a scan: SQLite fails instead of creating a missing
/// file, and a foreign or damaged package is inspected without writing to it.
pub(crate) fn sqlite_url_ro(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }
    Ok(format!("{}?mode=ro", absolute_sqlite_url(path)?))
}

/// A read-write URL that refuses to create a missing file. The managed open
/// path must not leave an empty database behind when the package is absent.
pub(crate) fn sqlite_url_rw(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }
    Ok(format!("{}?mode=rw", absolute_sqlite_url(path)?))
}

fn absolute_sqlite_url(path: &str) -> Result<String, String> {
    // SQLite resolves `file:` URIs as absolute paths. Make relative overrides
    // (`FLOW_DB_PATH=./flow.db`) absolute first so they open next to the
    // caller rather than at the filesystem root, and so a colon in a file
    // name cannot be read as a URL authority and port.
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let normalized = absolute.to_string_lossy().replace('\\', "/");
    // `fs::canonicalize` produces a verbatim `\\?\C:\...` path on Windows
    // (or `\\?\UNC\server\share`); its `?` is not part of a SQLite `file:`
    // URI and must not survive as an authority. A verbatim UNC prefix
    // becomes the normal `//server/share` authority; a drive path drops the
    // prefix.
    let normalized = match normalized.strip_prefix("//?/UNC/") {
        Some(rest) => format!("//{rest}"),
        None => normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_owned(),
    };
    let encoded = encode_uri_path(&normalized);
    if encoded.starts_with("//") {
        // A UNC path's `//server/share` would be read as a URI authority,
        // which the bundled SQLite rejects (it is built without
        // SQLITE_ALLOW_URI_AUTHORITY). `localhost` is the one authority such
        // a build accepts and ignores, leaving the double-slash UNC path.
        Ok(format!("sqlite:file://localhost{encoded}"))
    } else if encoded.starts_with('/') {
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

pub(crate) fn configure(conn: &DatabaseConnection, path: &str) -> Result<(), String> {
    conn.execute_unprepared("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -64000;")
        .map_err(|error| error.to_string())?;
    if path != ":memory:" {
        conn.execute_unprepared("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
