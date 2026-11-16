//! Input transactions.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseTransaction, DbErr, EntityTrait, QueryFilter, QueryOrder,
};

use crate::entity::{node_inputs, result_batches};
use crate::history::InputRow;

use crate::mutation::support::input_row;
use crate::mutation::tx::runs::items_for_batch_tx;

pub(in crate::mutation) fn insert_input_row_tx(
    txn: &DatabaseTransaction,
    row: &InputRow,
) -> Result<(), DbErr> {
    node_inputs::Entity::insert(node_inputs::ActiveModel {
        id: Set(row.id.clone()),
        node_id: Set(row.node_id.clone()),
        position: Set(row.position as i64),
        port_id: Set(row.port_id.clone()),
        kind: Set(row.kind.clone()),
        origin: Set(row.origin.clone()),
        edge_id: Set(row.edge_id.clone()),
        item_id: Set(row.item_id.clone()),
        asset_id: Set(row.asset_id.clone()),
        text: Set(row.text.clone()),
        meta_json: Set(row.meta_json.clone()),
        created_at: Set(row.created_at),
    })
    .exec(txn)?;
    Ok(())
}

pub(in crate::mutation) fn find_input_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<node_inputs::Model, DbErr> {
    node_inputs::Entity::find_by_id(id.to_owned())
        .one(txn)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("input {id} was not found")))
}

pub(in crate::mutation) fn delete_input_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<(), DbErr> {
    node_inputs::Entity::delete_by_id(id.to_owned()).exec(txn)?;
    Ok(())
}

/// Which input rows an edge removal deletes.
pub(in crate::mutation) enum EdgeInputsToDelete<'a> {
    /// Every row the edge contributed. Replay must use this mode: run-time
    /// sync can change item ids, so the rows a command captured may be stale.
    AllForEdge,
    /// Exactly the rows the caller captured.
    Captured(&'a [InputRow]),
}

/// Deletes the selected rows and returns the nodes whose input list changed,
/// in first-seen order.
pub(in crate::mutation) fn delete_inputs_for_edge_tx(
    txn: &DatabaseTransaction,
    edge_id: &str,
    mode: EdgeInputsToDelete<'_>,
) -> Result<Vec<String>, DbErr> {
    let rows: Vec<(String, String)> = match mode {
        EdgeInputsToDelete::AllForEdge => node_inputs::Entity::find()
            .filter(node_inputs::Column::EdgeId.eq(edge_id))
            .all(txn)?
            .into_iter()
            .map(|row| (row.id, row.node_id))
            .collect(),
        EdgeInputsToDelete::Captured(rows) => rows
            .iter()
            .map(|row| (row.id.clone(), row.node_id.clone()))
            .collect(),
    };
    let mut seen = BTreeSet::new();
    let mut changed = Vec::new();
    for (id, node_id) in &rows {
        delete_input_tx(txn, id)?;
        if seen.insert(node_id.clone()) {
            changed.push(node_id.clone());
        }
    }
    Ok(changed)
}

pub(in crate::mutation) fn inputs_for_node_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
) -> Result<Vec<InputRow>, DbErr> {
    node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .order_by_asc(node_inputs::Column::Position)
        .order_by_asc(node_inputs::Column::Id)
        .all(txn)
        .map(|rows| rows.iter().map(input_row).collect())
}

pub(in crate::mutation) fn inputs_for_edge_tx(
    txn: &DatabaseTransaction,
    edge_id: &str,
) -> Result<Vec<InputRow>, DbErr> {
    node_inputs::Entity::find()
        .filter(node_inputs::Column::EdgeId.eq(edge_id))
        .order_by_asc(node_inputs::Column::Position)
        .all(txn)
        .map(|rows| rows.iter().map(input_row).collect())
}

pub(in crate::mutation) fn inputs_for_nodes_tx(
    txn: &DatabaseTransaction,
    node_ids: &[String],
) -> Result<Vec<InputRow>, DbErr> {
    let mut found = BTreeMap::new();
    for row in node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.is_in(node_ids.to_vec()))
        .all(txn)?
    {
        found.insert(row.id.clone(), input_row(&row));
    }

    let batches = result_batches::Entity::find()
        .filter(result_batches::Column::NodeId.is_in(node_ids.to_vec()))
        .all(txn)?;
    let batch_ids: Vec<String> = batches.iter().map(|row| row.id.clone()).collect();
    let mut item_ids = Vec::new();
    if !batch_ids.is_empty() {
        for batch_id in &batch_ids {
            for item in items_for_batch_tx(txn, batch_id)? {
                item_ids.push(item.id);
            }
        }
    }

    for chunk in item_ids.chunks(400) {
        let ids: Vec<Option<String>> = chunk.iter().cloned().map(Some).collect();
        for row in node_inputs::Entity::find()
            .filter(node_inputs::Column::ItemId.is_in(ids))
            .all(txn)?
        {
            found.insert(row.id.clone(), input_row(&row));
        }
    }

    Ok(found.into_values().collect())
}

