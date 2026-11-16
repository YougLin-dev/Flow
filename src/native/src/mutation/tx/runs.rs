//! Run, batch and status transactions.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::{NotSet, Set, Unchanged},
    ColumnTrait, DatabaseTransaction, DbErr, EntityTrait, QueryFilter, QueryOrder,
};

use crate::clock::now_ms;
use crate::document;
use crate::entity::{edges, nodes, result_batches, result_items};
use crate::history::HistoryRefs;
use crate::types::{ChangeSet, NodeSummary, ResultBatchInput, ResultItemInput};

use crate::mutation::support::node_row;
use crate::mutation::tx::finish_tx;
use crate::mutation::tx::nodes::{find_node_tx, mark_stale_tx};

/// Applies a settled batch to its node: the run body and output pointer on a
/// successful run, downstream staleness, and the history references a later
/// write must invalidate. Shared by `settle_run` and `save_run`, so their
/// finalization cannot drift.
pub(in crate::mutation) fn apply_batch_result_tx(
    txn: &DatabaseTransaction,
    batch: &ResultBatchInput,
    items: &[ResultItemInput],
    node: &nodes::Model,
) -> Result<(Vec<NodeSummary>, HistoryRefs), DbErr> {
    let body = items
        .iter()
        .find(|item| item.kind == "text")
        .map(|item| item.text.clone())
        .unwrap_or_else(|| node.body.clone());
    let mut active = nodes::ActiveModel {
        seq: Unchanged(node.seq),
        status: Set(batch.status.clone()),
        rev: Set(node.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    };
    if batch.status == "done" {
        active.output_batch_id = Set(Some(batch.id.clone()));
        active.body = Set(body);
    }
    let updated = nodes::Entity::update(active).exec(txn)?;

    let mut refs = HistoryRefs::default();
    refs.node(node.id.clone());
    refs.batch(Some(&batch.id));
    for item in items {
        refs.asset(item.asset_id.as_deref());
    }

    let mut changed = vec![node_row(&updated).summary()];
    if batch.status == "done" {
        for row in mark_downstream_stale_tx(txn, &node.id)? {
            changed.push(node_row(&row).summary());
        }
        for target in downstream_output_targets_tx(txn, &node.id)? {
            refs.node(target);
        }
    }
    Ok((changed, refs))
}

/// Settles a running batch whose node no longer exists as cancelled instead
/// of writing unreachable results: the late settle is a no-op, but the batch
/// must not stay running forever.
pub(in crate::mutation) fn cancel_orphan_settle(
    txn: &DatabaseTransaction,
    running: &result_batches::Model,
    error: &str,
) -> Result<(ChangeSet, HistoryRefs), DbErr> {
    settle_batch_tx(txn, &running.id, "cancelled", Some(error))?;
    let mut refs = HistoryRefs::default();
    refs.batch(Some(&running.id));
    refs.node(running.node_id.clone());
    let rev = finish_tx(txn)?;
    Ok((ChangeSet::empty(rev as f64), refs))
}

pub(in crate::mutation) fn empty_settle(
    txn: &DatabaseTransaction,
) -> Result<(ChangeSet, HistoryRefs), DbErr> {
    Ok((
        ChangeSet::empty(document::current_rev(txn)? as f64),
        HistoryRefs::default(),
    ))
}

pub(in crate::mutation) fn items_for_batch_tx(
    txn: &DatabaseTransaction,
    batch_id: &str,
) -> Result<Vec<result_items::Model>, DbErr> {
    result_items::Entity::find()
        .filter(result_items::Column::BatchId.eq(batch_id))
        .order_by_asc(result_items::Column::PortId)
        .order_by_asc(result_items::Column::Position)
        .order_by_asc(result_items::Column::Id)
        .all(txn)
}

/// Inserts a batch in the running state the v1 triggers require, bound to the
/// node's current incarnation (`node_seq`). Items may be added only now.
pub(in crate::mutation) fn insert_running_batch_tx(
    txn: &DatabaseTransaction,
    batch: &ResultBatchInput,
) -> Result<i64, DbErr> {
    let node = find_node_tx(txn, &batch.node_id)?;
    let inserted = result_batches::Entity::insert(result_batches::ActiveModel {
        seq: NotSet,
        id: Set(batch.id.clone()),
        node_id: Set(node.id),
        node_seq: Set(node.seq),
        trigger: Set(batch.trigger.clone()),
        provider: Set(batch.provider.clone()),
        model: Set(batch.model.clone()),
        params_json: Set(batch.params_json.clone()),
        status: Set("running".to_owned()),
        error: Set(None),
        item_count: Set(0),
        created_at: Set(now_ms()),
        finished_at: Set(None),
    })
    .exec(txn)?;
    Ok(inserted.last_insert_id)
}

/// Settles a running batch. The v1 triggers require a non-running status to
/// carry `finished_at`; a `done` batch must already hold at least one item.
/// Settling a batch that is no longer running is a no-op.
pub(in crate::mutation) fn settle_batch_tx(
    txn: &DatabaseTransaction,
    batch_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbErr> {
    if status == "running" {
        return Ok(());
    }
    result_batches::Entity::update_many()
        .col_expr(
            result_batches::Column::Status,
            Expr::value(status.to_owned()),
        )
        .col_expr(
            result_batches::Column::Error,
            Expr::value(error.map(str::to_owned)),
        )
        .col_expr(result_batches::Column::FinishedAt, Expr::value(now_ms()))
        .filter(result_batches::Column::Id.eq(batch_id))
        .filter(result_batches::Column::Status.eq("running"))
        .exec(txn)?;
    Ok(())
}

/// Settles every running batch of `node_id` as cancelled and returns their
/// ids. Called before a node delete so no run outlives its node.
pub(in crate::mutation) fn cancel_running_batches_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
) -> Result<Vec<String>, DbErr> {
    let running = result_batches::Entity::find()
        .filter(result_batches::Column::NodeId.eq(node_id))
        .filter(result_batches::Column::Status.eq("running"))
        .all(txn)?;
    for batch in &running {
        settle_batch_tx(txn, &batch.id, "cancelled", Some("the node was deleted"))?;
    }
    Ok(running.into_iter().map(|batch| batch.id).collect())
}

/// Updates a node's status without touching its results.
pub(in crate::mutation) fn set_node_status_tx(
    txn: &DatabaseTransaction,
    node: &nodes::Model,
    status: &str,
) -> Result<nodes::Model, DbErr> {
    nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(node.seq),
        status: Set(status.to_owned()),
        rev: Set(node.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)
}

pub(in crate::mutation) fn insert_result_item_tx(
    txn: &DatabaseTransaction,
    batch_id: &str,
    item: &ResultItemInput,
) -> Result<(), DbErr> {
    result_items::Entity::insert(result_items::ActiveModel {
        id: Set(item.id.clone()),
        batch_id: Set(batch_id.to_owned()),
        position: Set(item.position.max(0.0) as i64),
        port_id: Set(item.port_id.clone()),
        kind: Set(item.kind.clone()),
        text: Set(item.text.clone()),
        asset_id: Set(item.asset_id.clone()),
        meta_json: Set(item.meta_json.clone().unwrap_or_else(|| "{}".to_owned())),
    })
    .exec(txn)?;
    Ok(())
}

pub(in crate::mutation) fn downstream_output_targets_tx(
    txn: &DatabaseTransaction,
    source_id: &str,
) -> Result<Vec<String>, DbErr> {
    let edges = edges::Entity::find()
        .filter(edges::Column::FromId.eq(source_id))
        .all(txn)?;
    let ids: Vec<String> = edges.into_iter().map(|edge| edge.to_id).collect();
    let mut targets = Vec::new();
    for chunk in ids.chunks(400) {
        let rows = nodes::Entity::find()
            .filter(nodes::Column::Id.is_in(chunk.to_vec()))
            .filter(nodes::Column::OutputBatchId.is_not_null())
            .all(txn)?;
        targets.extend(rows.into_iter().map(|row| row.id));
    }
    targets.sort();
    targets.dedup();
    Ok(targets)
}

pub(in crate::mutation) fn mark_downstream_stale_tx(
    txn: &DatabaseTransaction,
    source_id: &str,
) -> Result<Vec<nodes::Model>, DbErr> {
    let edges = edges::Entity::find()
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
