//! Document writes. Every user action is one transaction; the transaction
//! returns both the visible change set and the operations that undo it.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{
    ActiveValue::{NotSet, Set, Unchanged},
    ColumnTrait, Condition, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    QueryFilter, QueryOrder,
};

use crate::clock::now_ms;
use crate::constants::DOCUMENT_ID;
use crate::edge_index;
use crate::entity::{
    documents, edges, node_inputs, nodes, nodes_fts, nodes_rtree, result_batches, result_items,
};
use crate::history::{EdgeRow, HistoryOp, InputRow, NodeRow};
use crate::types::{
    ChangeSet, EdgeInput, EdgePoint, EdgeSummary, InputItemInput, NodeBounds, NodeInput,
    ResultBatchInput, ResultItemInput,
};

/// A write and the history needed to reverse it.
pub struct Mutation {
    pub changes: ChangeSet,
    pub forward: Vec<HistoryOp>,
    pub inverse: Vec<HistoryOp>,
}

pub fn insert_nodes(conn: &DatabaseConnection, inputs: Vec<NodeInput>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
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

        let rev = bump_document_rev(txn)?;
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
        })
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
        let mut changed = Vec::with_capacity(ids.len());
        let mut forward = Vec::with_capacity(ids.len());
        let mut inverse = Vec::with_capacity(ids.len());

        for id in &ids {
            let before = find_node_tx(txn, id)?;
            let x = before.x + dx;
            let y = before.y + dy;
            let row = update_position_tx(txn, &before, x, y)?;
            changed.push(row.summary());
            forward.push(HistoryOp::Position {
                id: id.clone(),
                x,
                y,
            });
            inverse.push(HistoryOp::Position {
                id: id.clone(),
                x: before.x,
                y: before.y,
            });
        }

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_bounds(
    conn: &DatabaseConnection,
    bounds: Vec<NodeBounds>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let mut changed = Vec::with_capacity(bounds.len());
        let mut forward = Vec::with_capacity(bounds.len());
        let mut inverse = Vec::with_capacity(bounds.len());

        for next in &bounds {
            let before = find_node_tx(txn, &next.id)?;
            let row = update_bounds_tx(txn, &before, next.x, next.y, next.width, next.height)?;
            changed.push(row.summary());
            forward.push(HistoryOp::Bounds {
                id: next.id.clone(),
                x: next.x,
                y: next.y,
                width: next.width,
                height: next.height,
            });
            inverse.push(HistoryOp::Bounds {
                id: next.id.clone(),
                x: before.x,
                y: before.y,
                width: before.width,
                height: before.height,
            });
        }

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_text(
    conn: &DatabaseConnection,
    id: String,
    title: String,
    body: String,
    tags: Vec<String>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        let row = update_text_tx(txn, &before, &title, &body, &tags)?;
        let rev = bump_document_rev(txn)?;

        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: vec![row.summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::Text {
                id: id.clone(),
                title,
                body,
                tags,
            }],
            inverse: vec![HistoryOp::Text {
                id,
                title: before.title,
                body: before.body,
                tags: serde_json::from_str(&before.tags_json).unwrap_or_default(),
            }],
        })
    })
    .map_err(|error| error.to_string())
}

