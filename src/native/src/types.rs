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
    /// The kind's opaque settings as JSON; defaults to `{}`.
    pub settings_json: Option<String>,
}

/// The part of a node a viewport or change set needs.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodeSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    pub rev: f64,
    pub data_json: String,
    pub settings_json: String,
    pub status: String,
    pub output_batch_id: Option<String>,
}

/// One connection between two nodes' ports.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct EdgeInput {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: String,
    pub to_port: String,
    pub port_kind: String,
    pub from_offset: f64,
    pub to_offset: f64,
    pub kind: String,
    pub data_json: Option<String>,
}

/// A connector endpoint's world point.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct EdgePoint {
    pub x: f64,
    pub y: f64,
}

impl EdgePoint {
    /// An output port: the card's right edge at `offset` from its top.
    pub fn output(x: f64, y: f64, width: f64, offset: f64) -> Self {
        Self {
            x: x + width,
            y: y + offset,
        }
    }

    /// An input port: the card's left edge at `offset` from its top.
    pub fn input(x: f64, y: f64, offset: f64) -> Self {
        Self { x, y: y + offset }
    }
}

/// The part of an edge a viewport or change set needs.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct EdgeSummary {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: String,
    pub to_port: String,
    pub port_kind: String,
    pub from_offset: f64,
    pub to_offset: f64,
    pub kind: String,
    pub data_json: String,
    /// The from card's output port, when the read knows that card.
    pub from_point: Option<EdgePoint>,
    /// The to card's input port, when the read knows that card.
    pub to_point: Option<EdgePoint>,
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

/// One asset whose bytes Rust should store content-addressed. `id` is
/// supplied by TSX; if the bytes already exist the existing asset wins.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct AssetInput {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
    pub meta_json: Option<String>,
}

/// An asset the document refers to. Bytes are read with `assetBytes`.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct AssetSummary {
    pub id: String,
    pub hash: String,
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: f64,
    pub meta_json: String,
    pub created_at: f64,
}

/// One item of a result batch, to store.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ResultItemInput {
    pub id: String,
    pub position: f64,
    pub port_id: String,
    pub kind: String,
    pub text: String,
    pub asset_id: Option<String>,
    pub meta_json: Option<String>,
}

/// One immutable result batch, to store.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ResultBatchInput {
    pub id: String,
    pub node_id: String,
    /// `run` for a provider run, `manual` for a text-node edit.
    pub trigger: String,
    pub provider: String,
    pub model: String,
    pub params_json: String,
    /// `done`, `failed`, `cancelled`, `running` or `interrupted`.
    pub status: String,
    pub error: Option<String>,
}

/// One item of a result batch, as read back.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ResultItemSummary {
    pub id: String,
    pub batch_id: String,
    pub position: f64,
    pub port_id: String,
    pub kind: String,
    pub text: String,
    pub asset_id: Option<String>,
    pub meta_json: String,
    pub asset: Option<AssetSummary>,
}

/// A result batch with its items, as read back.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ResultBatchSummary {
    pub id: String,
    pub node_id: String,
    pub trigger: String,
    pub provider: String,
    pub model: String,
    pub params_json: String,
    pub status: String,
    pub error: String,
    pub created_at: f64,
    pub items: Vec<ResultItemSummary>,
}

/// One input item of a node, to add.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct InputItemInput {
    pub id: String,
    pub node_id: String,
    pub position: f64,
    pub port_id: String,
    pub kind: String,
    /// `edge` or `local`.
    pub origin: String,
    pub edge_id: Option<String>,
    pub item_id: Option<String>,
    pub asset_id: Option<String>,
    pub text: String,
    pub meta_json: Option<String>,
}

/// One input item of a node, as read back. An edge item carries the resolved
/// result item; a local image carries its asset.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct InputItemSummary {
    pub id: String,
    pub node_id: String,
    pub position: f64,
    pub port_id: String,
    pub kind: String,
    pub origin: String,
    pub edge_id: Option<String>,
    pub item_id: Option<String>,
    pub asset_id: Option<String>,
    pub text: String,
    pub meta_json: String,
    /// The upstream node that contributed this item, for grouping.
    pub source_node_id: Option<String>,
    pub source_title: Option<String>,
    pub item: Option<ResultItemSummary>,
    pub asset: Option<AssetSummary>,
}

/// How many connectors enter one input port. The capacity is a port's edge
/// slots, so this is the composer's occupancy even when a source produced no
/// items (and therefore no rows).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PortIncoming {
    pub port_id: String,
    pub edges: f64,
}

/// Everything a node's composer needs, in one read.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodeDetail {
    pub node: NodeSummary,
    /// The node's current output, when it has one (failed and cancelled runs
    /// keep the previous output).
    pub batch: Option<ResultBatchSummary>,
    /// The newest batch of any status, for the composer's error/status line.
    pub latest_batch: Option<ResultBatchSummary>,
    pub inputs: Vec<InputItemSummary>,
    /// One entry per input port that has at least one connector.
    pub incoming: Vec<PortIncoming>,
}

/// The readable preview of a node's current batch: the first few items and
/// the total count, for cards rather than the composer.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NodePreview {
    pub node_id: String,
    pub item_count: f64,
    pub items: Vec<ResultItemSummary>,
}

/// Everything the canvas needs for one viewport.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SceneSnapshot {
    pub rev: f64,
    pub nodes: Vec<NodeSummary>,
    pub edges: Vec<EdgeSummary>,
}

/// One card silhouette the minimap draws, without content or styling.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct OverviewCard {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The whole document's bounds and a sampled set of card silhouettes, for
/// the minimap. The sample is deterministic and capped, so the read stays
/// coarse no matter how large the document is.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Overview {
    pub rev: f64,
    pub bounds: Viewport,
    pub cards: Vec<OverviewCard>,
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
