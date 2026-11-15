use std::collections::BTreeSet;

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
    pub settings_json: String,
    pub status: String,
    pub output_batch_id: Option<String>,
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
            body: self.body.clone(),
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            z: self.z,
            rev: self.rev as f64,
            data_json: self.data_json.clone(),
            settings_json: self.settings_json.clone(),
            status: self.status.clone(),
            output_batch_id: self.output_batch_id.clone(),
        }
    }
}

/// A complete edge row, kept so deleting a node can restore its edges.
#[derive(Debug, Clone)]
pub struct EdgeRow {
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
}

impl EdgeRow {
    pub fn summary(&self) -> EdgeSummary {
        EdgeSummary {
            id: self.id.clone(),
            from_id: self.from_id.clone(),
            to_id: self.to_id.clone(),
            from_port: self.from_port.clone(),
            to_port: self.to_port.clone(),
            port_kind: self.port_kind.clone(),
            from_offset: self.from_offset,
            to_offset: self.to_offset,
            kind: self.kind.clone(),
            data_json: self.data_json.clone(),
            from_point: None,
            to_point: None,
        }
    }
}

/// A complete input row, kept so deleting an edge or node can restore it.
#[derive(Debug, Clone)]
pub struct InputRow {
    pub id: String,
    pub node_id: String,
    pub position: i32,
    pub port_id: String,
    pub kind: String,
    pub origin: String,
    pub edge_id: Option<String>,
    pub item_id: Option<String>,
    pub asset_id: Option<String>,
    pub text: String,
    pub meta_json: String,
    pub created_at: i64,
}

/// One reversible database operation.
#[derive(Debug, Clone)]
pub enum HistoryOp {
    Insert(NodeRow),
    Delete {
        id: String,
    },
    NodeGeometry {
        id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    NodeText {
        id: String,
        title: String,
        tags: Vec<String>,
    },
    /// Restores just a node's kind settings. Output, body and status belong to
    /// runs (which are not history) and must survive the undo of an edit.
    /// `mark_stale` is true on a forward/redo op, where a change to settings
    /// invalidates an existing output, and false on an undo op, which restores
    /// settings without touching the run-owned status.
    NodeSettings {
        id: String,
        settings_json: String,
        mark_stale: bool,
    },
    /// A guarded output transition. The op applies only when the node still
    /// points at `from_batch_id` with `from_body`; otherwise a run or another
    /// writer replaced the output and the entry is stale. Status is restored
    /// but not guarded: undoable input/settings edits may mark a node stale
    /// without replacing its output, and non-history status writes invalidate
    /// the entry through its references.
    NodeOutput {
        id: String,
        from_batch_id: Option<String>,
        from_body: String,
        from_status: String,
        to_batch_id: Option<String>,
        to_body: String,
        to_status: String,
    },
    InsertEdge(EdgeRow),
    ReplaceEdge(EdgeRow),
    DeleteEdge {
        id: String,
    },
    InsertInput(InputRow),
    DeleteInput {
        id: String,
    },
    InputOrder {
        node_id: String,
        order: Vec<(String, i32)>,
    },
}

/// The rows a history entry or a non-history write touches. A non-history
/// write removes every entry whose reference set intersects it.
#[derive(Debug, Clone, Default)]
pub struct HistoryRefs {
    pub nodes: BTreeSet<String>,
    pub batches: BTreeSet<String>,
    pub assets: BTreeSet<String>,
}

impl HistoryRefs {
    pub fn node(&mut self, id: impl Into<String>) {
        self.nodes.insert(id.into());
    }

    pub fn batch(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            self.batches.insert(id.to_owned());
        }
    }