pub fn delete_nodes(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
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
        for id in &ids {
            let row = find_node_tx(txn, id)?;
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

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

pub fn insert_edges(conn: &DatabaseConnection, inputs: Vec<EdgeInput>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
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

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

pub fn delete_edges(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
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

        let rev = bump_document_rev(txn)?;
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
        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

struct ConnectedEdge {
    edge: EdgeRow,
    source: nodes::Model,
    target: nodes::Model,
    forward: Vec<HistoryOp>,
    inverse: Vec<HistoryOp>,
}

/// The change set's edge summary, with both ports for a scene that holds
/// only one of the edge's cards.
fn edge_summary(edge: &EdgeRow, from: &nodes::Model, to: &nodes::Model) -> EdgeSummary {
    EdgeSummary {
        from_point: Some(EdgePoint::output(from.x, from.y, from.width, from.height)),
        to_point: Some(EdgePoint::input(to.x, to.y, to.height)),
        ..edge.summary()
    }
}

/// One edge inside an open transaction: validation, the edge row, the
/// source's snapshotted inputs, the target touch and their history ops.
fn connect_edge_tx(txn: &DatabaseTransaction, input: &EdgeInput) -> Result<ConnectedEdge, DbErr> {
    if input.from_id == input.to_id {
        return Err(DbErr::Custom("a node cannot connect to itself".to_owned()));
    }
    let source = find_node_tx(txn, &input.from_id)?;
    find_node_tx(txn, &input.to_id)?;
    if already_connected_tx(txn, &input.from_id, &input.to_id, &input.id)? {
        return Err(DbErr::Custom(
            "these nodes are already connected".to_owned(),
        ));
    }

    let edge = insert_edge_tx(txn, input)?;
    let mut forward = vec![HistoryOp::InsertEdge(edge.clone())];
    let mut desired_inverse = Vec::new();
    let mut position = max_input_position_tx(txn, &input.to_id)?;

    if let Some(batch_id) = &source.output_batch_id {
        for item in items_for_batch_tx(txn, batch_id)? {
            let row = InputRow {
                id: format!("input-{}-{}", edge.id, item.id),
                node_id: input.to_id.clone(),
                position,
                kind: item.kind.clone(),
                origin: "edge".to_owned(),
                edge_id: Some(edge.id.clone()),
                item_id: Some(item.id.clone()),
                asset_id: item.asset_id.clone(),
                text: item.text.clone(),
                meta_json: item.meta_json.clone(),
                created_at: now_ms(),
            };
            insert_input_row_tx(txn, &row)?;
            forward.push(HistoryOp::InsertInput(row.clone()));
            desired_inverse.push(HistoryOp::DeleteInput { id: row.id });
            position += 1;
        }
    }

    let target = touch_node_tx(txn, &input.to_id)?;
    desired_inverse.push(HistoryOp::DeleteEdge {
        id: edge.id.clone(),
    });
    desired_inverse.reverse();

    Ok(ConnectedEdge {
        edge,
        source,
        target,
        forward,
        inverse: desired_inverse,
    })
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
        if already_connected_tx(txn, &input.from_id, &input.to_id, &input.id)? {
            return Err(DbErr::Custom(
                "these nodes are already connected".to_owned(),
            ));
        }

        let old_inputs = inputs_for_edge_tx(txn, &input.id)?;
        for row in &old_inputs {
            delete_input_tx(txn, &row.id)?;
        }

        let after = replace_edge_row_tx(
            txn,
            &EdgeRow {
                id: input.id.clone(),
                from_id: input.from_id.clone(),
                to_id: input.to_id.clone(),
                from_port: input.from_port.clone(),
                to_port: input.to_port.clone(),
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
        let mut position = max_input_position_tx(txn, &input.to_id)?;
        if let Some(batch_id) = &source.output_batch_id {
            for item in items_for_batch_tx(txn, batch_id)? {
                let row = InputRow {
                    id: format!("input-{}-{}", after.id, item.id),
                    node_id: input.to_id.clone(),
                    position,
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

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

/// Appends one local input (for example an uploaded image) to a node.
pub fn add_input(conn: &DatabaseConnection, input: InputItemInput) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &input.node_id)?;
        let row = InputRow {
            id: input.id,
            node_id: input.node_id,
            position: input.position.max(0.0) as i32,
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

        let rev = bump_document_rev(txn)?;
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

        let rev = bump_document_rev(txn)?;
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
        })
    })
    .map_err(|error| error.to_string())
}

/// Persists a drag-reordered input list. Every input of the node is given a
/// new position; ids the caller omitted keep their relative order at the end.
pub fn reorder_inputs(
    conn: &DatabaseConnection,
    node_id: String,
    ids: Vec<String>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &node_id)?;
        let current = inputs_for_node_tx(txn, &node_id)?;
        let before: Vec<(String, i32)> = current
            .iter()
            .map(|row| (row.id.clone(), row.position))
            .collect();
        let mut after = Vec::with_capacity(current.len());
        for (index, id) in ids.iter().enumerate() {
            if current.iter().any(|row| &row.id == id) && !after.iter().any(|(seen, _)| seen == id)
            {
                after.push((id.clone(), index as i32));
            }
        }
        for row in &current {
            if !after.iter().any(|(seen, _)| seen == &row.id) {
                let position = after.len() as i32;
                after.push((row.id.clone(), position));
            }
        }

        set_input_positions_tx(txn, &node_id, &after)?;
        let changed = vec![node_row(&touch_node_tx(txn, &node_id)?).summary()];

        let rev = bump_document_rev(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::InputOrder {
                node_id: node_id.clone(),
                order: after,
            }],
            inverse: vec![HistoryOp::InputOrder {
                node_id,
                order: before,
            }],
        })
    })
    .map_err(|error| error.to_string())
}

