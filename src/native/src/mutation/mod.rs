//! Document writes. Every user action is one transaction; the transaction
//! returns both the visible change set and the operations that undo it.

use crate::history::{HistoryOp, HistoryRefs};
use crate::types::ChangeSet;

mod apply;
mod edges;
mod inputs;
mod manual;
mod nodes;
mod runs;
mod seed;
mod support;
mod tx;

pub use apply::{ApplyOutcome, apply_ops};
pub use edges::{connect_edge, connect_edges, delete_edges, insert_edges, update_edge};
pub use inputs::{add_input, remove_input, reorder_inputs, sync_inputs};
pub use manual::{insert_upload_node, set_manual_text, set_manual_upload};
pub use nodes::{
    delete_nodes, insert_nodes, move_nodes, set_node_bounds, set_node_settings, set_node_text,
};
pub use runs::{begin_run, recover_runs, save_run, set_node_status, settle_run};
pub use seed::seed_document;

/// A write and the history needed to reverse it.
pub struct Mutation {
    pub changes: ChangeSet,
    pub forward: Vec<HistoryOp>,
    pub inverse: Vec<HistoryOp>,
    /// References the ops themselves cannot see, such as an upload's assets.
    pub refs: HistoryRefs,
}

impl Mutation {
    /// Assembles a write whose undo needs no references beyond its ops.
    pub(in crate::mutation) fn commit(
        changes: ChangeSet,
        forward: Vec<HistoryOp>,
        inverse: Vec<HistoryOp>,
    ) -> Self {
        Self::with_refs(changes, forward, inverse, HistoryRefs::default())
    }

    /// Assembles a write whose undo also restores out-of-band references,
    /// such as an upload's assets.
    pub(in crate::mutation) fn with_refs(
        changes: ChangeSet,
        forward: Vec<HistoryOp>,
        inverse: Vec<HistoryOp>,
        refs: HistoryRefs,
    ) -> Self {
        Self {
            changes,
            forward,
            inverse,
            refs,
        }
    }
}
