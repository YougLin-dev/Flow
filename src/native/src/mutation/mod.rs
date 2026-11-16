//! Document writes. Every user action is one transaction; the transaction
//! returns both the visible change set and the operations that undo it.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{
    ActiveValue::{Set, Unchanged},
    ColumnTrait, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, QueryFilter,
};

use crate::clock::now_ms;
use crate::document;
use crate::edge_index;
use crate::entity::{node_inputs, nodes as node_rows};
use crate::history::{HistoryOp, HistoryRefs, InputRow};
use crate::types::{ChangeSet, NodeBounds};

mod edges;
mod inputs;
mod manual;
mod nodes;
mod runs;
mod seed;
mod support;
mod tx;

pub use edges::{connect_edge, connect_edges, delete_edges, insert_edges, update_edge};
pub use inputs::{add_input, remove_input, reorder_inputs, sync_inputs};
pub use manual::{insert_upload_node, set_manual_text, set_manual_upload};
pub use nodes::{
    delete_nodes, insert_nodes, move_nodes, set_node_bounds, set_node_settings, set_node_text,
};
pub use runs::{begin_run, recover_runs, save_run, set_node_status, settle_run};
pub use seed::seed_document;

use support::*;
use tx::edges::*;
use tx::inputs::*;
use tx::nodes::*;
use tx::runs::*;

/// A write and the history needed to reverse it.
pub struct Mutation {
    pub changes: ChangeSet,
    pub forward: Vec<HistoryOp>,
    pub inverse: Vec<HistoryOp>,
    /// References the ops themselves cannot see, such as an upload's assets.
    pub refs: HistoryRefs,
}

impl Mutation {
    fn new(changes: ChangeSet, forward: Vec<HistoryOp>, inverse: Vec<HistoryOp>) -> Self {
        Self {
            changes,
            forward,
            inverse,
            refs: HistoryRefs::default(),
        }
    }
}

/// The result of applying one history entry.
pub enum ApplyOutcome {
    Applied(ChangeSet),
    /// A guarded output no longer matches, or an operand is gone; no op in
    /// the entry ran.
    Stale,
}

/// Whether the entry's expected state is gone. Missing operands are stale,
/// not errors: a non-history write can invalidate the entry that would have
/// restored them, and a stale entry must be dropped rather than wedging undo.
fn node_available(
    txn: &DatabaseTransaction,
    id: &str,
    inserted: &BTreeSet<String>,
) -> Result<bool, DbErr> {
    Ok(inserted.contains(id) || find_node_opt_tx(txn, id)?.is_some())
}

fn edge_available(
    txn: &DatabaseTransaction,
    id: &str,
    inserted: &BTreeSet<String>,
) -> Result<bool, DbErr> {
    Ok(inserted.contains(id) || find_edge_opt_tx(txn, id)?.is_some())
}

