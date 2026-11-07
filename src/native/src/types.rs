use nsh_core::prelude::*;

/// A world-space rectangle used to query the canvas viewport.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A node to create. `id` is supplied by the caller so TSX can reference a
/// node before the write completes.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodeInput {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    /// Node-specific properties as JSON; the core stores and returns it as-is.
    pub data_json: Option<String>,
}

/// The part of a node a viewport or change set needs.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodeSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    pub rev: f64,
    pub data_json: String,
}

/// One connection between two nodes.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct EdgeInput {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: Option<String>,
    pub to_port: Option<String>,
    pub kind: String,
    pub data_json: Option<String>,
}

/// The part of an edge a viewport or change set needs.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct EdgeSummary {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: Option<String>,
    pub to_port: Option<String>,
    pub kind: String,
    pub data_json: String,
}

/// A node's persisted geometry, used to finish a drag or resize.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodeBounds {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Everything the canvas needs for one viewport.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SceneSnapshot {
    pub rev: f64,
    pub nodes: Vec<NodeSummary>,
    pub edges: Vec<EdgeSummary>,
}

/// The nodes and edges a command changed and the ones it removed.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ChangeSet {
    pub rev: f64,
    pub changed: Vec<NodeSummary>,
    pub removed: Vec<String>,
    pub edges_changed: Vec<EdgeSummary>,
    pub edges_removed: Vec<String>,
}

/// Optional structured filters for a search.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct SearchFilters {
    pub kind: Option<String>,
}

/// One full-text result. `score` is higher for a better match.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SearchHit {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}
