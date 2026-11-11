//! Flow's document and search core.
//!
//! TSX never opens SQLite. It talks to this crate through the generated
//! `@flow/native` module; the canvas stays on the TSX side.

use nsh_core::prelude::*;

mod asset;
mod clock;
mod constants;
mod db;
mod detail;
mod document;
mod edge_index;
mod entity;
mod history;
mod mutation;
mod scene;
mod schema;
mod search;
mod types;
mod viewport;
#[cfg(windows)]
mod wheel_surface;

/// Registers the canvas's wheel sensor with the NSH host. The host calls this
/// for every view it makes, before the app's own registrations.
#[cfg(windows)]
#[nsh_core::element::native_components(windows)]
fn native_components(components: &nsh_platform_windows::Components) {
    components.register(
        "flow.wheel-surface",
        std::rc::Rc::new(|context| Box::new(wheel_surface::WheelSurface::new(context))),
    );
}

use db::Database;
use types::{
    AssetInput, AssetSummary, ChangeSet, EdgeInput, InputItemInput, InputItemSummary, NodeBounds,
    NodeDetail, NodeInput, NodePreview, NodeSummary, Overview, ResultBatchInput, ResultItemInput,
    SceneSnapshot, SearchFilters, SearchHit, Viewport,
};

/// The open Flow document.
///
/// The database is owned by Rust. The class is created with
/// `Document.open(path)`; there is deliberately no public constructor.
#[class]
pub struct Document {
    db: Database,
}

#[class]
impl Document {
    /// Opens `path`; creates the file and its schema when missing.
    pub async fn open(path: String) -> Result<Document, String> {
        let db = off_thread(move || Database::open(&path)).await?;
        Ok(Document { db })
    }

