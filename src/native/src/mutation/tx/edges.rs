//! Edge transactions and port reconciliation.

use std::collections::BTreeSet;

use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveValue::{NotSet, Set, Unchanged},
    ColumnTrait, Condition, DatabaseTransaction, DbErr, EntityTrait, QueryFilter,
};

use crate::clock::now_ms;
use crate::entity::{edges, nodes};
use crate::history::{EdgeRow, HistoryOp, InputRow};
use crate::types::{EdgeInput, EdgePoint, EdgeSummary};

use crate::mutation::support::edge_row;
use crate::mutation::tx::inputs::{
    delete_input_tx, inputs_for_edge_tx, insert_input_row_tx, max_input_position_tx,
};
use crate::mutation::tx::nodes::{find_node_tx, touch_node_tx};
use crate::mutation::tx::runs::items_for_batch_tx;

pub(in crate::mutation) struct ConnectedEdge {
    pub(in crate::mutation) edge: EdgeRow,
    pub(in crate::mutation) source: nodes::Model,
    pub(in crate::mutation) target: nodes::Model,
    pub(in crate::mutation) forward: Vec<HistoryOp>,
    pub(in crate::mutation) inverse: Vec<HistoryOp>,
}

/// The change set's edge summary, with both ports for a scene that holds
/// only one of the edge's cards.
pub(in crate::mutation) fn edge_summary(
    edge: &EdgeRow,
    from: &nodes::Model,
    to: &nodes::Model,
) -> EdgeSummary {
    EdgeSummary {
        from_point: Some(EdgePoint::output(
            from.x,
            from.y,
            from.width,
            edge.from_offset,
        )),
        to_point: Some(EdgePoint::input(to.x, to.y, edge.to_offset)),
        ..edge.summary()
    }
}