/// Replaces a node's opaque kind settings. A node with a result becomes stale.
/// Rebuilds a node's edge inputs from the current batches of every connected
/// source. Local inputs keep their order; their old exclusions are cleared,
/// as a regeneration starts from the sources' current outputs.
pub fn sync_inputs(conn: &DatabaseConnection, node_id: String) -> Result<(), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &node_id)?;
        let current = inputs_for_node_tx(txn, &node_id)?;
        let mut locals = Vec::new();
        let mut edge_rows = Vec::new();
        for row in current {
            if row.origin == "edge" {
                edge_rows.push(row.id);
            } else {
                locals.push(row);
            }
        }
        for id in &edge_rows {
            delete_input_tx(txn, id)?;
        }

        let mut order: Vec<(String, i32)> = Vec::new();
        for row in &locals {
            order.push((row.id.clone(), order.len() as i32));
        }

        let incoming = edges::Entity::find()
            .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
            .filter(edges::Column::ToId.eq(&node_id))
            .order_by_asc(edges::Column::Id)
            .all(txn)?;
        for edge in incoming {
            let source = find_node_tx(txn, &edge.from_id)?;
            let Some(batch_id) = source.output_batch_id else {
                continue;
            };
            for item in items_for_batch_tx(txn, &batch_id)? {
                let row = InputRow {
                    id: format!("input-{}-{}", edge.id, item.id),
                    node_id: node_id.clone(),
                    position: order.len() as i32,
                    kind: item.kind.clone(),
                    origin: "edge".to_owned(),
                    edge_id: Some(edge.id.clone()),
                    item_id: Some(item.id.clone()),
                    asset_id: item.asset_id.clone(),
                    text: item.text.clone(),
                    meta_json: item.meta_json.clone(),
                    created_at: now_ms(),
                };
                insert_input_row_tx(txn, &row)?;
                order.push((row.id, row.position));
            }
        }

        set_input_positions_tx(txn, &node_id, &order)?;
        touch_node_tx(txn, &node_id)?;
        bump_document_rev(txn)?;
        Ok(())
    })
    .map_err(|error| error.to_string())
}

pub fn set_node_settings(
    conn: &DatabaseConnection,
    id: String,
    settings_json: String,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        let after = apply_settings_tx(txn, &before, settings_json.clone())?;
        let rev = bump_document_rev(txn)?;

        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: vec![after.summary()],
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            // Only the settings are history: a run's output and body belong
            // to the run and must survive an undo of this edit.
            forward: vec![HistoryOp::Settings {
                id: id.clone(),
                settings_json,
            }],
            inverse: vec![HistoryOp::Settings {
                id,
                settings_json: before.settings_json,
            }],
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
        insert_batch_tx(txn, &batch)?;
        insert_result_item_tx(txn, &batch.id, &item)?;

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
        refresh_fts_tx(txn, &updated)?;
        let mut changed = vec![after.summary()];
        changed.extend(
            mark_downstream_stale_tx(txn, &id)?
                .into_iter()
                .map(|row| node_row(&row).summary()),
        );

        // The batch itself stays on undo, like a provider batch: it may still
        // be referenced by a downstream input snapshot.
        let rev = bump_document_rev(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed,
                removed: Vec::new(),
                edges_changed: Vec::new(),
                edges_removed: Vec::new(),
            },
            forward: vec![HistoryOp::Replace(after)],
            inverse: vec![HistoryOp::Replace(node_row(&before))],
        })
    })
    .map_err(|error| error.to_string())
}

/// Stores a provider run's batch and items and switches the node's output to
/// it (for a successful run). Provider runs are not undoable.
pub fn save_run(
    conn: &DatabaseConnection,
    batch: ResultBatchInput,
    items: Vec<ResultItemInput>,
) -> Result<ChangeSet, String> {
    let family = batch.node_id.clone();
    conn.transaction::<_, _, DbErr>(|txn| {
        find_node_tx(txn, &family)?;
        if batch.status == "done" && items.is_empty() {
            return Err(DbErr::Custom(
                "a successful batch must contain at least one item".to_owned(),
            ));
        }
        insert_batch_tx(txn, &batch)?;
        for item in &items {
            insert_result_item_tx(txn, &batch.id, item)?;
        }

        let before = find_node_tx(txn, &family)?;
        let body = items
            .iter()
            .find(|item| item.kind == "text")
            .map(|item| item.text.clone())
            .unwrap_or_else(|| before.body.clone());
        let mut active = nodes::ActiveModel {
            seq: Unchanged(before.seq),
            status: Set(batch.status.clone()),
            rev: Set(before.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        };
        if batch.status == "done" {
            active.output_batch_id = Set(Some(batch.id.clone()));
            active.body = Set(body);
        }
        let updated = nodes::Entity::update(active).exec(txn)?;

        let mut changed = vec![node_row(&updated).summary()];
        if batch.status == "done" {
            refresh_fts_tx(txn, &updated)?;
            changed.extend(
                mark_downstream_stale_tx(txn, &family)?
                    .into_iter()
                    .map(|row| node_row(&row).summary()),
            );
        }

        let rev = bump_document_rev(txn)?;
        Ok(ChangeSet {
            rev: rev as f64,
            changed,
            removed: Vec::new(),
            edges_changed: Vec::new(),
            edges_removed: Vec::new(),
        })
    })
    .map_err(|error| error.to_string())
}

/// Sets a node's run status (running, interrupted, …) without touching its
/// result. Used by the TSX orchestrator and on startup.
pub fn set_node_status(
    conn: &DatabaseConnection,
    id: String,
    status: String,
) -> Result<ChangeSet, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let before = find_node_tx(txn, &id)?;
        let updated = nodes::Entity::update(nodes::ActiveModel {
            seq: Unchanged(before.seq),
            status: Set(status),
            rev: Set(before.rev + 1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;
        let rev = bump_document_rev(txn)?;
        Ok(ChangeSet {
            rev: rev as f64,
            changed: vec![node_row(&updated).summary()],
            removed: Vec::new(),
            edges_changed: Vec::new(),
            edges_removed: Vec::new(),
        })
    })
    .map_err(|error| error.to_string())
}

/// Marks runs left running by a previous process as interrupted.
pub fn recover_runs(conn: &DatabaseConnection) -> Result<u32, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let running_nodes = nodes::Entity::find()
            .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
            .filter(nodes::Column::Status.eq("running"))
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
            .filter(result_batches::Column::Status.eq("running"))
            .exec(txn)?;

        if !running_nodes.is_empty() {
            bump_document_rev(txn)?;
        }
        Ok(running_nodes.len() as u32)
    })
    .map_err(|error| error.to_string())
}

