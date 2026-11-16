//! Node transactions.

use std::collections::HashMap;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::{NotSet, Set, Unchanged},
    ColumnTrait, DatabaseTransaction, DbErr, EntityTrait, QueryFilter,
};

use crate::clock::now_ms;
use crate::entity::nodes;
use crate::history::NodeRow;
use crate::types::{NodeBounds, NodeInput};

use crate::mutation::support::{canonical_tags, node_row, tags_from};
use crate::mutation::tx::edges::scale_edge_offsets_tx;

/// The post-update rows plus each row's pre-update state and target bounds,
/// both in input order.
type BoundsBatch = (Vec<NodeRow>, Vec<(NodeRow, NodeBounds)>);

pub(in crate::mutation) fn insert_node_tx(
    txn: &DatabaseTransaction,
    node: &NodeInput,
) -> Result<NodeRow, DbErr> {
    let now = now_ms();
    let tags = canonical_tags(&node.tags);
    let data_json = node.data_json.clone().unwrap_or_else(|| "{}".to_owned());
    let settings_json = node
        .settings_json
        .clone()
        .unwrap_or_else(|| "{}".to_owned());

    let inserted = nodes::Entity::insert(nodes::ActiveModel {
        seq: NotSet,
        id: Set(node.id.clone()),
        kind: Set(node.kind.clone()),
        title: Set(node.title.clone()),
        body: Set(node.body.clone()),
        tags: Set(tags.clone()),
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

    Ok(NodeRow {
        seq: inserted.last_insert_id,
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        body: node.body.clone(),
        tags: tags_from(&tags),
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

pub(in crate::mutation) fn insert_row_tx(
    txn: &DatabaseTransaction,
    row: &NodeRow,
) -> Result<(), DbErr> {
    nodes::Entity::insert(nodes::ActiveModel {
        seq: Set(row.seq),
        id: Set(row.id.clone()),
        kind: Set(row.kind.clone()),
        title: Set(row.title.clone()),
        body: Set(row.body.clone()),
        tags: Set(canonical_tags(&row.tags)),
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
    Ok(())
}

pub(in crate::mutation) fn delete_node_tx(
    txn: &DatabaseTransaction,
    node: &nodes::Model,
) -> Result<(), DbErr> {
    // Edges, their input snapshots and the node's own inputs cascade in v1;
    // the RTree and FTS triggers drop their rows with the node.
    nodes::Entity::delete_by_id(node.seq).exec(txn)?;
    Ok(())
}

pub(in crate::mutation) fn update_position_tx(
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

    Ok(node_row(&updated))
}

/// Writes every moved card's new geometry with one UPDATE each (no SeaORM
/// re-SELECT), one node RTree rewrite, and one batched edge-index sync.
pub(in crate::mutation) fn set_node_bounds_batched(
    txn: &DatabaseTransaction,
    bounds: &[NodeBounds],
) -> Result<BoundsBatch, DbErr> {
    let ids: Vec<String> = bounds.iter().map(|next| next.id.clone()).collect();
    let mut nodes_by_id: HashMap<String, nodes::Model> = HashMap::new();
    for chunk in ids.chunks(400) {
        let rows = nodes::Entity::find()
            .filter(nodes::Column::Id.is_in(chunk.to_vec()))
            .all(txn)?;
        for row in rows {
            nodes_by_id.insert(row.id.clone(), row);
        }
    }
    for id in &ids {
        if !nodes_by_id.contains_key(id) {
            return Err(DbErr::RecordNotFound(format!("node {id} was not found")));
        }
    }

    let mut changed = Vec::with_capacity(bounds.len());
    let mut pairs = Vec::with_capacity(bounds.len());

    for next in bounds {
        let before = nodes_by_id
            .get(&next.id)
            .cloned()
            .ok_or_else(|| DbErr::RecordNotFound(format!("node {} was not found", next.id)))?;
        if before.x == next.x
            && before.y == next.y
            && before.width == next.width
            && before.height == next.height
        {
            continue;
        }
        let now = now_ms();
        let new_rev = before.rev + 1;

        // `update_many` emits one UPDATE. `update(ActiveModel)` would follow
        // it with a SELECT of the updated row that this path does not need.
        nodes::Entity::update_many()
            .col_expr(nodes::Column::X, Expr::value(next.x))
            .col_expr(nodes::Column::Y, Expr::value(next.y))
            .col_expr(nodes::Column::Width, Expr::value(next.width))
            .col_expr(nodes::Column::Height, Expr::value(next.height))
            .col_expr(nodes::Column::Rev, Expr::value(new_rev))
            .col_expr(nodes::Column::UpdatedAt, Expr::value(now))
            .filter(nodes::Column::Seq.eq(before.seq))
            .exec(txn)?;

        // Every field other than the four geometry fields is copied from the
        // row that was just read, so the change set matches the old
        // re-SELECT path without paying for the read.
        let mut row = node_row(&before);
        let before_row = row.clone();
        row.x = next.x;
        row.y = next.y;
        row.width = next.width;
        row.height = next.height;
        row.rev = new_rev;
        row.updated_at = now;
        changed.push(row);
        pairs.push((
            before_row,
            NodeBounds {
                id: next.id.clone(),
                x: next.x,
                y: next.y,
                width: next.width,
                height: next.height,
            },
        ));

        // The port layout is proportional to the card's height, so a resize
        // scales every touching edge's stored offsets by the same ratio. The
        // edge row is the fallback anchor when its card is outside a viewport
        // read, and the connector RTree is rebuilt from the dirty marker once
        // the command applies.
        scale_edge_offsets_tx(txn, &next.id, before.height, next.height)?;
    }

    Ok((changed, pairs))
}

pub(in crate::mutation) fn update_text_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    title: &str,
    tags: &[String],
) -> Result<NodeRow, DbErr> {
    // Body is output-derived: a title/tags edit never restores or rewrites it.
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        title: Set(title.to_owned()),
        tags: Set(canonical_tags(tags)),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    Ok(node_row(&updated))
}

/// Applies kind settings while leaving the body, output and run status to
/// the commands that own them. An existing result no longer matches the new
/// settings, so it becomes stale instead of claiming to be current.
pub(in crate::mutation) fn apply_settings_tx(
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

/// Restores a history entry's settings. Unlike the user command, it never
/// changes the run-owned status: a coordinated upload undo restores the
/// output first and then the settings, and the status must stay as restored.
pub(in crate::mutation) fn restore_settings_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    settings_json: String,
) -> Result<NodeRow, DbErr> {
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        settings_json: Set(settings_json),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;
    Ok(node_row(&updated))
}

pub(in crate::mutation) fn find_node_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<nodes::Model, DbErr> {
    find_node_opt_tx(txn, id)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("node {id} was not found")))
}

pub(in crate::mutation) fn find_node_opt_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<Option<nodes::Model>, DbErr> {
    nodes::Entity::find()
        .filter(nodes::Column::Id.eq(id))
        .one(txn)
}

pub(in crate::mutation) fn find_node_by_seq_opt_tx(
    txn: &DatabaseTransaction,
    seq: i64,
) -> Result<Option<nodes::Model>, DbErr> {
    nodes::Entity::find_by_id(seq).one(txn)
}

/// Records an input-list change on a node. The node is always returned so
/// clients (the composer in particular) refresh even before the node has an
/// output; an existing result becomes stale because it no longer matches
/// its inputs.
pub(in crate::mutation) fn touch_node_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<nodes::Model, DbErr> {
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

pub(in crate::mutation) fn mark_stale_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<Option<nodes::Model>, DbErr> {
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
