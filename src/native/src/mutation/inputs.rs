//! Input commands: add, remove, reorder and sync.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder};

use super::Mutation;
use super::support::{input_row, node_row};
use super::tx::inputs::{
    delete_input_tx, find_input_tx, inputs_for_node_tx, insert_input_row_tx, max_input_position_tx,
    write_input_port_positions_tx,
};
use super::tx::nodes::{find_node_tx, touch_node_tx};
use super::tx::runs::items_for_batch_tx;
use super::tx::{finish_tx, no_op};
use crate::clock::now_ms;
use crate::entity::edges as edge_rows;
use crate::history::{HistoryOp, HistoryRefs, InputRow};
use crate::types::{ChangeSet, InputItemInput};

/// Appends one local input (for example an uploaded image) to a node.
pub fn add_input(conn: &DatabaseConnection, input: InputItemInput) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &input.node_id)?;
        let position = max_input_position_tx(txn, &input.node_id, &input.port_id)?;
        let row = InputRow {
            id: input.id,
            node_id: input.node_id,
            position,
            port_id: input.port_id,
            kind: input.kind,
            origin: input.origin,
            edge_id: input.edge_id,
            item_id: input.item_id,
            asset_id: input.asset_id,
            text: input.text,
            meta_json: input.meta_json.unwrap_or_else(|| "{}".to_owned()),
            created_at: now_ms(),
        };
        insert_input_row_tx(txn, &row)?;

        let changed = vec![node_row(&touch_node_tx(txn, &row.node_id)?).summary()];
        let mut refs = HistoryRefs::default();
        if row.origin == "edge"
            && let Some(edge_id) = &row.edge_id
            && let Some(edge) = edge_rows::Entity::find()
                .filter(edge_rows::Column::Id.eq(edge_id.clone()))
                .one(txn)?
        {
            refs.node(edge.from_id);
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation::with_refs(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            vec![HistoryOp::InsertInput(row.clone())],
            vec![HistoryOp::DeleteInput { id: row.id }],
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Removes one input item; the edge that contributed it stays.
pub fn remove_input(conn: &DatabaseConnection, id: String) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let row = find_input_tx(txn, &id)?;
        delete_input_tx(txn, &id)?;

        let changed = vec![node_row(&touch_node_tx(txn, &row.node_id)?).summary()];
        let mut refs = HistoryRefs::default();
        if row.origin == "edge"
            && let Some(edge_id) = &row.edge_id
            && let Some(edge) = edge_rows::Entity::find()
                .filter(edge_rows::Column::Id.eq(edge_id.clone()))
                .one(txn)?
        {
            refs.node(edge.from_id);
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation::with_refs(
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            vec![HistoryOp::DeleteInput { id: id.clone() }],
            vec![HistoryOp::InsertInput(input_row(&row))],
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Persists a drag-reordered input list. Positions are per port, so each
/// port is renumbered independently; ids the caller omitted keep their
/// relative order at the end of their port.
pub fn reorder_inputs(
    conn: &DatabaseConnection,
    node_id: String,
    ids: Vec<String>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &node_id)?;
        let current = inputs_for_node_tx(txn, &node_id)?;
        let before: BTreeMap<String, i32> = current
            .iter()
            .map(|row| (row.id.clone(), row.position))
            .collect();

        let mut by_port: BTreeMap<String, Vec<&InputRow>> = BTreeMap::new();
        for row in &current {
            by_port.entry(row.port_id.clone()).or_default().push(row);
        }
        let mut after: BTreeMap<String, Vec<(String, i32)>> = BTreeMap::new();
        for (port_id, rows) in &by_port {
            let mut ordered: Vec<&InputRow> = Vec::new();
            for id in &ids {
                if let Some(row) = rows.iter().find(|row| &row.id == id)
                    && !ordered.iter().any(|seen| seen.id == row.id)
                {
                    ordered.push(row);
                }
            }
            for row in rows {
                if !ordered.iter().any(|seen| seen.id == row.id) {
                    ordered.push(row);
                }
            }
            after.insert(
                port_id.clone(),
                ordered
                    .iter()
                    .enumerate()
                    .map(|(index, row)| (row.id.clone(), index as i32))
                    .collect(),
            );
        }

        let mut after_positions = BTreeMap::new();
        for order in after.values() {
            for (id, position) in order {
                after_positions.insert(id.clone(), *position);
            }
        }
        if after_positions == before {
            return no_op(txn);
        }

        let mut forward = Vec::new();
        let mut inverse = Vec::new();
        for (port_id, order) in &after {
            let before_order: Vec<(String, i32)> = order
                .iter()
                .map(|(id, _)| (id.clone(), before[id]))
                .collect();
            if before_order == *order {
                continue;
            }
            write_input_port_positions_tx(txn, &node_id, port_id, order)?;
            forward.push(HistoryOp::InputOrder {
                node_id: node_id.clone(),
                port_id: port_id.clone(),
                order: order.clone(),
            });
            inverse.push(HistoryOp::InputOrder {
                node_id: node_id.clone(),
                port_id: port_id.clone(),
                order: before_order,
            });
        }
        let changed = vec![node_row(&touch_node_tx(txn, &node_id)?).summary()];

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

/// Replaces a node's opaque kind settings. A node with a result becomes stale.
/// Rebuilds a node's edge inputs from the current batches of every connected
/// source. Local inputs keep their order; their old exclusions are cleared,
/// as a regeneration starts from the sources' current outputs.
pub fn sync_inputs(conn: &DatabaseConnection, node_id: String) -> Result<HistoryRefs, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &node_id)?;
        let mut refs = HistoryRefs::default();
        refs.node(node_id.clone());
        let current = inputs_for_node_tx(txn, &node_id)?;
        let mut locals_by_port: BTreeMap<String, Vec<InputRow>> = BTreeMap::new();
        let mut edge_rows = Vec::new();
        for row in current {
            if row.origin == "edge" {
                edge_rows.push(row.id);
            } else {
                locals_by_port
                    .entry(row.port_id.clone())
                    .or_default()
                    .push(row);
            }
        }
        for id in &edge_rows {
            delete_input_tx(txn, id)?;
        }

        let incoming = edge_rows::Entity::find()
            .filter(edge_rows::Column::ToId.eq(&node_id))
            .order_by_asc(edge_rows::Column::Id)
            .all(txn)?;
        let mut rebuilt: BTreeMap<String, Vec<InputRow>> = BTreeMap::new();
        for edge in incoming {
            let source = find_node_tx(txn, &edge.from_id)?;
            let Some(batch_id) = source.output_batch_id else {
                continue;
            };
            for item in items_for_batch_tx(txn, &batch_id)? {
                if item.port_id != edge.from_port {
                    continue;
                }
                let row = InputRow {
                    id: format!("input-{}-{}", edge.id, item.id),
                    node_id: node_id.clone(),
                    position: 0,
                    port_id: edge.to_port.clone(),
                    kind: item.kind.clone(),
                    origin: "edge".to_owned(),
                    edge_id: Some(edge.id.clone()),
                    item_id: Some(item.id.clone()),
                    asset_id: item.asset_id.clone(),
                    text: item.text.clone(),
                    meta_json: item.meta_json.clone(),
                    created_at: now_ms(),
                };
                rebuilt.entry(row.port_id.clone()).or_default().push(row);
            }
        }

        // New snapshots go above the current port range first, so the
        // immediate UNIQUE(node, port, position) holds until the whole port
        // is renumbered.
        let mut ports: BTreeSet<String> = locals_by_port.keys().cloned().collect();
        ports.extend(rebuilt.keys().cloned());
        for port_id in &ports {
            let base = max_input_position_tx(txn, &node_id, port_id)?;
            if let Some(rows) = rebuilt.get_mut(port_id) {
                for (index, row) in rows.iter_mut().enumerate() {
                    row.position = base + index as i32;
                    insert_input_row_tx(txn, row)?;
                }
            }
        }

        // Local inputs keep their relative order per port; the rebuilt edge
        // groups follow in that port.
        for port_id in &ports {
            let mut ordered: Vec<InputRow> = Vec::new();
            if let Some(locals) = locals_by_port.get(port_id) {
                ordered.extend(locals.iter().cloned());
            }
            if let Some(rows) = rebuilt.get(port_id) {
                ordered.extend(rows.iter().cloned());
            }
            let positions: Vec<(String, i32)> = ordered
                .iter()
                .enumerate()
                .map(|(index, row)| (row.id.clone(), index as i32))
                .collect();
            write_input_port_positions_tx(txn, &node_id, port_id, &positions)?;
        }

        touch_node_tx(txn, &node_id)?;
        finish_tx(txn)?;
        Ok(refs)
    })
    .map_err(|error| error.to_string())
}
