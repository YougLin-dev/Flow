//! Node commands: insert, move, bounds, text, settings and delete.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{DatabaseConnection, DbErr};

use super::Mutation;
use super::support::{canonical_tags, node_row, tags_from};
use super::tx::edges::{PortReconciliation, edges_for_node_tx, reconcile_ports_tx};
use super::tx::inputs::{delete_input_tx, inputs_for_nodes_tx};
use super::tx::nodes::{
    apply_settings_tx, delete_node_tx, find_node_tx, insert_node_tx, set_node_bounds_batched,
    touch_node_tx, update_position_tx, update_text_tx,
};
use super::tx::runs::{cancel_running_batches_tx, set_node_status_tx};
use super::tx::{finish_tx, no_op};
use crate::history::{HistoryOp, HistoryRefs};
use crate::types::{ChangeSet, NodeBounds, NodeInput};

pub fn insert_nodes(conn: &DatabaseConnection, inputs: Vec<NodeInput>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if inputs.is_empty() {
            return no_op(txn);
        }
        let mut changed = Vec::with_capacity(inputs.len());
        let mut forward = Vec::with_capacity(inputs.len());
        let mut inverse = Vec::with_capacity(inputs.len());

        for node in &inputs {
            let row = insert_node_tx(txn, node)?;
            changed.push(row.summary());
            forward.push(HistoryOp::Insert(row.clone()));
            inverse.push(HistoryOp::Delete { id: row.id });
        }
        inverse.reverse();

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn move_nodes(
    conn: &DatabaseConnection,
    ids: Vec<String>,
    dx: f64,
    dy: f64,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if ids.is_empty() || (dx == 0.0 && dy == 0.0) {
            return no_op(txn);
        }
        let mut changed = Vec::with_capacity(ids.len());
        let mut forward = Vec::with_capacity(ids.len());
        let mut inverse = Vec::with_capacity(ids.len());

        for id in &ids {
            let before = find_node_tx(txn, id)?;
            let x = before.x + dx;
            let y = before.y + dy;
            let row = update_position_tx(txn, &before, x, y)?;
            changed.push(row.summary());
            forward.push(HistoryOp::NodeGeometry {
                id: id.clone(),
                x,
                y,
                width: row.width,
                height: row.height,
            });
            inverse.push(HistoryOp::NodeGeometry {
                id: id.clone(),
                x: before.x,
                y: before.y,
                width: before.width,
                height: before.height,
            });
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_bounds(
    conn: &DatabaseConnection,
    bounds: Vec<NodeBounds>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let (changed_rows, pairs) = set_node_bounds_batched(txn, &bounds)?;
        if pairs.is_empty() {
            return no_op(txn);
        }
        let changed = changed_rows.iter().map(|row| row.summary()).collect();
        let mut forward = Vec::with_capacity(pairs.len());
        let mut inverse = Vec::with_capacity(pairs.len());

        for (before, next) in &pairs {
            forward.push(HistoryOp::NodeGeometry {
                id: next.id.clone(),
                x: next.x,
                y: next.y,
                width: next.width,
                height: next.height,
            });
            inverse.push(HistoryOp::NodeGeometry {
                id: before.id.clone(),
                x: before.x,
                y: before.y,
                width: before.width,
                height: before.height,
            });
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_text(
    conn: &DatabaseConnection,
    id: String,
    title: String,
    tags: Vec<String>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        let tags = canonical_tags(&tags);
        if before.title == title && before.tags == tags {
            return no_op(txn);
        }
        let tags = tags_from(&tags);
        let row = update_text_tx(txn, &before, &title, &tags)?;
        let rev = finish_tx(txn)?;

        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed: vec![row.summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            vec![HistoryOp::NodeText {
                id: id.clone(),
                title,
                tags,
            }],
            vec![HistoryOp::NodeText {
                id,
                title: before.title,
                tags: tags_from(&before.tags),
            }],
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn delete_nodes(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if ids.is_empty() {
            return no_op(txn);
        }
        let mut changed = Vec::new();
        let mut removed = Vec::with_capacity(ids.len());
        let mut inverse = Vec::new();
        let deleted: std::collections::BTreeSet<&str> = ids.iter().map(|id| id.as_str()).collect();

        // Collect edges before the delete cascades them, so undo can restore
        // them after the nodes. Inputs that point at the deleted nodes' items
        // (in other nodes too) go as well; their rows are restored on undo.
        let mut removed_edges = BTreeMap::new();
        for id in &ids {
            for edge in edges_for_node_tx(txn, id)? {
                removed_edges.entry(edge.id.clone()).or_insert(edge);
            }
        }

        let mut removed_inputs = Vec::new();
        for input in inputs_for_nodes_tx(txn, &ids)? {
            delete_input_tx(txn, &input.id)?;
            removed_inputs.push(input);
        }

        // Undo restores the downstream inputs the delete removed, so redo
        // must delete them again; the node cascade alone does not reach
        // inputs living on surviving nodes.
        let mut forward = Vec::with_capacity(ids.len() + removed_inputs.len());
        for input in &removed_inputs {
            forward.push(HistoryOp::DeleteInput {
                id: input.id.clone(),
            });
        }
        let mut refs = HistoryRefs::default();
        for id in &ids {
            let mut row = find_node_tx(txn, id)?;
            // A deleted node must not leave a running batch behind: a late
            // settle would otherwise write a done batch for a dead node, or
            // revive the output of a node restored by undo. Cancel first,
            // then capture the terminal status for the inverse.
            for batch in cancel_running_batches_tx(txn, id)? {
                refs.batch(Some(&batch));
            }
            if row.status == "running" {
                row = set_node_status_tx(txn, &row, "cancelled")?;
            }
            delete_node_tx(txn, &row)?;
            removed.push(id.clone());
            forward.push(HistoryOp::Delete { id: id.clone() });
            inverse.push(HistoryOp::Insert(node_row(&row)));
        }
        for edge in removed_edges.values() {
            inverse.push(HistoryOp::InsertEdge(edge.clone()));
        }
        for input in &removed_inputs {
            inverse.push(HistoryOp::InsertInput(input.clone()));
        }
        inverse.reverse();

        // A surviving node whose input list lost items is stale now. Touch
        // each once, even when it had no output: the composer must refresh.
        let mut survivors = BTreeSet::new();
        for input in &removed_inputs {
            if !deleted.contains(input.node_id.as_str()) {
                survivors.insert(input.node_id.clone());
            }
        }
        for edge in removed_edges.values() {
            if !deleted.contains(edge.to_id.as_str()) {
                survivors.insert(edge.to_id.clone());
            }
        }
        for id in survivors {
            changed.push(node_row(&touch_node_tx(txn, &id)?).summary());
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation::with_refs(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed,
                edges_changed: Vec::new(),
                edges_removed: removed_edges.into_keys().collect(),
            },
            forward,
            inverse,
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_settings(
    conn: &DatabaseConnection,
    id: String,
    settings_json: String,
    valid_ports: Option<Vec<String>>,
) -> Result<Mutation, String> {
    let valid_ports = valid_ports.map(|ports| ports.into_iter().collect::<BTreeSet<_>>());
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        if before.settings_json == settings_json {
            return no_op(txn);
        }
        let after = apply_settings_tx(txn, &before, settings_json.clone())?;
        // A caller that does not know the kind's ports (a newer document)
        // passes None: absence of schema knowledge must not delete edges.
        let reconciliation = match &valid_ports {
            Some(ports) => reconcile_ports_tx(txn, &id, ports)?,
            None => PortReconciliation::default(),
        };

        let mut changed = vec![after.summary()];
        for target in &reconciliation.survivors {
            changed.push(node_row(&touch_node_tx(txn, target)?).summary());
        }

        // Settings and the edges their new port schema removed are one undo
        // entry; a run's output and body belong to the run and must survive
        // an undo of this edit. Undo applies the stored inverse back to
        // front, so this reverse makes that order settings, then each edge,
        // then that edge's snapshots. The v1 producer trigger requires the
        // edge row before its inputs.
        let mut forward = vec![HistoryOp::NodeSettings {
            id: id.clone(),
            settings_json,
            mark_stale: true,
        }];
        let mut inverse = vec![HistoryOp::NodeSettings {
            id: id.clone(),
            settings_json: before.settings_json,
            mark_stale: false,
        }];
        let mut edges_removed = Vec::with_capacity(reconciliation.removed.len());
        for removed in &reconciliation.removed {
            for input in &removed.inputs {
                forward.push(HistoryOp::DeleteInput {
                    id: input.id.clone(),
                });
            }
            forward.push(HistoryOp::DeleteEdge {
                id: removed.edge.id.clone(),
            });
            inverse.push(HistoryOp::InsertEdge(removed.edge.clone()));
            for input in &removed.inputs {
                inverse.push(HistoryOp::InsertInput(input.clone()));
            }
            edges_removed.push(removed.edge.id.clone());
        }
        inverse.reverse();

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed,
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}
