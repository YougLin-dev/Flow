use crate::types::{EdgeSummary, NodeSummary};

/// A complete node row, kept so an undo can restore a deleted node with its
/// search entries.
#[derive(Debug, Clone)]
pub struct NodeRow {
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
    pub data_json: String,
    pub rev: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl NodeRow {
    pub fn summary(&self) -> NodeSummary {
        NodeSummary {
            id: self.id.clone(),
            kind: self.kind.clone(),
            title: self.title.clone(),
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            z: self.z,
            rev: self.rev as f64,
            data_json: self.data_json.clone(),
        }
    }
}

/// A complete edge row, kept so deleting a node can restore its edges.
#[derive(Debug, Clone)]
pub struct EdgeRow {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: Option<String>,
    pub to_port: Option<String>,
    pub kind: String,
    pub data_json: String,
}

impl EdgeRow {
    pub fn summary(&self) -> EdgeSummary {
        EdgeSummary {
            id: self.id.clone(),
            from_id: self.from_id.clone(),
            to_id: self.to_id.clone(),
            from_port: self.from_port.clone(),
            to_port: self.to_port.clone(),
            kind: self.kind.clone(),
            data_json: self.data_json.clone(),
        }
    }
}

/// One reversible database operation.
#[derive(Debug, Clone)]
pub enum HistoryOp {
    Insert(NodeRow),
    Delete {
        id: String,
    },
    Position {
        id: String,
        x: f64,
        y: f64,
    },
    Bounds {
        id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Text {
        id: String,
        title: String,
        body: String,
        tags: Vec<String>,
    },
    InsertEdge(EdgeRow),
    DeleteEdge {
        id: String,
    },
}

/// The forward and inverse operations of one user action.
#[derive(Debug, Clone, Default)]
pub struct HistoryEntry {
    pub forward: Vec<HistoryOp>,
    pub inverse: Vec<HistoryOp>,
}

/// In-memory undo/redo history. The document is persisted by SQLite; this
/// stack only lives for the current process.
#[derive(Debug, Default)]
pub struct History {
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
}

impl History {
    const LIMIT: usize = 200;

    pub fn push(&mut self, entry: HistoryEntry) {
        if entry.forward.is_empty() {
            return;
        }
        self.undo.push(entry);
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn take_undo(&mut self) -> Option<HistoryEntry> {
        self.undo.pop()
    }

    pub fn take_redo(&mut self) -> Option<HistoryEntry> {
        self.redo.pop()
    }

    pub fn restore_undo(&mut self, entry: HistoryEntry) {
        self.undo.push(entry);
    }

    pub fn push_redo(&mut self, entry: HistoryEntry) {
        self.redo.push(entry);
    }

    pub fn push_undo_after_redo(&mut self, entry: HistoryEntry) {
        self.undo.push(entry);
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}