pub fn apply_ops(conn: &DatabaseConnection, ops: &[HistoryOp]) -> Result<ChangeSet, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut edges_changed = Vec::new();
        let mut edges_removed = Vec::new();
        let mut touched = BTreeSet::new();

        for op in ops {
            match op {
                HistoryOp::Insert(row) => {
                    insert_row_tx(txn, row)?;
                    changed.push(row.summary());
                }
                HistoryOp::Replace(row) => {
                    let row = replace_node_tx(txn, row)?;
                    changed.push(node_row(&row).summary());
                }
                HistoryOp::Delete { id } => {
                    let row = find_node_tx(txn, id)?;
                    for edge in edges_for_node_tx(txn, id)? {
                        edges_removed.push(edge.id);
                    }
                    delete_node_tx(txn, &row)?;
                    removed.push(id.clone());
                }
                HistoryOp::Position { id, x, y } => {
                    let before = find_node_tx(txn, id)?;
                    let row = update_position_tx(txn, &before, *x, *y)?;
                    changed.push(row.summary());
                }
                HistoryOp::Bounds {
                    id,
                    x,
                    y,
                    width,
                    height,
                } => {
                    let before = find_node_tx(txn, id)?;
                    let row = update_bounds_tx(txn, &before, *x, *y, *width, *height)?;
                    changed.push(row.summary());
                }
                HistoryOp::Text {
                    id,
                    title,
                    body,
                    tags,
                } => {
                    let before = find_node_tx(txn, id)?;
                    let row = update_text_tx(txn, &before, title, body, tags)?;
                    changed.push(row.summary());
                }
                HistoryOp::Settings { id, settings_json } => {
                    let before = find_node_tx(txn, id)?;
                    let row = apply_settings_tx(txn, &before, settings_json.clone())?;
                    changed.push(row.summary());
                }
                HistoryOp::InsertEdge(row) => {
                    insert_edge_row_tx(txn, row)?;
                    let from = find_node_tx(txn, &row.from_id)?;
                    let to = find_node_tx(txn, &row.to_id)?;
                    edges_changed.push(edge_summary(row, &from, &to));
                }
                HistoryOp::ReplaceEdge(row) => {
                    let row = replace_edge_row_tx(txn, row)?;
                    let from = find_node_tx(txn, &row.from_id)?;
                    let to = find_node_tx(txn, &row.to_id)?;
                    edges_changed.push(edge_summary(&row, &from, &to));
                }
                HistoryOp::DeleteEdge { id } => {
                    let edge = find_edge_tx(txn, id)?;
                    delete_edge_tx(txn, id)?;
                    edges_removed.push(edge.id);
                }
                HistoryOp::InsertInput(row) => {
                    // A provider run's input sync may already have recreated
                    // this snapshot: runs are not history, so restoring an
                    // input is idempotent.
                    let exists = node_inputs::Entity::find_by_id(row.id.clone())
                        .one(txn)?
                        .is_some();
                    if !exists {
                        insert_input_row_tx(txn, row)?;
                    }
                    if touched.insert(row.node_id.clone()) {
                        changed.push(node_row(&touch_node_tx(txn, &row.node_id)?).summary());
                    }
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
                }
                HistoryOp::InputOrder { node_id, order } => {
                    set_input_positions_tx(txn, node_id, order)?;
                    if touched.insert(node_id.clone()) {
                        changed.push(node_row(&touch_node_tx(txn, node_id)?).summary());
                    }
                }
            }
        }

        let rev = bump_document_rev(txn)?;
        Ok(ChangeSet {
            rev: rev as f64,
            changed,
            removed,
            edges_changed,
            edges_removed,
        })
    })
    .map_err(|error| error.to_string())
}

