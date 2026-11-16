//! The document handle, worker jobs and command wrappers.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use sea_orm::DatabaseConnection;

use crate::asset;
use crate::detail;
use crate::document;
use crate::gc;
use crate::history::{History, HistoryEntry, HistoryRefs};
use crate::mutation::{self, Mutation};
use crate::scene;
use crate::schema;
use crate::search;
use crate::types::{
    AssetInput, AssetSummary, ChangeSet, EdgeInput, GcReport, InputItemInput, InputItemSummary,
    NodeBounds, NodeDetail, NodeInput, NodePreview, NodeSummary, ResultBatchInput, ResultItemInput,
    SceneSnapshot, SearchFilters, SearchHit, SeedDocumentInput, Viewport,
};
use crate::viewport;

mod metadata;
mod open;
mod session;
mod undo;
mod verify;
mod worker;

use undo::{ensure_history, invalidate_history};
use worker::Job;

pub(crate) use worker::{configure, sqlite_url, sqlite_url_ro, sqlite_url_rw};

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

#[cfg(test)]
mod tests;