    pub fn asset(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            self.assets.insert(id.to_owned());
        }
    }

    pub fn merge(&mut self, other: &Self) {
        self.nodes.extend(other.nodes.iter().cloned());
        self.batches.extend(other.batches.iter().cloned());
        self.assets.extend(other.assets.iter().cloned());
    }

    pub fn intersects(&self, other: &Self) -> bool {
        intersects(&self.nodes, &other.nodes)
            || intersects(&self.batches, &other.batches)
            || intersects(&self.assets, &other.assets)
    }

    fn add_op(&mut self, op: &HistoryOp) {
        match op {
            HistoryOp::Insert(row) => {
                self.node(row.id.clone());
                self.batch(row.output_batch_id.as_deref());
            }
            HistoryOp::Delete { id } => self.node(id.clone()),
            HistoryOp::NodeGeometry { id, .. }
            | HistoryOp::NodeText { id, .. }
            | HistoryOp::NodeSettings { id, .. } => self.node(id.clone()),
            HistoryOp::NodeOutput {
                id,
                from_batch_id,
                to_batch_id,
                ..
            } => {
                self.node(id.clone());
                self.batch(from_batch_id.as_deref());
                self.batch(to_batch_id.as_deref());
            }
            HistoryOp::InsertEdge(row) | HistoryOp::ReplaceEdge(row) => {
                self.node(row.from_id.clone());
                self.node(row.to_id.clone());
            }
            HistoryOp::DeleteEdge { .. } | HistoryOp::DeleteInput { .. } => {}
            HistoryOp::InsertInput(row) => {
                self.node(row.node_id.clone());
                self.asset(row.asset_id.as_deref());
            }
            HistoryOp::InputOrder { node_id, .. } => self.node(node_id.clone()),
        }
    }
}

fn intersects(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    left.iter().any(|id| right.contains(id))
}

/// The forward and inverse operations of one user action.
#[derive(Debug, Clone, Default)]
pub struct HistoryEntry {
    pub forward: Vec<HistoryOp>,
    pub inverse: Vec<HistoryOp>,
    /// Nodes, batches and assets this entry depends on.
    pub refs: HistoryRefs,
    /// Estimated serialized payload, used by the memory budget.
    pub byte_size: usize,
}

impl HistoryEntry {
    pub fn new(forward: Vec<HistoryOp>, inverse: Vec<HistoryOp>, extra_refs: &HistoryRefs) -> Self {
        let mut refs = HistoryRefs::default();
        for op in forward.iter().chain(&inverse) {
            refs.add_op(op);
        }
        refs.merge(extra_refs);
        let byte_size = forward
            .iter()
            .chain(&inverse)
            .map(op_byte_size)
            .sum::<usize>()
            + 64;
        Self {
            forward,
            inverse,
            refs,
            byte_size,
        }
    }
}

fn op_byte_size(op: &HistoryOp) -> usize {
    const OP_OVERHEAD: usize = 64;
    let payload = match op {
        HistoryOp::Insert(row) => {
            row.id.len()
                + row.kind.len()
                + row.title.len()
                + row.body.len()
                + row.tags.iter().map(String::len).sum::<usize>()
                + row.data_json.len()
                + row.settings_json.len()
                + row.status.len()
                + row.output_batch_id.as_ref().map_or(0, String::len)
        }
        HistoryOp::Delete { id } | HistoryOp::DeleteEdge { id } | HistoryOp::DeleteInput { id } => {
            id.len()
        }
        HistoryOp::NodeGeometry { id, .. } => id.len(),
        HistoryOp::NodeText { id, title, tags } => {
            id.len() + title.len() + tags.iter().map(String::len).sum::<usize>()
        }
        HistoryOp::NodeSettings {
            id, settings_json, ..
        } => id.len() + settings_json.len(),
        HistoryOp::NodeOutput {
            id,
            from_batch_id,
            from_body,
            from_status,
            to_batch_id,
            to_body,
            to_status,
        } => {
            id.len()
                + from_batch_id.as_ref().map_or(0, String::len)
                + from_body.len()
                + from_status.len()
                + to_batch_id.as_ref().map_or(0, String::len)
                + to_body.len()
                + to_status.len()
        }
        HistoryOp::InsertEdge(row) | HistoryOp::ReplaceEdge(row) => {
            row.id.len()
                + row.from_id.len()
                + row.to_id.len()
                + row.from_port.len()
                + row.to_port.len()
                + row.port_kind.len()
                + row.kind.len()
                + row.data_json.len()
        }
        HistoryOp::InsertInput(row) => {
            row.id.len()
                + row.node_id.len()
                + row.port_id.len()
                + row.kind.len()
                + row.origin.len()
                + row.edge_id.as_ref().map_or(0, String::len)
                + row.item_id.as_ref().map_or(0, String::len)
                + row.asset_id.as_ref().map_or(0, String::len)
                + row.text.len()
                + row.meta_json.len()
        }
        HistoryOp::InputOrder { node_id, order } => {
            node_id.len() + order.iter().map(|(id, _)| id.len() + 4).sum::<usize>()
        }
    };
    OP_OVERHEAD + payload
}