fn insert_node_tx(txn: &DatabaseTransaction, node: &NodeInput) -> Result<NodeRow, DbErr> {
    let now = now_ms();
    let tags = serde_json::to_string(&node.tags)
        .map_err(|error| DbErr::Custom(format!("tags are not serializable: {error}")))?;
    let data_json = node.data_json.clone().unwrap_or_else(|| "{}".to_owned());
    let settings_json = node
        .settings_json
        .clone()
        .unwrap_or_else(|| "{}".to_owned());

    let inserted = nodes::Entity::insert(nodes::ActiveModel {
        seq: NotSet,
        id: Set(node.id.clone()),
        document_id: Set(DOCUMENT_ID.to_owned()),
        kind: Set(node.kind.clone()),
        title: Set(node.title.clone()),
        body: Set(node.body.clone()),
        tags_json: Set(tags),
        x: Set(node.x),
        y: Set(node.y),
        width: Set(node.width),
        height: Set(node.height),
        z: Set(node.z),
        data_json: Set(data_json.clone()),
        settings_json: Set(settings_json.clone()),
        status: Set("idle".to_owned()),
        output_batch_id: Set(None),
        rev: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec(txn)?;

    insert_indexes_tx(
        txn,
        NodeIndex {
            seq: inserted.last_insert_id,
            title: &node.title,
            body: &node.body,
            tags: &node.tags,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
        },
    )?;

    Ok(NodeRow {
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        body: node.body.clone(),
        tags: node.tags.clone(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        z: node.z,
        data_json,
        settings_json,
        status: "idle".to_owned(),
        output_batch_id: None,
        rev: 1,
        created_at: now,
        updated_at: now,
    })
}

fn insert_row_tx(txn: &DatabaseTransaction, row: &NodeRow) -> Result<(), DbErr> {
    let tags = serde_json::to_string(&row.tags)
        .map_err(|error| DbErr::Custom(format!("tags are not serializable: {error}")))?;

    let inserted = nodes::Entity::insert(nodes::ActiveModel {
        seq: NotSet,
        id: Set(row.id.clone()),
        document_id: Set(DOCUMENT_ID.to_owned()),
        kind: Set(row.kind.clone()),
        title: Set(row.title.clone()),
        body: Set(row.body.clone()),
        tags_json: Set(tags),
        x: Set(row.x),
        y: Set(row.y),
        width: Set(row.width),
        height: Set(row.height),
        z: Set(row.z),
        data_json: Set(row.data_json.clone()),
        settings_json: Set(row.settings_json.clone()),
        status: Set(row.status.clone()),
        output_batch_id: Set(row.output_batch_id.clone()),
        rev: Set(row.rev),
        created_at: Set(row.created_at),
        updated_at: Set(row.updated_at),
    })
    .exec(txn)?;

    insert_indexes_tx(
        txn,
        NodeIndex {
            seq: inserted.last_insert_id,
            title: &row.title,
            body: &row.body,
            tags: &row.tags,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
        },
    )
}

/// A node's values that the spatial and search indexes need.
struct NodeIndex<'a> {
    seq: i32,
    title: &'a str,
    body: &'a str,
    tags: &'a [String],
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn insert_indexes_tx(txn: &DatabaseTransaction, node: NodeIndex<'_>) -> Result<(), DbErr> {
    nodes_rtree::Entity::insert(nodes_rtree::ActiveModel {
        id: Set(node.seq),
        min_x: Set(node.x),
        max_x: Set(node.x + node.width),
        min_y: Set(node.y),
        max_y: Set(node.y + node.height),
    })
    .exec(txn)?;

    nodes_fts::Entity::insert(nodes_fts::ActiveModel {
        rowid: Set(node.seq),
        title: Set(node.title.to_owned()),
        body: Set(node.body.to_owned()),
        tags: Set(node.tags.join(" ")),
    })
    .exec(txn)?;

    Ok(())
}

fn delete_node_tx(txn: &DatabaseTransaction, node: &nodes::Model) -> Result<(), DbErr> {
    // The edge rows cascade with the node, which the edge RTree does not
    // know about; drop their index rows first, while they still exist.
    edge_index::remove_node_edges(txn, &node.id)?;
    nodes_rtree::Entity::delete_by_id(node.seq).exec(txn)?;
    nodes_fts::Entity::delete_by_id(node.seq).exec(txn)?;
    nodes::Entity::delete_by_id(node.seq).exec(txn)?;
    Ok(())
}

fn update_position_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    x: f64,
    y: f64,
) -> Result<NodeRow, DbErr> {
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        x: Set(x),
        y: Set(y),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    nodes_rtree::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_rtree::Entity::insert(nodes_rtree::ActiveModel {
        id: Set(updated.seq),
        min_x: Set(updated.x),
        max_x: Set(updated.x + updated.width),
        min_y: Set(updated.y),
        max_y: Set(updated.y + updated.height),
    })
    .exec(txn)?;
    edge_index::sync_node_edges(txn, &updated.id)?;

    Ok(node_row(&updated))
}

fn update_bounds_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<NodeRow, DbErr> {
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        x: Set(x),
        y: Set(y),
        width: Set(width),
        height: Set(height),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    nodes_rtree::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_rtree::Entity::insert(nodes_rtree::ActiveModel {
        id: Set(updated.seq),
        min_x: Set(updated.x),
        max_x: Set(updated.x + updated.width),
        min_y: Set(updated.y),
        max_y: Set(updated.y + updated.height),
    })
    .exec(txn)?;
    edge_index::sync_node_edges(txn, &updated.id)?;

    Ok(node_row(&updated))
}

fn update_text_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    title: &str,
    body: &str,
    tags: &[String],
) -> Result<NodeRow, DbErr> {
    let tags_json = serde_json::to_string(tags)
        .map_err(|error| DbErr::Custom(format!("tags are not serializable: {error}")))?;

    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        title: Set(title.to_owned()),
        body: Set(body.to_owned()),
        tags_json: Set(tags_json),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    nodes_fts::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_fts::Entity::insert(nodes_fts::ActiveModel {
        rowid: Set(updated.seq),
        title: Set(updated.title.clone()),
        body: Set(updated.body.clone()),
        tags: Set(tags.join(" ")),
    })
    .exec(txn)?;

    Ok(node_row(&updated))
}

/// Applies kind settings while leaving the body, output and run status to
/// the commands that own them. An existing result no longer matches the new
/// settings, so it becomes stale instead of claiming to be current.
fn apply_settings_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    settings_json: String,
) -> Result<NodeRow, DbErr> {
    let stale = before.output_batch_id.is_some() && before.status != "running";
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        settings_json: Set(settings_json),
        status: Set(if stale {
            "stale".to_owned()
        } else {
            before.status.clone()
        }),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;
    Ok(node_row(&updated))
}

