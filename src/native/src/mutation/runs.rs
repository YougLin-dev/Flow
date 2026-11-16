//! Run commands: begin, settle, save, status and crash recovery.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::{Set, Unchanged},
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
};

use super::support::node_row;
use super::tx::finish_tx;
use super::tx::nodes::{find_node_opt_tx, find_node_tx};
use super::tx::runs::{
    apply_batch_result_tx, cancel_orphan_settle, empty_settle, insert_result_item_tx,
    insert_running_batch_tx, set_node_status_tx, settle_batch_tx,
};
use crate::clock::now_ms;
use crate::entity::{nodes as node_rows, result_batches};
use crate::history::HistoryRefs;
use crate::types::{ChangeSet, ResultBatchInput, ResultItemInput};

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
        let updated = node_rows::Entity::update(node_rows::ActiveModel {
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
        let running_nodes = node_rows::Entity::find()
            .filter(node_rows::Column::Status.eq("running"))
            .all(txn)?;
        let running_batches = result_batches::Entity::find()
            .filter(result_batches::Column::Status.eq("running"))
            .all(txn)?;
        for node in &running_nodes {
            node_rows::Entity::update(node_rows::ActiveModel {
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