pub(in crate::mutation) fn max_input_position_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
) -> Result<i32, DbErr> {
    let row = node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .filter(node_inputs::Column::PortId.eq(port_id))
        .order_by_desc(node_inputs::Column::Position)
        .one(txn)?;
    Ok(row.map_or(0, |row| (row.position + 1) as i32))
}

pub(in crate::mutation) fn inputs_for_port_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
) -> Result<Vec<InputRow>, DbErr> {
    node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .filter(node_inputs::Column::PortId.eq(port_id))
        .order_by_asc(node_inputs::Column::Position)
        .order_by_asc(node_inputs::Column::Id)
        .all(txn)
        .map(|rows| rows.iter().map(input_row).collect())
}

/// Moves every row of one port above both its current range and
/// `minimum_offset`. The immediate `UNIQUE(node_id, port_id, position)` then
/// has no row in the target range, so a reorder or restore can write its
/// positions without a collision.
pub(in crate::mutation) fn lift_input_port_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
    minimum_offset: i32,
) -> Result<(), DbErr> {
    let offset = std::cmp::max(
        max_input_position_tx(txn, node_id, port_id)?,
        minimum_offset,
    );
    if offset == 0 {
        return Ok(());
    }
    node_inputs::Entity::update_many()
        .col_expr(
            node_inputs::Column::Position,
            Expr::col(node_inputs::Column::Position).add(offset),
        )
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .filter(node_inputs::Column::PortId.eq(port_id))
        .exec(txn)?;
    Ok(())
}

/// Writes target positions after `lift_input_port_tx`. The caller supplies
/// every row that should end in the low range; a row it omitted stays at the
/// end of the port instead of leaking a lifted position.
pub(in crate::mutation) fn write_input_port_positions_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
    order: &[(String, i32)],
) -> Result<(), DbErr> {
    let current = inputs_for_port_tx(txn, node_id, port_id)?;
    let mut positions = Vec::with_capacity(current.len().max(order.len()));
    let mut seen = BTreeSet::new();
    let mut next = 0;
    for (id, position) in order {
        if current.iter().any(|row| &row.id == id) && seen.insert(id.clone()) {
            positions.push((id.clone(), *position));
            next = std::cmp::max(next, *position + 1);
        }
    }
    for row in current {
        if seen.insert(row.id.clone()) {
            positions.push((row.id.clone(), next));
            next += 1;
        }
    }
    let highest = positions.iter().map(|(_, position)| *position).max();
    lift_input_port_tx(
        txn,
        node_id,
        port_id,
        highest.map_or(0, |position| position + 1),
    )?;
    assign_input_positions_tx(txn, node_id, port_id, &positions)
}

pub(in crate::mutation) fn assign_input_positions_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
    positions: &[(String, i32)],
) -> Result<(), DbErr> {
    for (id, position) in positions {
        node_inputs::Entity::update_many()
            .col_expr(node_inputs::Column::Position, Expr::value(*position))
            .filter(node_inputs::Column::Id.eq(id))
            .filter(node_inputs::Column::NodeId.eq(node_id))
            .filter(node_inputs::Column::PortId.eq(port_id))
            .exec(txn)?;
    }
    Ok(())
}

/// Restores one entry's fresh input rows for a port in one pass. The rows
/// are inserted above the current range, then merged with the port's
/// current rows by stored position; a restored row wins an exact tie, so
/// it takes the historical slot and the existing row follows it. The whole
/// port is renumbered densely, making the result independent of the order
/// the entry's ops happen to have.
pub(in crate::mutation) fn restore_input_group_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    port_id: &str,
    rows: &[&InputRow],
) -> Result<(), DbErr> {
    let current = inputs_for_port_tx(txn, node_id, port_id)?;
    let existing: BTreeSet<String> = current.iter().map(|row| row.id.clone()).collect();
    let fresh: Vec<&InputRow> = rows
        .iter()
        .copied()
        .filter(|row| !existing.contains(&row.id))
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }

    let base = max_input_position_tx(txn, node_id, port_id)?;
    for (position, row) in (base..).zip(fresh.iter()) {
        let mut inserted = (*row).clone();
        inserted.position = position;
        insert_input_row_tx(txn, &inserted)?;
    }

    let fresh_positions: BTreeMap<&str, i32> = fresh
        .iter()
        .map(|row| (row.id.as_str(), row.position))
        .collect();
    let current = inputs_for_port_tx(txn, node_id, port_id)?;
    let mut merged: Vec<(i32, bool, String)> = current
        .iter()
        .map(|row| match fresh_positions.get(row.id.as_str()) {
            Some(position) => (*position, true, row.id.clone()),
            None => (row.position, false, row.id.clone()),
        })
        .collect();
    merged.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let positions: Vec<(String, i32)> = merged
        .into_iter()
        .enumerate()
        .map(|(index, (_, _, id))| (id, index as i32))
        .collect();
    let offset = positions.len() as i32;
    lift_input_port_tx(txn, node_id, port_id, offset)?;
    assign_input_positions_tx(txn, node_id, port_id, &positions)
}