/// In-memory undo/redo history. The document is persisted by SQLite; this
/// stack only lives for the current process.
#[derive(Debug, Default)]
pub struct History {
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    size: usize,
}

impl History {
    const LIMIT: usize = 200;
    const BYTE_LIMIT: usize = 64 * 1024 * 1024;

    pub fn push(&mut self, entry: HistoryEntry) {
        if entry.forward.is_empty() {
            return;
        }
        let redo_size: usize = self.redo.iter().map(|entry| entry.byte_size).sum();
        self.redo.clear();
        self.size -= redo_size;
        self.size += entry.byte_size;
        self.undo.push(entry);
        self.trim();
    }

    fn trim(&mut self) {
        // Keep the newest entry even when it alone exceeds the byte budget:
        // overflow evicts older entries, never the command just applied.
        while self.undo.len() + self.redo.len() > Self::LIMIT
            || (self.size > Self::BYTE_LIMIT && self.undo.len() > 1)
        {
            let removed = if !self.undo.is_empty() {
                self.undo.remove(0)
            } else if !self.redo.is_empty() {
                self.redo.remove(0)
            } else {
                break;
            };
            self.size -= removed.byte_size;
        }
    }

    pub fn take_undo(&mut self) -> Option<HistoryEntry> {
        let entry = self.undo.pop();
        if let Some(entry) = &entry {
            self.size -= entry.byte_size;
        }
        entry
    }

    pub fn take_redo(&mut self) -> Option<HistoryEntry> {
        let entry = self.redo.pop();
        if let Some(entry) = &entry {
            self.size -= entry.byte_size;
        }
        entry
    }

    pub fn restore_undo(&mut self, entry: HistoryEntry) {
        self.size += entry.byte_size;
        self.undo.push(entry);
    }

    pub fn push_redo(&mut self, entry: HistoryEntry) {
        self.size += entry.byte_size;
        self.redo.push(entry);
    }

    pub fn push_undo_after_redo(&mut self, entry: HistoryEntry) {
        self.size += entry.byte_size;
        self.undo.push(entry);
    }

    /// Drops every entry that touches `refs` and clears redo. Every
    /// non-history write calls this with the rows it wrote.
    pub fn invalidate(&mut self, refs: &HistoryRefs) {
        let mut kept = Vec::with_capacity(self.undo.len());
        let mut size = 0;
        for entry in self.undo.drain(..) {
            if entry.refs.intersects(refs) {
                continue;
            }
            size += entry.byte_size;
            kept.push(entry);
        }
        self.undo = kept;
        self.redo.clear();
        self.size = size;
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.size = 0;
    }

    #[cfg(test)]
    fn undo_len(&self) -> usize {
        self.undo.len()
    }

    #[cfg(test)]
    fn byte_size(&self) -> usize {
        self.size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, refs: HistoryRefs, byte_size: usize) -> HistoryEntry {
        HistoryEntry {
            forward: vec![HistoryOp::Delete { id: id.to_owned() }],
            inverse: Vec::new(),
            refs,
            byte_size,
        }
    }

    #[test]
    fn the_byte_budget_evicts_the_oldest_entry() {
        let mut history = History::default();
        history.push(entry("old", HistoryRefs::default(), 40 * 1024 * 1024));
        history.push(entry("new", HistoryRefs::default(), 40 * 1024 * 1024));

        assert_eq!(history.undo_len(), 1);
        assert_eq!(history.byte_size(), 40 * 1024 * 1024);
        let kept = history.take_undo().expect("the newest entry survives");
        assert!(matches!(
            kept.forward.as_slice(),
            [HistoryOp::Delete { id }] if id == "new"
        ));
    }

    #[test]
    fn an_entry_over_the_byte_budget_is_kept_as_the_newest() {
        let mut history = History::default();
        history.push(entry("old", HistoryRefs::default(), 1));
        history.push(entry("huge", HistoryRefs::default(), 80 * 1024 * 1024));

        assert_eq!(history.undo_len(), 1);
        assert_eq!(history.byte_size(), 80 * 1024 * 1024);
        let kept = history.take_undo().expect("the newest entry survives");
        assert!(matches!(
            kept.forward.as_slice(),
            [HistoryOp::Delete { id }] if id == "huge"
        ));
    }

