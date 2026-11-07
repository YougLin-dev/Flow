//! Flow's document and search core.
//!
//! TSX never opens SQLite. It talks to this crate through the generated
//! `@flow/native` module; Leafer stays on the TSX side.

use std::sync::{Arc, Mutex};

use nsh_core::prelude::*;

mod clock;
mod constants;
mod db;
mod document;
mod entity;
mod history;
mod mutation;
mod scene;
mod schema;
mod search;
mod types;
mod viewport;

use db::Database;
use history::{History, HistoryEntry};
use mutation::Mutation;
use types::{
    ChangeSet, EdgeInput, NodeBounds, NodeInput, NodeSummary, SceneSnapshot, SearchFilters,
    SearchHit, Viewport,
};

/// The open Flow document.
///
/// The database is owned by Rust. The class is created with
/// `Document.open(path)`; there is deliberately no public constructor.
#[class]
pub struct Document {
    db: Database,
    history: Arc<Mutex<History>>,
}

#[class]
impl Document {
    /// Opens `path`; creates the file and its schema when missing.
    pub async fn open(path: String) -> Result<Document, String> {
        let db = off_thread(move || Database::open(&path)).await?;
        Ok(Document {
            db,
            history: Arc::new(Mutex::new(History::default())),
        })
    }

    /// Inserts nodes; the returned change set contains their summaries.
    pub async fn insert_nodes(
        this: Instance<Self>,
        nodes: Vec<NodeInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.insert_nodes(nodes)).await?;
        push_history(&history, mutation)
    }

    /// Moves nodes by `dx`/`dy`; one drag is one call.
    pub async fn move_nodes(
        this: Instance<Self>,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.move_nodes(ids, dx, dy)).await?;
        push_history(&history, mutation)
    }

    /// Replaces a node's searchable text and tags.
    pub async fn set_node_text(
        this: Instance<Self>,
        id: String,
        title: String,
        body: String,
        tags: Vec<String>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.set_node_text(id, title, body, tags)).await?;
        push_history(&history, mutation)
    }

    /// Deletes nodes and their edges.
    pub async fn delete_nodes(this: Instance<Self>, ids: Vec<String>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.delete_nodes(ids)).await?;
        push_history(&history, mutation)
    }

    /// Finishes a drag or resize: one call for every moved or resized node.
    pub async fn set_node_bounds(
        this: Instance<Self>,
        nodes: Vec<NodeBounds>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.set_node_bounds(nodes)).await?;
        push_history(&history, mutation)
    }

    /// Inserts edges whose endpoints already exist.
    pub async fn insert_edges(
        this: Instance<Self>,
        edges: Vec<EdgeInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.insert_edges(edges)).await?;
        push_history(&history, mutation)
    }

    /// Deletes edges by id.
    pub async fn delete_edges(this: Instance<Self>, ids: Vec<String>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let mutation = off_thread(move || db.delete_edges(ids)).await?;
        push_history(&history, mutation)
    }

    /// Nodes intersecting `rect`, with `margin` world units added around it.
    pub async fn viewport(
        this: Instance<Self>,
        rect: Viewport,
        margin: f64,
    ) -> Result<Vec<NodeSummary>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.viewport(rect, margin)).await
    }

    /// Everything the canvas needs for `rect`: visible nodes and their edges.
    pub async fn scene(
        this: Instance<Self>,
        rect: Viewport,
        margin: f64,
    ) -> Result<SceneSnapshot, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.scene(rect, margin)).await
    }

    /// The whole document's content bounds, for Fit.
    pub async fn bounds(this: Instance<Self>) -> Result<Viewport, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.bounds()).await
    }

    /// One node by id, for revealing a search result.
    pub async fn get_node(this: Instance<Self>, id: String) -> Result<Option<NodeSummary>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.get_node(id)).await
    }

    /// Full-text search over titles, bodies and tags.
    pub async fn search(
        this: Instance<Self>,
        query: String,
        filters: SearchFilters,
        limit: u32,
    ) -> Result<Vec<SearchHit>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.search(query, filters, limit)).await
    }

    /// The number of nodes in the open document.
    pub async fn count(this: Instance<Self>) -> Result<u32, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.count()).await
    }

    /// The number of edges in the open document.
    pub async fn edge_count(this: Instance<Self>) -> Result<u32, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.edge_count()).await
    }

    /// Reverts the last command.
    pub async fn undo(this: Instance<Self>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let entry = {
            let mut history = lock_history(&history)?;
            history.take_undo()
        };
        let Some(entry) = entry else {
            return off_thread(move || db.empty_change()).await;
        };

        let mut ops = entry.inverse.clone();
        ops.reverse();
        match off_thread(move || db.apply_ops(&ops)).await {
            Ok(changes) => {
                lock_history(&history)?.push_redo(entry);
                Ok(changes)
            }
            Err(error) => {
                let _ = lock_history(&history).map(|mut history| history.restore_undo(entry));
                Err(error)
            }
        }
    }

    /// Reapplies the last undone command.
    pub async fn redo(this: Instance<Self>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        let history = this.with(|document| document.history.clone());
        let entry = {
            let mut history = lock_history(&history)?;
            history.take_redo()
        };
        let Some(entry) = entry else {
            return off_thread(move || db.empty_change()).await;
        };

        let ops = entry.forward.clone();
        match off_thread(move || db.apply_ops(&ops)).await {
            Ok(changes) => {
                lock_history(&history)?.push_undo_after_redo(entry);
                Ok(changes)
            }
            Err(error) => {
                let _ = lock_history(&history).map(|mut history| history.push_redo(entry));
                Err(error)
            }
        }
    }
}

#[native_module("@flow/native")]
fn native(registry: &mut Registry) {
    registry.class::<Document>();
}

fn push_history(history: &Arc<Mutex<History>>, mutation: Mutation) -> Result<ChangeSet, String> {
    lock_history(history)?.push(HistoryEntry {
        forward: mutation.forward,
        inverse: mutation.inverse,
    });
    Ok(mutation.changes)
}

fn lock_history(
    history: &Arc<Mutex<History>>,
) -> Result<std::sync::MutexGuard<'_, History>, String> {
    history
        .lock()
        .map_err(|_| "the undo history lock is poisoned".to_owned())
}

/// Runs SQLite work on NSH's blocking pool, so the engine thread is free.
async fn off_thread<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    blocking(work)
        .await
        .map_err(|error| format!("the database task failed: {error}"))?
}
