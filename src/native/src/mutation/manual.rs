//! Manual edits: text and uploads, plus upload-backed node insertion.

use std::collections::BTreeSet;

use sea_orm::{
    ActiveValue::{Set, Unchanged},
    DatabaseConnection, DbErr, EntityTrait,
};

use super::Mutation;
use super::support::node_row;
use super::tx::edges::{reconcile_ports_tx, scale_edge_offsets_tx};
use super::tx::finish_tx;
use super::tx::nodes::{find_node_tx, insert_node_tx, touch_node_tx};
use super::tx::runs::{
    insert_result_item_tx, insert_running_batch_tx, mark_downstream_stale_tx, settle_batch_tx,
};
use crate::clock::now_ms;
use crate::entity::nodes as node_rows;
use crate::history::{HistoryOp, HistoryRefs};
use crate::types::{ChangeSet, NodeBounds, NodeInput, ResultBatchInput, ResultItemInput};

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

        let updated = node_rows::Entity::update(node_rows::ActiveModel {
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

        let mut node = node_rows::ActiveModel {
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
        let updated = node_rows::Entity::update(node).exec(txn)?;
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
        let updated = node_rows::Entity::update(node_rows::ActiveModel {
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
