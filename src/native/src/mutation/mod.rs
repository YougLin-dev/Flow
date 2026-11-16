//! Document writes. Every user action is one transaction; the transaction
//! returns both the visible change set and the operations that undo it.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::{Set, Unchanged},
    ColumnTrait, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, QueryFilter,
    QueryOrder,
};

use crate::clock::now_ms;
use crate::document;
use crate::edge_index;
use crate::entity::{edges, node_inputs, nodes, result_batches};
use crate::history::{EdgeRow, HistoryOp, HistoryRefs, InputRow};
use crate::types::{
    ChangeSet, EdgeInput, InputItemInput, NodeBounds, NodeInput, ResultBatchInput, ResultItemInput,
};

mod support;
mod tx;

use support::*;
use tx::edges::*;
use tx::inputs::*;
use tx::nodes::*;
use tx::runs::*;
use tx::{finish_tx, no_op};

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
        Ok(Mutation::new(
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
        Ok(Mutation::new(
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
        Ok(Mutation::new(
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

        Ok(Mutation::new(
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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed,
                edges_changed: Vec::new(),
                edges_removed: removed_edges.into_keys().collect(),
            },
            forward,
            inverse,
            refs,
        })
    })
    .map_err(|error| error.to_string())
}

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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: Vec::new(),
                removed: Vec::new(),
                edges_changed: changed,
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
            refs: HistoryRefs::default(),
        })
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
            for input in &inputs {
                delete_input_tx(txn, &input.id)?;
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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: removed,
            },
            forward,
            inverse,
            refs: HistoryRefs::default(),
        })
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
        let mut changed_by_id: BTreeMap<String, nodes::Model> = BTreeMap::new();
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
        Ok(Mutation {
            changes: ChangeSet {
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
            refs: HistoryRefs::default(),
        })
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
        for row in &old_inputs {
            delete_input_tx(txn, &row.id)?;
        }

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
        let mut new_inputs = Vec::new();
        let mut position = max_input_position_tx(txn, &input.to_id, &input.to_port)?;
        if let Some(batch_id) = &source.output_batch_id {
            for item in items_for_batch_tx(txn, batch_id)? {
                if item.port_id != input.from_port {
                    continue;
                }
                let row = InputRow {
                    id: format!("input-{}-{}", after.id, item.id),
                    node_id: input.to_id.clone(),
                    position,
                    port_id: input.to_port.clone(),
                    kind: item.kind.clone(),
                    origin: "edge".to_owned(),
                    edge_id: Some(after.id.clone()),
                    item_id: Some(item.id.clone()),
                    asset_id: item.asset_id.clone(),
                    text: item.text.clone(),
                    meta_json: item.meta_json.clone(),
                    created_at: now_ms(),
                };
                insert_input_row_tx(txn, &row)?;
                forward.push(HistoryOp::InsertInput(row.clone()));
                new_inputs.push(row);
                position += 1;
            }
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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: vec![edge_summary(&after, &source, &target)],
                edges_removed: Vec::new(),
            },
            forward,
            inverse: desired_inverse,
            refs: HistoryRefs::default(),
        })
    })
    .map_err(|error| error.to_string())
}

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
            && let Some(edge) = edges::Entity::find()
                .filter(edges::Column::Id.eq(edge_id.clone()))
                .one(txn)?
        {
            refs.node(edge.from_id);
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::InsertInput(row.clone())],
            inverse: vec![HistoryOp::DeleteInput { id: row.id }],
            refs,
        })
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
            && let Some(edge) = edges::Entity::find()
                .filter(edges::Column::Id.eq(edge_id.clone()))
                .one(txn)?
        {
            refs.node(edge.from_id);
        }

        let rev = finish_tx(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::DeleteInput { id: id.clone() }],
            inverse: vec![HistoryOp::InsertInput(input_row(&row))],
            refs,
        })
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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward,
            inverse,
            refs: HistoryRefs::default(),
        })
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

        let incoming = edges::Entity::find()
            .filter(edges::Column::ToId.eq(&node_id))
            .order_by_asc(edges::Column::Id)
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
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed,
            },
            forward,
            inverse,
            refs: HistoryRefs::default(),
        })
    })
    .map_err(|error| error.to_string())
}