    #[test]
    fn the_entry_cap_evicts_the_oldest_entry() {
        let mut history = History::default();
        for index in 0..=History::LIMIT {
            history.push(entry(&index.to_string(), HistoryRefs::default(), 1));
        }
        assert_eq!(history.undo_len(), History::LIMIT);
        let newest = history.take_undo().expect("newest");
        assert!(matches!(
            newest.forward.as_slice(),
            [HistoryOp::Delete { id }] if id == &History::LIMIT.to_string()
        ));
    }

    #[test]
    fn a_new_entry_clears_redo_and_its_bytes() {
        let mut history = History::default();
        history.push(entry("a", HistoryRefs::default(), 100));
        let undone = history.take_undo().expect("undo");
        history.push_redo(undone);
        assert_eq!(history.byte_size(), 100);

        history.push(entry("b", HistoryRefs::default(), 30));
        assert_eq!(history.byte_size(), 30);
        assert!(history.take_redo().is_none());
    }

    #[test]
    fn a_taken_entry_stops_counting_and_a_dropped_entry_leaks_nothing() {
        let mut history = History::default();
        history.push(entry("a", HistoryRefs::default(), 100));
        let taken = history.take_undo().expect("take the entry");
        assert_eq!(history.byte_size(), 0);
        drop(taken);

        history.push(entry("b", HistoryRefs::default(), 30));
        assert_eq!(history.byte_size(), 30);
        assert_eq!(history.undo_len(), 1);

        let taken = history.take_undo().expect("take b");
        history.restore_undo(taken);
        assert_eq!(history.byte_size(), 30);

        let taken = history.take_undo().expect("take b again");
        history.push_redo(taken);
        assert_eq!(history.byte_size(), 30);

        let taken = history.take_redo().expect("take from redo");
        assert_eq!(history.byte_size(), 0);
        history.push_undo_after_redo(taken);
        assert_eq!(history.byte_size(), 30);
    }

    #[test]
    fn invalidate_drops_matching_entries_and_clears_redo() {
        let mut history = History::default();
        let mut refs_a = HistoryRefs::default();
        refs_a.node("a");
        let mut refs_b = HistoryRefs::default();
        refs_b.batch(Some("batch"));
        history.push(entry("a", refs_a, 10));
        history.push(entry("b", refs_b, 20));

        let undone = history.take_undo().expect("undo b");
        history.push_redo(undone);

        let mut write = HistoryRefs::default();
        write.node("a");
        history.invalidate(&write);

        assert!(history.take_undo().is_none());
        assert!(history.take_redo().is_none());
        assert_eq!(history.byte_size(), 0);
    }

    #[test]
    fn an_entry_collects_node_batch_and_asset_references_from_ops() {
        let mut extra = HistoryRefs::default();
        extra.asset(Some("asset-extra"));
        let entry = HistoryEntry::new(
            vec![HistoryOp::NodeOutput {
                id: "node".to_owned(),
                from_batch_id: None,
                from_body: String::new(),
                from_status: "idle".to_owned(),
                to_batch_id: Some("batch".to_owned()),
                to_body: "body".to_owned(),
                to_status: "done".to_owned(),
            }],
            vec![HistoryOp::InsertInput(InputRow {
                id: "input".to_owned(),
                node_id: "target".to_owned(),
                position: 0,
                port_id: "in".to_owned(),
                kind: "text".to_owned(),
                origin: "edge".to_owned(),
                edge_id: None,
                item_id: None,
                asset_id: Some("asset".to_owned()),
                text: String::new(),
                meta_json: "{}".to_owned(),
                created_at: 0,
            })],
            &extra,
        );

        assert!(entry.refs.nodes.contains("node"));
        assert!(entry.refs.nodes.contains("target"));
        assert!(entry.refs.batches.contains("batch"));
        assert!(entry.refs.assets.contains("asset"));
        assert!(entry.refs.assets.contains("asset-extra"));
        assert!(entry.byte_size > 0);
    }

    #[test]
    fn byte_size_counts_payload_in_the_inverse_ops() {
        let payload = "x".repeat(10_000);
        let entry = HistoryEntry::new(
            Vec::new(),
            vec![HistoryOp::NodeText {
                id: "node".to_owned(),
                title: payload.clone(),
                tags: Vec::new(),
            }],
            &HistoryRefs::default(),
        );

        assert!(entry.byte_size >= payload.len());
    }
}
