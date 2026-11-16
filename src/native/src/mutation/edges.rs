//! Edge commands: insert, delete, connect and update.

use std::collections::BTreeMap;

use sea_orm::{DatabaseConnection, DbErr};

use super::Mutation;
use super::support::{edge_row, node_row};
use super::tx::edges::{
    already_connected_tx, connect_edge_tx, delete_edge_tx, edge_summary, find_edge_tx,
    insert_edge_tx, replace_edge_row_tx, snapshot_inputs_tx,
};
use super::tx::inputs::{EdgeInputsToDelete, delete_inputs_for_edge_tx, inputs_for_edge_tx};
use super::tx::nodes::{find_node_tx, touch_node_tx};
use super::tx::{finish_tx, no_op};
use crate::entity::nodes as node_rows;
use crate::history::{EdgeRow, HistoryOp};
use crate::types::{ChangeSet, EdgeInput};

pub fn insert_edges(conn: &DatabaseConnection, inputs: Vec<EdgeInput>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if inputs.is_empty() {
            return no_op(txn);
        }
        let mut changed = Vec::with_capacity(inputs.len());
        let mut forward = Vec::with_capacity(inputs.len());
        let mut inverse = Vec::with_capacity(inputs.len());

        for input in &inputs {
            let row = insert_edge_tx(txn, input)?;
            let from = find_node_tx(txn, &row.from_id)?;
            let to = find_node_tx(txn, &row.to_id)?;
            changed.push(edge_summary(&row, &from, &to));
            forward.push(HistoryOp::InsertEdge(row.clone()));
            inverse.push(HistoryOp::DeleteEdge { id: row.id });
        }
        inverse.reverse();

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed: Vec::new(),
                removed: Vec::new(),
                edges_changed: changed,
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

pub fn delete_edges(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if ids.is_empty() {
            return no_op(txn);
        }
        let mut changed = Vec::new();
        let mut removed = Vec::with_capacity(ids.len());
        let mut forward = Vec::with_capacity(ids.len());
        let mut inverse = Vec::new();

        for id in &ids {
            let row = find_edge_tx(txn, id)?;
            let inputs = inputs_for_edge_tx(txn, &row.id)?;
            delete_inputs_for_edge_tx(txn, &row.id, EdgeInputsToDelete::Captured(&inputs))?;
            for input in &inputs {
                forward.push(HistoryOp::DeleteInput {
                    id: input.id.clone(),
                });
            }
            delete_edge_tx(txn, id)?;
            removed.push(id.clone());
            forward.push(HistoryOp::DeleteEdge { id: id.clone() });

            inverse.push(HistoryOp::InsertEdge(edge_row(&row)));
            for input in inputs {
                inverse.push(HistoryOp::InsertInput(input));
            }
            changed.push(node_row(&touch_node_tx(txn, &row.to_id)?).summary());
        }
        inverse.reverse();

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: removed,
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Inserts an edge and snapshots every item of the source's current batch
/// into the target's input list.
pub fn connect_edge(conn: &DatabaseConnection, input: EdgeInput) -> Result<Mutation, String> {
    connect_edges(conn, vec![input])
}

/// Connects several pairs in one transaction and one history step. Every edge
/// snapshots its source's current batch into its target's input list.
pub fn connect_edges(
    conn: &DatabaseConnection,
    inputs: Vec<EdgeInput>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if inputs.is_empty() {
            return no_op(txn);
        }
        let mut changed_by_id: BTreeMap<String, node_rows::Model> = BTreeMap::new();
        let mut forward = Vec::new();
        let mut desired_inverse = Vec::new();
        let mut edges_changed = Vec::with_capacity(inputs.len());

        for input in &inputs {
            let connected = connect_edge_tx(txn, input)?;
            edges_changed.push(edge_summary(
                &connected.edge,
                &connected.source,
                &connected.target,
            ));
            forward.extend(connected.forward);
            desired_inverse.extend(connected.inverse);
            // Several edges may touch one target; report its final summary once.
            changed_by_id.insert(connected.target.id.clone(), connected.target);
        }

        let mut inverse = desired_inverse;
        inverse.reverse();
        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed: changed_by_id
                    .values()
                    .map(|model| node_row(model).summary())
                    .collect(),
                removed: Vec::new(),
                edges_changed,
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Reconnects an edge: its inputs from the old target are removed and the
/// new source's current batch is snapshotted into the new target.
pub fn update_edge(conn: &DatabaseConnection, input: EdgeInput) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if input.from_id == input.to_id {
            return Err(DbErr::Custom("a node cannot connect to itself".to_owned()));
        }
        let before = find_edge_tx(txn, &input.id)?;
        let source = find_node_tx(txn, &input.from_id)?;
        let target = find_node_tx(txn, &input.to_id)?;
        if already_connected_tx(
            txn,
            &input.from_id,
            &input.from_port,
            &input.to_id,
            &input.to_port,
            &input.id,
        )? {
            return Err(DbErr::Custom(
                "these ports are already connected".to_owned(),
            ));
        }

        let old_inputs = inputs_for_edge_tx(txn, &input.id)?;
        delete_inputs_for_edge_tx(txn, &input.id, EdgeInputsToDelete::Captured(&old_inputs))?;

        let after = replace_edge_row_tx(
            txn,
            &EdgeRow {
                seq: before.seq,
                id: input.id.clone(),
                from_id: input.from_id.clone(),
                to_id: input.to_id.clone(),
                from_port: input.from_port.clone(),
                to_port: input.to_port.clone(),
                port_kind: input.port_kind.clone(),
                from_offset: input.from_offset,
                to_offset: input.to_offset,
                kind: input.kind.clone(),
                data_json: input.data_json.clone().unwrap_or_else(|| "{}".to_owned()),
            },
        )?;

        let mut changed = Vec::new();
        let mut forward = vec![HistoryOp::ReplaceEdge(after.clone())];
        // Redo must remove the old target's snapshots that undo restored
        // before inserting the new ones (their ids can even coincide when
        // only the target changed).
        for row in &old_inputs {
            forward.push(HistoryOp::DeleteInput { id: row.id.clone() });
        }
        let new_inputs = snapshot_inputs_tx(
            txn,
            &after.id,
            &source,
            &input.to_id,
            &input.from_port,
            &input.to_port,
        )?;
        for row in &new_inputs {
            forward.push(HistoryOp::InsertInput(row.clone()));
        }

        let mut stale_targets = vec![before.to_id.clone(), input.to_id.clone()];
        stale_targets.sort();
        stale_targets.dedup();
        let mut desired_inverse = Vec::new();
        for target in &stale_targets {
            changed.push(node_row(&touch_node_tx(txn, target)?).summary());
        }
        for row in &new_inputs {
            desired_inverse.push(HistoryOp::DeleteInput { id: row.id.clone() });
        }
        desired_inverse.push(HistoryOp::ReplaceEdge(edge_row(&before)));
        for row in &old_inputs {
            desired_inverse.push(HistoryOp::InsertInput(row.clone()));
        }
        desired_inverse.reverse();

        let rev = finish_tx(txn)?;
        Ok(Mutation::commit(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: vec![edge_summary(&after, &source, &target)],
                edges_removed: Vec::new(),
            },
            forward,
            desired_inverse,
        ))
    })
    .map_err(|error| error.to_string())
}