/// A text node's manual edit: one new immutable text item, referenced as the
/// node's current output. The old batch stays for downstream snapshots.
pub fn set_manual_text(
    conn: &DatabaseConnection,
    id: String,
    text: String,
    batch: ResultBatchInput,
    item: ResultItemInput,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if batch.node_id != id {
            return Err(DbErr::Custom(
                "the manual batch belongs to another node".to_owned(),
            ));
        }
        let before = find_node_tx(txn, &id)?;
        let before_row = node_row(&before);
        insert_running_batch_tx(txn, &batch)?;
        insert_result_item_tx(txn, &batch.id, &item)?;
        settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;

        let updated = nodes::Entity::update(nodes::ActiveModel {
            seq: Unchanged(before.seq),
            body: Set(text),
            status: Set("done".to_owned()),
            output_batch_id: Set(Some(batch.id.clone())),
            rev: Set(before.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;
        let after = node_row(&updated);
        let mut changed = vec![after.summary()];
        changed.extend(
            mark_downstream_stale_tx(txn, &id)?
                .into_iter()
                .map(|row| node_row(&row).summary()),
        );

        // The batch itself stays on undo, like a provider batch: it may still
        // be referenced by a downstream input snapshot.
        let mut refs = HistoryRefs::default();
        refs.batch(Some(&batch.id));
        refs.asset(item.asset_id.as_deref());
        let rev = finish_tx(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::NodeOutput {
                id: id.clone(),
                from_batch_id: before_row.output_batch_id.clone(),
                from_body: before_row.body.clone(),
                from_status: before_row.status.clone(),
                to_batch_id: after.output_batch_id.clone(),
                to_body: after.body.clone(),
                to_status: after.status.clone(),
            }],
            inverse: vec![HistoryOp::NodeOutput {
                id,
                from_batch_id: after.output_batch_id.clone(),
                from_body: after.body.clone(),
                from_status: after.status.clone(),
                to_batch_id: before_row.output_batch_id,
                to_body: before_row.body,
                to_status: before_row.status,
            }],
            refs,
        })
    })
    .map_err(|error| error.to_string())
}

/// A local upload's output: one immutable batch and its items plus the node's
/// derived port schema (settings), searchable body and fitted rectangle, in
/// one undoable write. The batches stay on undo, like a manual text edit,
/// because downstream snapshots may still refer to their items.
pub fn set_manual_upload(
    conn: &DatabaseConnection,
    id: String,
    settings_json: String,
    body: String,
    batch: ResultBatchInput,
    items: Vec<ResultItemInput>,
    bounds: Option<NodeBounds>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if batch.node_id != id {
            return Err(DbErr::Custom(
                "the upload batch belongs to another node".to_owned(),
            ));
        }
        if let Some(next) = &bounds
            && next.id != id
        {
            return Err(DbErr::Custom(
                "the upload bounds belong to another node".to_owned(),
            ));
        }
        if batch.status != "done" || items.is_empty() {
            return Err(DbErr::Custom(
                "an upload batch must be done and hold at least one item".to_owned(),
            ));
        }
        // An upload's output ports are derived from the media it holds. A
        // replaced upload that no longer holds a kind loses that port and
        // the edges that used it, in this same undo step.
        let valid_ports: BTreeSet<String> = items.iter().map(|item| item.port_id.clone()).collect();
        let before = find_node_tx(txn, &id)?;
        let before_row = node_row(&before);
        insert_running_batch_tx(txn, &batch)?;
        for item in &items {
            insert_result_item_tx(txn, &batch.id, item)?;
        }
        settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;

        let mut node = nodes::ActiveModel {
            seq: Unchanged(before.seq),
            settings_json: Set(settings_json),
            body: Set(body),
            status: Set("done".to_owned()),
            output_batch_id: Set(Some(batch.id.clone())),
            rev: Set(before.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        };
        if let Some(next) = &bounds {
            node.x = Set(next.x);
            node.y = Set(next.y);
            node.width = Set(next.width);
            node.height = Set(next.height);
        }
        let updated = nodes::Entity::update(node).exec(txn)?;
        // The upload's own write moves the card too: keep its spatial and
        // connector indexes in step in the same transaction, so one undo
        // restores the output and the previous rectangle together.
        if bounds.is_some() {
            scale_edge_offsets_tx(txn, &updated.id, before.height, updated.height)?;
        }
        let after = node_row(&updated);
        let reconciliation = reconcile_ports_tx(txn, &id, &valid_ports)?;
        let mut changed = vec![after.summary()];
        let mut touched = BTreeSet::new();
        for row in mark_downstream_stale_tx(txn, &id)? {
            touched.insert(row.id.clone());
            changed.push(node_row(&row).summary());
        }
        for target in &reconciliation.survivors {
            if touched.insert(target.clone()) {
                changed.push(node_row(&touch_node_tx(txn, target)?).summary());
            }
        }

        let mut forward = Vec::with_capacity(3 + reconciliation.removed.len() * 2);
        let mut inverse = Vec::with_capacity(3 + reconciliation.removed.len() * 2);
        forward.push(HistoryOp::NodeSettings {
            id: id.clone(),
            settings_json: after.settings_json.clone(),
            mark_stale: true,
        });
        if let Some(next) = &bounds {
            forward.push(HistoryOp::NodeGeometry {
                id: id.clone(),
                x: next.x,
                y: next.y,
                width: next.width,
                height: next.height,
            });
            inverse.push(HistoryOp::NodeGeometry {
                id: id.clone(),
                x: before_row.x,
                y: before_row.y,
                width: before_row.width,
                height: before_row.height,
            });
        }
        inverse.push(HistoryOp::NodeSettings {
            id: id.clone(),
            settings_json: before_row.settings_json.clone(),
            mark_stale: false,
        });
        // Undo reverses the inverse list, so output is restored first, then
        // each removed edge (before its own snapshots), then settings and
        // geometry. Redo applies the forward list: the settings write may
        // mark an existing output stale, so the output op follows and
        // restores the run-owned body and status; the edge deletes come last.
        for removed in &reconciliation.removed {
            for input in &removed.inputs {
                inverse.push(HistoryOp::InsertInput(input.clone()));
            }
            inverse.push(HistoryOp::InsertEdge(removed.edge.clone()));
        }
        forward.push(HistoryOp::NodeOutput {
            id: id.clone(),
            from_batch_id: before_row.output_batch_id.clone(),
            from_body: before_row.body.clone(),
            from_status: before_row.status.clone(),
            to_batch_id: after.output_batch_id.clone(),
            to_body: after.body.clone(),
            to_status: after.status.clone(),
        });
        inverse.push(HistoryOp::NodeOutput {
            id: id.clone(),
            from_batch_id: after.output_batch_id.clone(),
            from_body: after.body.clone(),
            from_status: after.status.clone(),
            to_batch_id: before_row.output_batch_id,
            to_body: before_row.body,
            to_status: before_row.status,
        });
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
            edges_removed.push(removed.edge.id.clone());
        }

        let mut refs = HistoryRefs::default();
        refs.batch(Some(&batch.id));
        for item in &items {
            refs.asset(item.asset_id.as_deref());
        }
        let rev = finish_tx(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed,
            },
            forward,
            inverse,
            refs,
        })
    })
    .map_err(|error| error.to_string())
}