fn op_is_stale(
    txn: &DatabaseTransaction,
    op: &HistoryOp,
    inserted_nodes: &BTreeSet<String>,
    inserted_edges: &BTreeSet<String>,
) -> Result<bool, DbErr> {
    match op {
        HistoryOp::Insert(row) => Ok(find_node_opt_tx(txn, &row.id)?.is_some()
            || find_node_by_seq_opt_tx(txn, row.seq)?.is_some()),
        HistoryOp::Delete { id } => Ok(!node_available(txn, id, inserted_nodes)?),
        HistoryOp::NodeGeometry { id, .. }
        | HistoryOp::NodeText { id, .. }
        | HistoryOp::NodeSettings { id, .. }
        | HistoryOp::InputOrder { node_id: id, .. } => {
            Ok(!node_available(txn, id, inserted_nodes)?)
        }
        HistoryOp::NodeOutput {
            id,
            from_batch_id,
            from_body,
            ..
        } => {
            if inserted_nodes.contains(id) {
                return Ok(true);
            }
            let Some(node) = find_node_opt_tx(txn, id)? else {
                return Ok(true);
            };
            // Status is restored by the op but is not guarded: undoable
            // input/settings edits legitimately mark a node stale without
            // replacing its output, and non-history status writes invalidate
            // the entry through its reference set.
            Ok(node.output_batch_id != *from_batch_id || node.body.as_str() != from_body.as_str())
        }
        HistoryOp::InsertEdge(row) => {
            if find_edge_opt_tx(txn, &row.id)?.is_some()
                || find_edge_by_seq_opt_tx(txn, row.seq)?.is_some()
            {
                return Ok(true);
            }
            if already_connected_tx(
                txn,
                &row.from_id,
                &row.from_port,
                &row.to_id,
                &row.to_port,
                &row.id,
            )? {
                return Ok(true);
            }
            Ok(!node_available(txn, &row.from_id, inserted_nodes)?
                || !node_available(txn, &row.to_id, inserted_nodes)?)
        }
        HistoryOp::ReplaceEdge(row) => {
            if !edge_available(txn, &row.id, inserted_edges)? {
                return Ok(true);
            }
            if already_connected_tx(
                txn,
                &row.from_id,
                &row.from_port,
                &row.to_id,
                &row.to_port,
                &row.id,
            )? {
                return Ok(true);
            }
            Ok(!node_available(txn, &row.from_id, inserted_nodes)?
                || !node_available(txn, &row.to_id, inserted_nodes)?)
        }
        HistoryOp::DeleteEdge { id } => Ok(!edge_available(txn, id, inserted_edges)?),
        HistoryOp::InsertInput(row) => Ok(!node_available(txn, &row.node_id, inserted_nodes)?),
        HistoryOp::DeleteInput { .. } => Ok(false),
    }
}

