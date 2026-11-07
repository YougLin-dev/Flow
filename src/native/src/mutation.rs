//! Document writes. Every user action is one transaction; the transaction
//! returns both the visible change set and the operations that undo it.

use std::collections::BTreeMap;

use sea_orm::{
    ActiveValue::{NotSet, Set, Unchanged},
    ColumnTrait, Condition, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    QueryFilter,
};

use crate::clock::now_ms;
use crate::constants::DOCUMENT_ID;
use crate::entity::{documents, edges, nodes, nodes_fts, nodes_rtree};
use crate::history::{EdgeRow, HistoryOp, NodeRow};
use crate::types::{ChangeSet, EdgeInput, NodeBounds, NodeInput};

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
        let mut removed = Vec::with_capacity(ids.len());
        let mut forward = Vec::with_capacity(ids.len());
        let mut inverse = Vec::with_capacity(ids.len());

        // Collect edges before the delete cascades them, so undo can restore
        // them after the nodes.
        let mut removed_edges = BTreeMap::new();
        for id in &ids {
            for edge in edges_for_node_tx(txn, id)? {
                removed_edges.entry(edge.id.clone()).or_insert(edge);
            }
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
        inverse.reverse();

        let rev = bump_document_rev(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: Vec::new(),
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
            changed.push(row.summary());
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
        let mut removed = Vec::with_capacity(ids.len());
        let mut forward = Vec::with_capacity(ids.len());
        let mut inverse = Vec::with_capacity(ids.len());

        for id in &ids {
            let row = find_edge_tx(txn, id)?;
            delete_edge_tx(txn, id)?;
            removed.push(id.clone());
            forward.push(HistoryOp::DeleteEdge { id: id.clone() });
            inverse.push(HistoryOp::InsertEdge(edge_row(&row)));
        }
        inverse.reverse();

        let rev = bump_document_rev(txn)?;
        Ok(Mutation {
            changes: ChangeSet {
                rev: rev as f64,
                changed: Vec::new(),
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

pub fn apply_ops(conn: &DatabaseConnection, ops: &[HistoryOp]) -> Result<ChangeSet, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut edges_changed = Vec::new();
        let mut edges_removed = Vec::new();

        for op in ops {
            match op {
                HistoryOp::Insert(row) => {
                    insert_row_tx(txn, row)?;
                    changed.push(row.summary());
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
                HistoryOp::InsertEdge(row) => {
                    insert_edge_row_tx(txn, row)?;
                    edges_changed.push(row.summary());
                }
                HistoryOp::DeleteEdge { id } => {
                    let edge = find_edge_tx(txn, id)?;
                    delete_edge_tx(txn, id)?;
                    edges_removed.push(edge.id);
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
    Ok(())
}

fn delete_edge_tx(txn: &DatabaseTransaction, id: &str) -> Result<(), DbErr> {
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