/// Inserts a node together with its upload output batch, items and current
/// output pointer in one transaction and one undo step. Copying an upload
/// card goes through here: inserting it empty and writing its output after
/// would leave a half-copied card on the first undo.
pub fn insert_upload_node(
    conn: &DatabaseConnection,
    node: NodeInput,
    batch: ResultBatchInput,
    items: Vec<ResultItemInput>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if batch.node_id != node.id {
            return Err(DbErr::Custom(
                "the upload batch belongs to another node".to_owned(),
            ));
        }
        if batch.status != "done" || items.is_empty() {
            return Err(DbErr::Custom(
                "an upload batch must be done and hold at least one item".to_owned(),
            ));
        }
        insert_node_tx(txn, &node)?;
        insert_running_batch_tx(txn, &batch)?;
        for item in &items {
            insert_result_item_tx(txn, &batch.id, item)?;
        }
        settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;
        let inserted = find_node_tx(txn, &node.id)?;
        let updated = nodes::Entity::update(nodes::ActiveModel {
            seq: Unchanged(inserted.seq),
            status: Set("done".to_owned()),
            output_batch_id: Set(Some(batch.id.clone())),
            rev: Set(inserted.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;
        let after = node_row(&updated);
        let mut refs = HistoryRefs::default();
        refs.batch(Some(&batch.id));
        for item in &items {
            refs.asset(item.asset_id.as_deref());
        }
        let rev = finish_tx(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: vec![after.summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::Insert(after)],
            inverse: vec![HistoryOp::Delete { id: node.id }],
            refs,
        })
    })
    .map_err(|error| error.to_string())
}