pub fn apply_ops(conn: &DatabaseConnection, ops: &[HistoryOp]) -> Result<ApplyOutcome, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        // Guard the whole entry before writing anything. A stale guarded op
        // or a missing operand must not leave an upload half-applied. Ops in
        // one entry may restore entities other ops use, so collect the
        // inserted ids first.
        let mut inserted_nodes = BTreeSet::new();
        let mut inserted_edges = BTreeSet::new();
        for op in ops {
            match op {
                HistoryOp::Insert(row) => {
                    let fresh = inserted_nodes.insert(row.id.clone());
                    if !fresh {
                        return Ok(ApplyOutcome::Stale);
                    }
                }
                HistoryOp::InsertEdge(row) => {
                    let fresh = inserted_edges.insert(row.id.clone());
                    if !fresh {
                        return Ok(ApplyOutcome::Stale);
                    }
                }
                _ => {}
            }
        }
        for op in ops {
            if op_is_stale(txn, op, &inserted_nodes, &inserted_edges)? {
                return Ok(ApplyOutcome::Stale);
            }
        }

        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut edges_changed = Vec::new();
        let mut edges_removed = Vec::new();
        let mut touched = BTreeSet::new();

        // An all-geometry run is one gesture's undo or redo. Applying the
        // whole run at the end lets the edge index see every final rect in one
        // pass; a mixed run keeps its recorded order so unrelated ops cannot
        // move around a geometry write.
        let coalesced_geometry = if ops
            .iter()
            .all(|op| matches!(op, HistoryOp::NodeGeometry { .. }))
        {
            let mut collected: Vec<NodeBounds> = Vec::new();
            for op in ops {
                let HistoryOp::NodeGeometry {
                    id,
                    x,
                    y,
                    width,
                    height,
                } = op
                else {
                    continue;
                };
                let bounds = NodeBounds {
                    id: id.clone(),
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                };
                match collected
                    .iter_mut()
                    .find(|existing| existing.id == bounds.id)
                {
                    Some(existing) => *existing = bounds,
                    None => collected.push(bounds),
                }
            }
            collected
        } else {
            Vec::new()
        };
        let mut dirty = false;

        for op in ops {
            match op {
                HistoryOp::Insert(row) => {
                    insert_row_tx(txn, row)?;
                    changed.push(row.summary());
                    dirty = true;
                }
                HistoryOp::Delete { id } => {
                    // A redo can delete a node a user has started a new run
                    // on since the undo; cancel it exactly like a fresh
                    // delete before the row goes.
                    cancel_running_batches_tx(txn, id)?;
                    let row = find_node_tx(txn, id)?;
                    // Mirror delete_nodes: edge snapshots on surviving nodes
                    // have no FK to the edge or item, so remove them here.
                    let removed_inputs = inputs_for_nodes_tx(txn, std::slice::from_ref(id))?;
                    let mut survivors = BTreeSet::new();
                    for input in &removed_inputs {
                        delete_input_tx(txn, &input.id)?;
                        if input.node_id != id.as_str() {
                            survivors.insert(input.node_id.clone());
                        }
                    }
                    for edge in edges_for_node_tx(txn, id)? {
                        edges_removed.push(edge.id);
                    }
                    delete_node_tx(txn, &row)?;
                    for survivor in survivors {
                        changed.push(node_row(&touch_node_tx(txn, &survivor)?).summary());
                    }
                    removed.push(id.clone());
                    dirty = true;
                }
                HistoryOp::NodeGeometry {
                    id,
                    x,
                    y,
                    width,
                    height,
                } => {
                    if coalesced_geometry.is_empty() {
                        let bounds = [NodeBounds {
                            id: id.clone(),
                            x: *x,
                            y: *y,
                            width: *width,
                            height: *height,
                        }];
                        let (rows, _) = set_node_bounds_batched(txn, &bounds)?;
                        if !rows.is_empty() {
                            dirty = true;
                        }
                        for row in rows {
                            changed.push(row.summary());
                        }
                    }
                }
                HistoryOp::NodeText { id, title, tags } => {
                    let before = find_node_tx(txn, id)?;
                    let row = update_text_tx(txn, &before, title, tags)?;
                    changed.push(row.summary());
                    dirty = true;
                }
                HistoryOp::NodeSettings {
                    id,
                    settings_json,
                    mark_stale,
                } => {
                    let before = find_node_tx(txn, id)?;
                    let row = if *mark_stale {
                        apply_settings_tx(txn, &before, settings_json.clone())?
                    } else {
                        // Undo restores settings without touching the
                        // run-owned status, so an upload's output restore
                        // keeps the status it just wrote.
                        restore_settings_tx(txn, &before, settings_json.clone())?
                    };
                    changed.push(row.summary());
                    dirty = true;
                }
                HistoryOp::NodeOutput {
                    id,
                    to_batch_id,
                    to_body,
                    to_status,
                    ..
                } => {
                    // The whole-entry preflight above proved the guard.
                    let before = find_node_tx(txn, id)?;
                    let updated = node_rows::Entity::update(node_rows::ActiveModel {
                        seq: Unchanged(before.seq),
                        body: Set(to_body.clone()),
                        status: Set(to_status.clone()),
                        output_batch_id: Set(to_batch_id.clone()),
                        rev: Set(before.rev + 1),
                        updated_at: Set(now_ms()),
                        ..Default::default()
                    })
                    .exec(txn)?;
                    changed.push(node_row(&updated).summary());
                    for row in mark_downstream_stale_tx(txn, id)? {
                        changed.push(node_row(&row).summary());
                    }
                    dirty = true;
                }
                HistoryOp::InsertEdge(row) => {
                    insert_edge_row_tx(txn, row)?;
                    let from = find_node_tx(txn, &row.from_id)?;
                    let to = find_node_tx(txn, &row.to_id)?;
                    edges_changed.push(edge_summary(row, &from, &to));
                    dirty = true;
                }
                HistoryOp::ReplaceEdge(row) => {
                    let row = replace_edge_row_tx(txn, row)?;
                    // As with DeleteEdge, a run between a reconnect and its
                    // undo/redo rebuilds this edge's snapshot under the
                    // source's current item ids, so the ids the history
                    // captured may be stale. Remove every row the edge
                    // contributed; the entry's InsertInput ops restore the
                    // state this replace returns to.
                    let rows = node_inputs::Entity::find()
                        .filter(node_inputs::Column::EdgeId.eq(row.id.clone()))
                        .all(txn)?;
                    for input in &rows {
                        delete_input_tx(txn, &input.id)?;
                        if touched.insert(input.node_id.clone()) {
                            changed.push(node_row(&touch_node_tx(txn, &input.node_id)?).summary());
                        }
                    }
                    let from = find_node_tx(txn, &row.from_id)?;
                    let to = find_node_tx(txn, &row.to_id)?;
                    edges_changed.push(edge_summary(&row, &from, &to));
                    dirty = true;
                }
                HistoryOp::DeleteEdge { id } => {
                    let edge = find_edge_tx(txn, id)?;
                    // Input sync during a run recreates an edge's snapshot rows
                    // under the source's current item ids, so undo/redo cannot
                    // rely on the ids the history captured: remove every row
                    // the edge contributed.
                    let rows = node_inputs::Entity::find()
                        .filter(node_inputs::Column::EdgeId.eq(id.clone()))
                        .all(txn)?;
                    for row in &rows {
                        delete_input_tx(txn, &row.id)?;
                        if touched.insert(row.node_id.clone()) {
                            changed.push(node_row(&touch_node_tx(txn, &row.node_id)?).summary());
                        }
                    }
                    delete_edge_tx(txn, id)?;
                    edges_removed.push(edge.id);
                    dirty = true;
                }
                HistoryOp::InsertInput(_) => {
                    // Restored in one pass per port after the whole entry has
                    // applied, so every node and edge the rows depend on is
                    // in place and the result cannot depend on op order.
                    dirty = true;
                }
                HistoryOp::DeleteInput { id } => {
                    // Input sync during a run may already have removed the
                    // row an undo/redo wanted to delete; that is the same
                    // end state, not an error.
                    let Some(row) = node_inputs::Entity::find_by_id(id.clone()).one(txn)? else {
                        continue;
                    };
                    delete_input_tx(txn, id)?;
                    if touched.insert(row.node_id.clone()) {
                        changed.push(node_row(&touch_node_tx(txn, &row.node_id)?).summary());
                    }
                    dirty = true;
                }
                HistoryOp::InputOrder {
                    node_id,
                    port_id,
                    order,
                } => {
                    write_input_port_positions_tx(txn, node_id, port_id, order)?;
                    if touched.insert(node_id.clone()) {
                        changed.push(node_row(&touch_node_tx(txn, node_id)?).summary());
                    }
                    dirty = true;
                }
            }
        }

        if !coalesced_geometry.is_empty() {
            let (rows, _) = set_node_bounds_batched(txn, &coalesced_geometry)?;
            if !rows.is_empty() {
                dirty = true;
            }
            for row in rows {
                changed.push(row.summary());
            }
        }

        let mut restored: BTreeMap<(String, String), Vec<&InputRow>> = BTreeMap::new();
        for op in ops {
            if let HistoryOp::InsertInput(row) = op {
                restored
                    .entry((row.node_id.clone(), row.port_id.clone()))
                    .or_default()
                    .push(row);
            }
        }
        for ((node_id, port_id), rows) in &restored {
            restore_input_group_tx(txn, node_id, port_id, rows)?;
            if touched.insert(node_id.clone()) {
                changed.push(node_row(&touch_node_tx(txn, node_id)?).summary());
            }
        }

        // Geometry ops mark the nodes they moved; rebuild those connectors
        // once, after the whole entry has applied.
        edge_index::flush_geometry_tx(txn)?;
        let rev = if dirty {
            document::bump_rev(txn)?
        } else {
            document::current_rev(txn)?
        };
        Ok(ApplyOutcome::Applied(ChangeSet {
            rev: rev as f64,
            changed,
            removed,
            edges_changed,
            edges_removed,
        }))
    })
    .map_err(|error| error.to_string())
}