/// Rewrites a node's search row from its current values. Body writes that
/// update the node directly (manual edits and provider runs) must call this,
/// or search keeps matching the old text.
fn refresh_fts_tx(txn: &DatabaseTransaction, node: &nodes::Model) -> Result<(), DbErr> {
    let tags: Vec<String> = serde_json::from_str(&node.tags_json).unwrap_or_default();
    nodes_fts::Entity::delete_by_id(node.seq).exec(txn)?;
    nodes_fts::Entity::insert(nodes_fts::ActiveModel {
        rowid: Set(node.seq),
        title: Set(node.title.clone()),
        body: Set(node.body.clone()),
        tags: Set(tags.join(" ")),
    })
    .exec(txn)?;
    Ok(())
}

fn insert_edge_tx(txn: &DatabaseTransaction, input: &EdgeInput) -> Result<EdgeRow, DbErr> {
    let data_json = input.data_json.clone().unwrap_or_else(|| "{}".to_owned());
    edges::Entity::insert(edges::ActiveModel {
        id: Set(input.id.clone()),
        document_id: Set(DOCUMENT_ID.to_owned()),
        from_id: Set(input.from_id.clone()),
        to_id: Set(input.to_id.clone()),
        from_port: Set(input.from_port.clone()),
        to_port: Set(input.to_port.clone()),
        kind: Set(input.kind.clone()),
        data_json: Set(data_json.clone()),
    })
    .exec(txn)?;
    edge_index::sync_edge(txn, &input.id)?;

    Ok(EdgeRow {
        id: input.id.clone(),
        from_id: input.from_id.clone(),
        to_id: input.to_id.clone(),
        from_port: input.from_port.clone(),
        to_port: input.to_port.clone(),
        kind: input.kind.clone(),
        data_json,
    })
}

fn insert_edge_row_tx(txn: &DatabaseTransaction, row: &EdgeRow) -> Result<(), DbErr> {
    edges::Entity::insert(edges::ActiveModel {
        id: Set(row.id.clone()),
        document_id: Set(DOCUMENT_ID.to_owned()),
        from_id: Set(row.from_id.clone()),
        to_id: Set(row.to_id.clone()),
        from_port: Set(row.from_port.clone()),
        to_port: Set(row.to_port.clone()),
        kind: Set(row.kind.clone()),
        data_json: Set(row.data_json.clone()),
    })
    .exec(txn)?;
    edge_index::sync_edge(txn, &row.id)
}

fn replace_edge_row_tx(txn: &DatabaseTransaction, row: &EdgeRow) -> Result<EdgeRow, DbErr> {
    edges::Entity::update(edges::ActiveModel {
        id: Unchanged(row.id.clone()),
        from_id: Set(row.from_id.clone()),
        to_id: Set(row.to_id.clone()),
        from_port: Set(row.from_port.clone()),
        to_port: Set(row.to_port.clone()),
        kind: Set(row.kind.clone()),
        data_json: Set(row.data_json.clone()),
        ..Default::default()
    })
    .exec(txn)?;
    edge_index::sync_edge(txn, &row.id)?;
    Ok(row.clone())
}

fn delete_edge_tx(txn: &DatabaseTransaction, id: &str) -> Result<(), DbErr> {
    edge_index::remove_edge(txn, id)?;
    edges::Entity::delete_by_id(id.to_owned()).exec(txn)?;
    Ok(())
}

fn find_node_tx(txn: &DatabaseTransaction, id: &str) -> Result<nodes::Model, DbErr> {
    nodes::Entity::find()
        .filter(nodes::Column::Id.eq(id))
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .one(txn)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("node {id} was not found")))
}