/// Starts a provider run: inserts its batch running and marks the node
/// running. The provider call happens in TSX between this and `settle_run`;
/// neither write is undoable.
pub fn begin_run(
    conn: &DatabaseConnection,
    batch: ResultBatchInput,
) -> Result<(ChangeSet, HistoryRefs), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if batch.status != "running" {
            return Err(DbErr::Custom(
                "a run must begin with a running batch".to_owned(),
            ));
        }
        let node = find_node_tx(txn, &batch.node_id)?;
        insert_running_batch_tx(txn, &batch)?;
        let updated = nodes::Entity::update(nodes::ActiveModel {
            seq: Unchanged(node.seq),
            status: Set("running".to_owned()),
            rev: Set(node.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;
        let mut refs = HistoryRefs::default();
        refs.node(batch.node_id);
        refs.batch(Some(&batch.id));
        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed: vec![node_row(&updated).summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Settles the running batch a provider call started: records the provider
/// result metadata, adds its items, closes the batch and updates the node. A
/// late settle for a batch that no longer runs (or a node that was deleted)
/// is a no-op rather than an error.
pub fn settle_run(
    conn: &DatabaseConnection,
    batch: ResultBatchInput,
    items: Vec<ResultItemInput>,
) -> Result<(ChangeSet, HistoryRefs), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        if batch.status == "running" {
            return Err(DbErr::Custom(
                "settle_run needs a terminal batch status".to_owned(),
            ));
        }
        let Some(running) = result_batches::Entity::find()
            .filter(result_batches::Column::Id.eq(&batch.id))
            .one(txn)?
        else {
            return empty_settle(txn);
        };
        if running.status != "running" {
            return empty_settle(txn);
        }
        if running.node_id != batch.node_id {
            return Err(DbErr::Custom(
                "the settled batch belongs to another node".to_owned(),
            ));
        }
        if batch.status == "done" && items.is_empty() && running.item_count == 0 {
            return Err(DbErr::Custom(
                "a successful batch must contain at least one item".to_owned(),
            ));
        }

        // Resolve the node before writing anything else. A run whose node was
        // deleted, or whose id now belongs to a new incarnation, must not
        // fill its batch with unreachable items or revive an old output.
        let Some(node) = find_node_opt_tx(txn, &batch.node_id)? else {
            return cancel_orphan_settle(txn, &running, "the node was deleted");
        };
        if node.seq != running.node_seq {
            return cancel_orphan_settle(txn, &running, "the node was deleted");
        }

        // The provider's metadata is only known after its call, so it is
        // written while the batch still runs and locked by the settle.
        result_batches::Entity::update_many()
            .col_expr(
                result_batches::Column::Provider,
                Expr::value(batch.provider.clone()),
            )
            .col_expr(
                result_batches::Column::Model,
                Expr::value(batch.model.clone()),
            )
            .col_expr(
                result_batches::Column::ParamsJson,
                Expr::value(batch.params_json.clone()),
            )
            .filter(result_batches::Column::Id.eq(&batch.id))
            .filter(result_batches::Column::Status.eq("running"))
            .exec(txn)?;
        for item in &items {
            insert_result_item_tx(txn, &batch.id, item)?;
        }
        settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;

        let (changed, refs) = apply_batch_result_tx(txn, &batch, &items, &node)?;
        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

fn empty_change_tx(txn: &DatabaseTransaction) -> Result<ChangeSet, DbErr> {
    Ok(ChangeSet {
        rev: document::current_rev(txn)? as f64,
        changed: Vec::new(),
        removed: Vec::new(),
        edges_changed: Vec::new(),
        edges_removed: Vec::new(),
    })
}

/// Writes the demo seed in one transaction. It refuses a document that has
/// already seeded or holds any node, so it can never duplicate a project.
/// The flag reports whether it wrote, so a no-op seed leaves history alone.
pub fn seed_document(
    conn: &DatabaseConnection,
    input: crate::types::SeedDocumentInput,
) -> Result<(ChangeSet, bool), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let document = document::current(txn)?;
        if document.demo_seeded != 0 {
            return Ok((empty_change_tx(txn)?, false));
        }
        if document.node_count != 0 || document.edge_count != 0 {
            return Err(DbErr::Custom(
                "the document is not empty; seed needs a new project".to_owned(),
            ));
        }
        if input.nodes.is_empty() {
            return Err(DbErr::Custom("a seed needs at least one node".to_owned()));
        }
        if input.batch.is_some() != input.item.is_some() {
            return Err(DbErr::Custom(
                "a seed's manual batch and item come together".to_owned(),
            ));
        }

        let mut changed: BTreeMap<String, nodes::Model> = BTreeMap::new();
        for node in &input.nodes {
            let row = insert_node_tx(txn, node)?;
            let model = find_node_tx(txn, &row.id)?;
            changed.insert(model.id.clone(), model);
        }

        if let (Some(batch), Some(item)) = (&input.batch, &input.item) {
            if batch.status != "done" {
                return Err(DbErr::Custom(
                    "a seed's manual batch must be done".to_owned(),
                ));
            }
            insert_running_batch_tx(txn, batch)?;
            insert_result_item_tx(txn, &batch.id, item)?;
            settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;
            let node = find_node_tx(txn, &batch.node_id)?;
            let updated = nodes::Entity::update(nodes::ActiveModel {
                seq: Unchanged(node.seq),
                body: Set(item.text.clone()),
                status: Set("done".to_owned()),
                output_batch_id: Set(Some(batch.id.clone())),
                rev: Set(node.rev + 1),
                updated_at: Set(now_ms()),
                ..Default::default()
            })
            .exec(txn)?;
            changed.insert(updated.id.clone(), updated);
        }

        let mut edges_changed = Vec::new();
        for edge in &input.edges {
            let connected = connect_edge_tx(txn, edge)?;
            edges_changed.push(edge_summary(
                &connected.edge,
                &connected.source,
                &connected.target,
            ));
        }
        if !input.edges.is_empty() {
            for edge in &input.edges {
                if let Some(node) = find_node_opt_tx(txn, &edge.to_id)? {
                    changed.insert(node.id.clone(), node);
                }
            }
        }

        // The marker makes the seed a one-time event: deleting every node and
        // reopening does not reseed; only a new project or a reset does.
        crate::entity::document::Entity::update(crate::entity::document::ActiveModel {
            id: Unchanged(document::ROW_ID),
            demo_seeded: Set(1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;

        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed: changed
                    .into_values()
                    .map(|row| node_row(&row).summary())
                    .collect(),
                removed: Vec::new(),
                edges_changed,
                edges_removed: Vec::new(),
            },
            true,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Stores a provider run's batch and items and switches the node's output to
/// it (for a successful run). This one-call form is for upload failures and
/// other writes with no provider call in between; a provider run uses
/// `begin_run` and `settle_run`.
pub fn save_run(
    conn: &DatabaseConnection,
    batch: ResultBatchInput,
    items: Vec<ResultItemInput>,
) -> Result<(ChangeSet, HistoryRefs), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        // A write for a node deleted mid-run is a no-op: its batch would be
        // unreachable, and undoing the delete must not revive a stale run.
        let Some(node) = find_node_opt_tx(txn, &batch.node_id)? else {
            return empty_settle(txn);
        };
        if batch.status == "done" && items.is_empty() {
            return Err(DbErr::Custom(
                "a successful batch must contain at least one item".to_owned(),
            ));
        }
        insert_running_batch_tx(txn, &batch)?;
        for item in &items {
            insert_result_item_tx(txn, &batch.id, item)?;
        }
        settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;

        let (changed, refs) = apply_batch_result_tx(txn, &batch, &items, &node)?;
        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Sets a node's run status (running, interrupted, …) without touching its
/// result. Used by the TSX orchestrator and on startup.
pub fn set_node_status(
    conn: &DatabaseConnection,
    id: String,
    status: String,
) -> Result<(ChangeSet, HistoryRefs), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        let updated = set_node_status_tx(txn, &before, &status)?;
        let mut refs = HistoryRefs::default();
        refs.node(id);
        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed: vec![node_row(&updated).summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            refs,
        ))
    })
    .map_err(|error| error.to_string())
}

/// Marks runs left running by a previous process as interrupted.
pub fn recover_runs(conn: &DatabaseConnection) -> Result<(u32, HistoryRefs), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let running_nodes = nodes::Entity::find()
            .filter(nodes::Column::Status.eq("running"))
            .all(txn)?;
        let running_batches = result_batches::Entity::find()
            .filter(result_batches::Column::Status.eq("running"))
            .all(txn)?;
        for node in &running_nodes {
            nodes::Entity::update(nodes::ActiveModel {
                seq: Unchanged(node.seq),
                status: Set("interrupted".to_owned()),
                rev: Set(node.rev + 1),
                updated_at: Set(now_ms()),
                ..Default::default()
            })
            .exec(txn)?;
        }

        result_batches::Entity::update_many()
            .col_expr(
                result_batches::Column::Status,
                sea_orm::sea_query::Expr::value("interrupted"),
            )
            .col_expr(
                result_batches::Column::FinishedAt,
                sea_orm::sea_query::Expr::value(now_ms()),
            )
            .filter(result_batches::Column::Status.eq("running"))
            .exec(txn)?;

        let mut refs = HistoryRefs::default();
        for node in &running_nodes {
            refs.node(node.id.clone());
        }
        for batch in &running_batches {
            refs.batch(Some(&batch.id));
        }
        if !running_nodes.is_empty() {
            finish_tx(txn)?;
        }
        Ok((running_nodes.len() as u32, refs))
    })
    .map_err(|error| error.to_string())
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
                    let updated = nodes::Entity::update(nodes::ActiveModel {
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