    /// Inserts nodes; the returned change set contains their summaries.
    pub async fn insert_nodes(
        this: Instance<Self>,
        nodes: Vec<NodeInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.insert_nodes(nodes).map(|mutation| mutation.changes)).await
    }

    /// Moves nodes by `dx`/`dy`; one drag is one call.
    pub async fn move_nodes(
        this: Instance<Self>,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.move_nodes(ids, dx, dy).map(|mutation| mutation.changes)).await
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
        off_thread(move || {
            db.set_node_text(id, title, body, tags)
                .map(|mutation| mutation.changes)
        })
        .await
    }

    /// Replaces a node's kind settings (opaque JSON).
    pub async fn set_node_settings(
        this: Instance<Self>,
        id: String,
        settings_json: String,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || {
            db.set_node_settings(id, settings_json)
                .map(|mutation| mutation.changes)
        })
        .await
    }

    /// A text node's manual edit, producing one new text result item.
    pub async fn set_manual_text(
        this: Instance<Self>,
        id: String,
        text: String,
        batch: ResultBatchInput,
        item: ResultItemInput,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || {
            db.set_manual_text(id, text, batch, item)
                .map(|mutation| mutation.changes)
        })
        .await
    }

    /// Connects two nodes and snapshots the source's current output items.
    pub async fn connect_edge(this: Instance<Self>, edge: EdgeInput) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.connect_edge(edge).map(|mutation| mutation.changes)).await
    }

    /// Connects several pairs in one transaction and undo step.
    pub async fn connect_edges(
        this: Instance<Self>,
        edges: Vec<EdgeInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.connect_edges(edges).map(|mutation| mutation.changes)).await
    }

    /// Reconnects an edge and rebuilds the target's snapshot for it.
    pub async fn update_edge(this: Instance<Self>, edge: EdgeInput) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.update_edge(edge).map(|mutation| mutation.changes)).await
    }

    /// Appends one local input item.
    pub async fn add_input(
        this: Instance<Self>,
        input: InputItemInput,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.add_input(input).map(|mutation| mutation.changes)).await
    }

    /// Removes one input item; the edge itself stays.
    pub async fn remove_input(this: Instance<Self>, id: String) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.remove_input(id).map(|mutation| mutation.changes)).await
    }

    /// Reorders a node's input items by id.
    pub async fn reorder_inputs(
        this: Instance<Self>,
        node_id: String,
        ids: Vec<String>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || {
            db.reorder_inputs(node_id, ids)
                .map(|mutation| mutation.changes)
        })
        .await
    }

    /// Rebuilds a node's edge inputs from the sources' current batches.
    pub async fn sync_inputs(
        this: Instance<Self>,
        node_id: String,
    ) -> Result<Vec<InputItemSummary>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.sync_inputs(node_id)).await
    }

    /// Persists a provider run's immutable batch and items.
    pub async fn save_run(
        this: Instance<Self>,
        batch: ResultBatchInput,
        items: Vec<ResultItemInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.save_run(batch, items)).await
    }

    /// Sets a node's run status without touching its results.
    pub async fn set_node_status(
        this: Instance<Self>,
        id: String,
        status: String,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.set_node_status(id, status)).await
    }

    /// Turns runs left running by a previous process into interrupted.
    pub async fn recover_runs(this: Instance<Self>) -> Result<u32, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.recover_runs()).await
    }

    /// One node with its output batch and input list, for the composer.
    pub async fn node_detail(
        this: Instance<Self>,
        id: String,
    ) -> Result<Option<NodeDetail>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.node_detail(id)).await
    }

    /// The first items of several nodes' current batches, for card previews.
    pub async fn previews(
        this: Instance<Self>,
        ids: Vec<String>,
    ) -> Result<Vec<NodePreview>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.previews(ids)).await
    }

    /// Stores asset bytes content-addressed and returns the (possibly existing)
    /// asset summary.
    pub async fn import_asset(
        this: Instance<Self>,
        input: AssetInput,
    ) -> Result<AssetSummary, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.import_asset(input)).await
    }

    /// An asset's bytes, for a blob or data URL in TSX.
    pub async fn asset_bytes(this: Instance<Self>, id: String) -> Result<Vec<u8>, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.asset_bytes(id)).await
    }

    /// Deletes nodes and their edges.
    pub async fn delete_nodes(this: Instance<Self>, ids: Vec<String>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.delete_nodes(ids).map(|mutation| mutation.changes)).await
    }

    /// Finishes a drag or resize: one call for every moved or resized node.
    pub async fn set_node_bounds(
        this: Instance<Self>,
        nodes: Vec<NodeBounds>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.set_node_bounds(nodes).map(|mutation| mutation.changes)).await
    }

    /// Inserts edges whose endpoints already exist.
    pub async fn insert_edges(
        this: Instance<Self>,
        edges: Vec<EdgeInput>,
    ) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.insert_edges(edges).map(|mutation| mutation.changes)).await
    }

    /// Deletes edges by id.
    pub async fn delete_edges(this: Instance<Self>, ids: Vec<String>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.delete_edges(ids).map(|mutation| mutation.changes)).await
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
        max_cards: u64,
    ) -> Result<SceneSnapshot, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.scene(rect, margin, max_cards)).await
    }

    /// The whole document's content bounds, for Fit.
    pub async fn bounds(this: Instance<Self>) -> Result<Viewport, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.bounds()).await
    }

    /// The whole document's card silhouettes, for the minimap.
    pub async fn overview(this: Instance<Self>) -> Result<Overview, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.overview()).await
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

    /// Whether the open document has neither nodes nor edges.
    pub async fn is_empty(this: Instance<Self>) -> Result<bool, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.is_empty()).await
    }

    /// Reverts the last command.
    pub async fn undo(this: Instance<Self>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.undo()).await
    }

    /// Reapplies the last undone command.
    pub async fn redo(this: Instance<Self>) -> Result<ChangeSet, String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.redo()).await
    }

    /// Drops the in-memory undo/redo stacks (for example after seeding).
    pub async fn clear_history(this: Instance<Self>) -> Result<(), String> {
        let db = this.with(|document| document.db.clone());
        off_thread(move || db.clear_history()).await
    }
}

#[native_module("@flow/native")]
fn native(registry: &mut Registry) {
    registry.class::<Document>();
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