/// Whether another edge already joins this ordered pair. Parallel duplicate
/// edges would snapshot the same items twice, so M1 keeps one per direction.
fn already_connected_tx(
    txn: &DatabaseTransaction,
    from_id: &str,
    to_id: &str,
    except_edge_id: &str,
) -> Result<bool, DbErr> {
    Ok(edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(edges::Column::FromId.eq(from_id))
        .filter(edges::Column::ToId.eq(to_id))
        .filter(edges::Column::Id.ne(except_edge_id))
        .one(txn)?
        .is_some())
}

fn find_edge_tx(txn: &DatabaseTransaction, id: &str) -> Result<edges::Model, DbErr> {
    edges::Entity::find_by_id(id.to_owned())
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .one(txn)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("edge {id} was not found")))
}

fn edges_for_node_tx(txn: &DatabaseTransaction, id: &str) -> Result<Vec<EdgeRow>, DbErr> {
    edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(
            Condition::any()
                .add(edges::Column::FromId.eq(id))
                .add(edges::Column::ToId.eq(id)),
        )
        .all(txn)
        .map(|rows| rows.iter().map(edge_row).collect())
}

fn items_for_batch_tx(
    txn: &DatabaseTransaction,
    batch_id: &str,
) -> Result<Vec<result_items::Model>, DbErr> {
    result_items::Entity::find()
        .filter(result_items::Column::BatchId.eq(batch_id))
        .order_by_asc(result_items::Column::Position)
        .order_by_asc(result_items::Column::Id)
        .all(txn)
}

fn insert_batch_tx(txn: &DatabaseTransaction, batch: &ResultBatchInput) -> Result<(), DbErr> {
    result_batches::Entity::insert(result_batches::ActiveModel {
        id: Set(batch.id.clone()),
        node_id: Set(batch.node_id.clone()),
        trigger: Set(batch.trigger.clone()),
        provider: Set(batch.provider.clone()),
        model: Set(batch.model.clone()),
        params_json: Set(batch.params_json.clone()),
        status: Set(batch.status.clone()),
        error: Set(batch.error.clone().unwrap_or_default()),
        created_at: Set(now_ms()),
    })
    .exec(txn)?;
    Ok(())
}

fn insert_result_item_tx(
    txn: &DatabaseTransaction,
    batch_id: &str,
    item: &ResultItemInput,
) -> Result<(), DbErr> {
    result_items::Entity::insert(result_items::ActiveModel {
        id: Set(item.id.clone()),
        batch_id: Set(batch_id.to_owned()),
        position: Set(item.position.max(0.0) as i32),
        kind: Set(item.kind.clone()),
        text: Set(item.text.clone()),
        asset_id: Set(item.asset_id.clone()),
        meta_json: Set(item.meta_json.clone().unwrap_or_else(|| "{}".to_owned())),
    })
    .exec(txn)?;
    Ok(())
}