/// One edge inside an open transaction: validation, the edge row, the
/// source's snapshotted inputs, the target touch and their history ops.
pub(in crate::mutation) fn connect_edge_tx(
    txn: &DatabaseTransaction,
    input: &EdgeInput,
) -> Result<ConnectedEdge, DbErr> {
    if input.from_id == input.to_id {
        return Err(DbErr::Custom("a node cannot connect to itself".to_owned()));
    }
    let source = find_node_tx(txn, &input.from_id)?;
    find_node_tx(txn, &input.to_id)?;
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

    let edge = insert_edge_tx(txn, input)?;
    let mut forward = vec![HistoryOp::InsertEdge(edge.clone())];
    let mut desired_inverse = Vec::new();
    let mut position = max_input_position_tx(txn, &input.to_id, &input.to_port)?;

    if let Some(batch_id) = &source.output_batch_id {
        for item in items_for_batch_tx(txn, batch_id)? {
            if item.port_id != input.from_port {
                continue;
            }
            let row = InputRow {
                id: format!("input-{}-{}", edge.id, item.id),
                node_id: input.to_id.clone(),
                position,
                port_id: input.to_port.clone(),
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

pub(in crate::mutation) fn insert_edge_tx(
    txn: &DatabaseTransaction,
    input: &EdgeInput,
) -> Result<EdgeRow, DbErr> {
    let data_json = input.data_json.clone().unwrap_or_else(|| "{}".to_owned());
    let inserted = edges::Entity::insert(edges::ActiveModel {
        seq: NotSet,
        id: Set(input.id.clone()),
        from_id: Set(input.from_id.clone()),
        to_id: Set(input.to_id.clone()),
        from_port: Set(input.from_port.clone()),
        to_port: Set(input.to_port.clone()),
        port_kind: Set(input.port_kind.clone()),
        from_offset: Set(input.from_offset),
        to_offset: Set(input.to_offset),
        kind: Set(input.kind.clone()),
        data_json: Set(data_json.clone()),
    })
    .exec(txn)?;

    Ok(EdgeRow {
        seq: inserted.last_insert_id,
        id: input.id.clone(),
        from_id: input.from_id.clone(),
        to_id: input.to_id.clone(),
        from_port: input.from_port.clone(),
        to_port: input.to_port.clone(),
        port_kind: input.port_kind.clone(),
        from_offset: input.from_offset,
        to_offset: input.to_offset,
        kind: input.kind.clone(),
        data_json,
    })
}

pub(in crate::mutation) fn insert_edge_row_tx(
    txn: &DatabaseTransaction,
    row: &EdgeRow,
) -> Result<(), DbErr> {
    edges::Entity::insert(edges::ActiveModel {
        seq: Set(row.seq),
        id: Set(row.id.clone()),
        from_id: Set(row.from_id.clone()),
        to_id: Set(row.to_id.clone()),
        from_port: Set(row.from_port.clone()),
        to_port: Set(row.to_port.clone()),
        port_kind: Set(row.port_kind.clone()),
        from_offset: Set(row.from_offset),
        to_offset: Set(row.to_offset),
        kind: Set(row.kind.clone()),
        data_json: Set(row.data_json.clone()),
    })
    .exec(txn)?;
    Ok(())
}

pub(in crate::mutation) fn replace_edge_row_tx(
    txn: &DatabaseTransaction,
    row: &EdgeRow,
) -> Result<EdgeRow, DbErr> {
    edges::Entity::update(edges::ActiveModel {
        seq: Unchanged(row.seq),
        from_id: Set(row.from_id.clone()),
        to_id: Set(row.to_id.clone()),
        from_port: Set(row.from_port.clone()),
        to_port: Set(row.to_port.clone()),
        port_kind: Set(row.port_kind.clone()),
        from_offset: Set(row.from_offset),
        to_offset: Set(row.to_offset),
        kind: Set(row.kind.clone()),
        data_json: Set(row.data_json.clone()),
        ..Default::default()
    })
    .exec(txn)?;
    Ok(row.clone())
}

pub(in crate::mutation) fn delete_edge_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<(), DbErr> {
    edges::Entity::delete_many()
        .filter(edges::Column::Id.eq(id))
        .exec(txn)?;
    Ok(())
}

/// Whether another edge already joins this ordered pair. Parallel duplicate
/// edges would snapshot the same items twice, so M1 keeps one per direction.
pub(in crate::mutation) fn already_connected_tx(
    txn: &DatabaseTransaction,
    from_id: &str,
    from_port: &str,
    to_id: &str,
    to_port: &str,
    except_edge_id: &str,
) -> Result<bool, DbErr> {
    Ok(edges::Entity::find()
        .filter(edges::Column::FromId.eq(from_id))
        .filter(edges::Column::FromPort.eq(from_port))
        .filter(edges::Column::ToId.eq(to_id))
        .filter(edges::Column::ToPort.eq(to_port))
        .filter(edges::Column::Id.ne(except_edge_id))
        .one(txn)?
        .is_some())
}

pub(in crate::mutation) fn find_edge_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<edges::Model, DbErr> {
    find_edge_opt_tx(txn, id)?
        .ok_or_else(|| DbErr::RecordNotFound(format!("edge {id} was not found")))
}

pub(in crate::mutation) fn find_edge_opt_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<Option<edges::Model>, DbErr> {
    edges::Entity::find()
        .filter(edges::Column::Id.eq(id))
        .one(txn)
}

pub(in crate::mutation) fn find_edge_by_seq_opt_tx(
    txn: &DatabaseTransaction,
    seq: i64,
) -> Result<Option<edges::Model>, DbErr> {
    edges::Entity::find_by_id(seq).one(txn)
}

/// An edge removed because its port at the edited node is no longer declared
/// by the node's settings, together with the snapshots it contributed.
pub(in crate::mutation) struct RemovedEdge {
    pub(in crate::mutation) edge: EdgeRow,
    pub(in crate::mutation) inputs: Vec<InputRow>,
}

#[derive(Default)]
pub(in crate::mutation) struct PortReconciliation {
    pub(in crate::mutation) removed: Vec<RemovedEdge>,
    /// Downstream nodes whose input list lost an edge. The edited node itself
    /// is never included; the caller touches each survivor once.
    pub(in crate::mutation) survivors: BTreeSet<String>,
}

/// Deletes every incident edge whose port at `node_id` is absent from
/// `valid_ports`. The edge's input snapshots go in the same transaction.
pub(in crate::mutation) fn reconcile_ports_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    valid_ports: &BTreeSet<String>,
) -> Result<PortReconciliation, DbErr> {
    let mut edges = edges_for_node_tx(txn, node_id)?;
    edges.sort_by(|left, right| left.id.cmp(&right.id));

    let mut removed = Vec::new();
    let mut survivors = BTreeSet::new();
    for edge in edges {
        let lost_output = edge.from_id == node_id && !valid_ports.contains(&edge.from_port);
        let lost_input = edge.to_id == node_id && !valid_ports.contains(&edge.to_port);
        if !lost_output && !lost_input {
            continue;
        }
        let inputs = inputs_for_edge_tx(txn, &edge.id)?;
        for input in &inputs {
            delete_input_tx(txn, &input.id)?;
        }
        delete_edge_tx(txn, &edge.id)?;
        if edge.to_id != node_id {
            survivors.insert(edge.to_id.clone());
        }
        removed.push(RemovedEdge { edge, inputs });
    }
    Ok(PortReconciliation { removed, survivors })
}

pub(in crate::mutation) fn edges_for_node_tx(
    txn: &DatabaseTransaction,
    id: &str,
) -> Result<Vec<EdgeRow>, DbErr> {
    edges::Entity::find()
        .filter(
            Condition::any()
                .add(edges::Column::FromId.eq(id))
                .add(edges::Column::ToId.eq(id)),
        )
        .all(txn)
        .map(|rows| rows.iter().map(edge_row).collect())
}

/// A card's port layout is proportional to its height: a resize scales every
/// touching edge's stored offsets by the same ratio, so a connector's fallback
/// anchor (the edge row) stays on its port outside a viewport read.
pub(in crate::mutation) fn scale_edge_offsets_tx(
    txn: &DatabaseTransaction,
    node_id: &str,
    before_height: f64,
    after_height: f64,
) -> Result<(), DbErr> {
    if before_height <= 0.0 || (after_height - before_height).abs() <= f64::EPSILON {
        return Ok(());
    }
    let ratio = after_height / before_height;
    edges::Entity::update_many()
        .col_expr(
            edges::Column::FromOffset,
            Expr::col(edges::Column::FromOffset).mul(Expr::value(ratio)),
        )
        .filter(edges::Column::FromId.eq(node_id.to_owned()))
        .exec(txn)?;
    edges::Entity::update_many()
        .col_expr(
            edges::Column::ToOffset,
            Expr::col(edges::Column::ToOffset).mul(Expr::value(ratio)),
        )
        .filter(edges::Column::ToId.eq(node_id.to_owned()))
        .exec(txn)?;
    Ok(())
}