fn insert_input_row_tx(txn: &DatabaseTransaction, row: &InputRow) -> Result<(), DbErr> {
    node_inputs::Entity::insert(node_inputs::ActiveModel {
        id: Set(row.id.clone()),
        node_id: Set(row.node_id.clone()),
        position: Set(row.position),
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

fn find_input_tx(txn: &DatabaseTransaction, id: &str) -> Result<node_inputs::Model, DbErr> {
    node_inputs::Entity::find_by_id(id.to_owned())
        .one(txn)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("input {id} was not found")))
}

fn delete_input_tx(txn: &DatabaseTransaction, id: &str) -> Result<(), DbErr> {
    node_inputs::Entity::delete_by_id(id.to_owned()).exec(txn)?;
    Ok(())
}

fn inputs_for_node_tx(txn: &DatabaseTransaction, node_id: &str) -> Result<Vec<InputRow>, DbErr> {
    node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .order_by_asc(node_inputs::Column::Position)
        .order_by_asc(node_inputs::Column::Id)
        .all(txn)
        .map(|rows| rows.iter().map(input_row).collect())
}

fn inputs_for_edge_tx(txn: &DatabaseTransaction, edge_id: &str) -> Result<Vec<InputRow>, DbErr> {
    node_inputs::Entity::find()
        .filter(node_inputs::Column::EdgeId.eq(edge_id))
        .order_by_asc(node_inputs::Column::Position)
        .all(txn)
        .map(|rows| rows.iter().map(input_row).collect())
}

fn inputs_for_nodes_tx(
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

fn max_input_position_tx(txn: &DatabaseTransaction, node_id: &str) -> Result<i32, DbErr> {
    let row = node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .order_by_desc(node_inputs::Column::Position)
        .one(txn)?;
    Ok(row.map_or(0, |row| row.position + 1))
}

fn set_input_positions_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    order: &[(String, i32)],
) -> Result<(), DbErr> {
    for (id, position) in order {
        node_inputs::Entity::update_many()
            .col_expr(
                node_inputs::Column::Position,
                sea_orm::sea_query::Expr::value(*position),
            )
            .filter(node_inputs::Column::Id.eq(id))
            .filter(node_inputs::Column::NodeId.eq(node_id))
            .exec(txn)?;
    }
    Ok(())
}

/// Records an input-list change on a node. The node is always returned so
/// clients (the composer in particular) refresh even before the node has an
/// output; an existing result becomes stale because it no longer matches
/// its inputs.
fn touch_node_tx(txn: &DatabaseTransaction, id: &str) -> Result<nodes::Model, DbErr> {
    let node = find_node_tx(txn, id)?;
    let stale =
        node.output_batch_id.is_some() && node.status != "running" && node.status != "stale";
    nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(node.seq),
        status: Set(if stale {
            "stale".to_owned()
        } else {
            node.status.clone()
        }),
        rev: Set(node.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)
}

fn mark_stale_tx(txn: &DatabaseTransaction, id: &str) -> Result<Option<nodes::Model>, DbErr> {
    let node = find_node_tx(txn, id)?;
    if node.output_batch_id.is_none() || node.status == "running" || node.status == "stale" {
        return Ok(None);
    }
    nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(node.seq),
        status: Set("stale".to_owned()),
        rev: Set(node.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)
    .map(Some)
}

fn mark_downstream_stale_tx(
    txn: &DatabaseTransaction,
    source_id: &str,
) -> Result<Vec<nodes::Model>, DbErr> {
    let edges = edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(edges::Column::FromId.eq(source_id))
        .all(txn)?;
    let mut stale = Vec::new();
    for edge in edges {
        if let Some(node) = mark_stale_tx(txn, &edge.to_id)? {
            stale.push(node);
        }
    }
    Ok(stale)
}

fn replace_node_tx(txn: &DatabaseTransaction, row: &NodeRow) -> Result<nodes::Model, DbErr> {
    let before = find_node_tx(txn, &row.id)?;
    let tags_json = serde_json::to_string(&row.tags)
        .map_err(|error| DbErr::Custom(format!("tags are not serializable: {error}")))?;
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        title: Set(row.title.clone()),
        body: Set(row.body.clone()),
        tags_json: Set(tags_json),
        x: Set(row.x),
        y: Set(row.y),
        width: Set(row.width),
        height: Set(row.height),
        z: Set(row.z),
        data_json: Set(row.data_json.clone()),
        settings_json: Set(row.settings_json.clone()),
        status: Set(row.status.clone()),
        output_batch_id: Set(row.output_batch_id.clone()),
        rev: Set(row.rev),
        updated_at: Set(row.updated_at),
        ..Default::default()
    })
    .exec(txn)?;

    nodes_rtree::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_rtree::Entity::insert(nodes_rtree::ActiveModel {
        id: Set(updated.seq),
        min_x: Set(updated.x),
        max_x: Set(updated.x + updated.width),
        min_y: Set(updated.y),
        max_y: Set(updated.y + updated.height),
    })
    .exec(txn)?;
    nodes_fts::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_fts::Entity::insert(nodes_fts::ActiveModel {
        rowid: Set(updated.seq),
        title: Set(updated.title.clone()),
        body: Set(updated.body.clone()),
        tags: Set(row.tags.join(" ")),
    })
    .exec(txn)?;
    edge_index::sync_node_edges(txn, &updated.id)?;

    Ok(updated)
}

fn input_row(row: &node_inputs::Model) -> InputRow {
    InputRow {
        id: row.id.clone(),
        node_id: row.node_id.clone(),
        position: row.position,
        kind: row.kind.clone(),
        origin: row.origin.clone(),
        edge_id: row.edge_id.clone(),
        item_id: row.item_id.clone(),
        asset_id: row.asset_id.clone(),
        text: row.text.clone(),
        meta_json: row.meta_json.clone(),
        created_at: row.created_at,
    }
}

fn bump_document_rev(txn: &DatabaseTransaction) -> Result<i64, DbErr> {
    let document = documents::Entity::find_by_id(DOCUMENT_ID)
        .one(txn)?
        .ok_or_else(|| DbErr::RecordNotFound("the default document was not found".to_owned()))?;

    let updated = documents::Entity::update(documents::ActiveModel {
        id: Unchanged(document.id),
        rev: Set(document.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    Ok(updated.rev)
}

fn node_row(node: &nodes::Model) -> NodeRow {
    NodeRow {
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        body: node.body.clone(),
        tags: serde_json::from_str(&node.tags_json).unwrap_or_default(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        z: node.z,
        data_json: node.data_json.clone(),
        settings_json: node.settings_json.clone(),
        status: node.status.clone(),
        output_batch_id: node.output_batch_id.clone(),
        rev: node.rev,
        created_at: node.created_at,
        updated_at: node.updated_at,
    }
}

fn edge_row(edge: &edges::Model) -> EdgeRow {
    EdgeRow {
        id: edge.id.clone(),
        from_id: edge.from_id.clone(),
        to_id: edge.to_id.clone(),
        from_port: edge.from_port.clone(),
        to_port: edge.to_port.clone(),
        kind: edge.kind.clone(),
        data_json: edge.data_json.clone(),
    }
}
