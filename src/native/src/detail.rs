//! Reads the composer and card views: one node with its output batch and
//! inputs, and the first items of several nodes' batches for card previews.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::{
    Alias, Expr, ExprTrait, Func, Order, Query, SelectStatement, WindowStatement,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::constants::DOCUMENT_ID;
use crate::entity::{assets, edges, node_inputs, nodes, result_batches, result_items};
use crate::types::{
    AssetSummary, InputItemSummary, NodeDetail, NodePreview, NodeSummary, PortIncoming,
    ResultBatchSummary, ResultItemSummary,
};

const CHUNK: usize = 400;
const PREVIEW_ITEMS: usize = 4;

/// The narrow node projection previews need: the stable id and its batch.
#[derive(FromQueryResult)]
struct PreviewNodeRow {
    id: String,
    output_batch_id: Option<String>,
}

/// One batch's full item count, independent of its bounded preview rows.
#[derive(FromQueryResult)]
struct PreviewCountRow {
    batch_id: String,
    item_count: i64,
}

pub fn node_detail(conn: &DatabaseConnection, id: &str) -> Result<Option<NodeDetail>, String> {
    let Some(node) = find_node(conn, id)? else {
        return Ok(None);
    };
    let batch = match &node.output_batch_id {
        Some(batch_id) => read_batch(conn, batch_id)?,
        None => None,
    };
    let latest_batch = read_latest_batch(conn, id, batch.as_ref())?;
    let inputs = read_inputs(conn, id)?;
    let incoming = read_incoming(conn, id)?;
    Ok(Some(NodeDetail {
        node: node_summary(&node),
        batch,
        latest_batch,
        inputs,
        incoming,
    }))
}

/// The connector count of every input port with at least one edge. Capacity
/// is edge-based, so this stays right when a source has produced no items.
fn read_incoming(conn: &DatabaseConnection, node_id: &str) -> Result<Vec<PortIncoming>, String> {
    let rows = edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(edges::Column::ToId.eq(node_id))
        .all(conn)
        .map_err(|error| error.to_string())?;
    let mut counts: BTreeMap<String, f64> = BTreeMap::new();
    for edge in rows {
        *counts.entry(edge.to_port).or_insert(0.0) += 1.0;
    }
    Ok(counts
        .into_iter()
        .map(|(port_id, edges)| PortIncoming { port_id, edges })
        .collect())
}

pub fn inputs(conn: &DatabaseConnection, node_id: &str) -> Result<Vec<InputItemSummary>, String> {
    read_inputs(conn, node_id)
}

pub fn previews(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Vec<NodePreview>, String> {
    let mut found = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        // The projection stops at the two fields previews use, instead of
        // deserializing a whole node row for every card.
        let nodes = nodes::Entity::find()
            .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
            .filter(nodes::Column::Id.is_in(chunk.to_vec()))
            .select_only()
            .columns([nodes::Column::Id, nodes::Column::OutputBatchId])
            .into_model::<PreviewNodeRow>()
            .all(conn)
            .map_err(|error| error.to_string())?;
        let mut batch_ids = Vec::new();
        let mut batch_by_node = BTreeMap::new();
        for node in &nodes {
            if let Some(batch_id) = &node.output_batch_id {
                batch_ids.push(batch_id.clone());
                batch_by_node.insert(batch_id.clone(), node.id.clone());
            }
        }
        if batch_ids.is_empty() {
            continue;
        }

        // One capped item read and one grouped count for the whole chunk; the
        // total count still includes items beyond the four preview rows.
        let mut items_by_batch: BTreeMap<String, Vec<result_items::Model>> = BTreeMap::new();
        for item in read_preview_items(conn, &batch_ids)? {
            items_by_batch
                .entry(item.batch_id.clone())
                .or_default()
                .push(item);
        }
        let counts = read_preview_counts(conn, &batch_ids)?;
        let mut asset_ids = BTreeSet::new();
        for item in items_by_batch.values().flatten() {
            if let Some(asset_id) = &item.asset_id {
                asset_ids.insert(asset_id.clone());
            }
        }
        let assets = assets_by_id(conn, &asset_ids.into_iter().collect::<Vec<_>>())?;

        for (batch_id, node_id) in batch_by_node {
            let items = items_by_batch.remove(&batch_id).unwrap_or_default();
            let item_count = counts.get(&batch_id).copied().unwrap_or(0) as f64;
            let preview_items = items
                .iter()
                .take(PREVIEW_ITEMS)
                .map(|item| item_summary(item, &assets))
                .collect();
            found.push(NodePreview {
                node_id,
                item_count,
                items: preview_items,
            });
        }
    }
    Ok(found)
}

/// The capped item read: one window partitions the chunk's rows by batch and
/// ranks them in position/id order, and the outer query keeps four per batch.
fn preview_items_query(batch_ids: &[String]) -> SelectStatement {
    let mut inner = Query::select();
    inner
        .columns([
            result_items::Column::Id,
            result_items::Column::BatchId,
            result_items::Column::Position,
            result_items::Column::PortId,
            result_items::Column::Kind,
            result_items::Column::Text,
            result_items::Column::AssetId,
            result_items::Column::MetaJson,
        ])
        .from(result_items::Entity)
        .and_where(result_items::Column::BatchId.is_in(batch_ids.to_vec()));

    let mut window = WindowStatement::partition_by(result_items::Column::BatchId);
    window.order_by(result_items::Column::Position, Order::Asc);
    window.order_by(result_items::Column::Id, Order::Asc);
    inner.expr_window_as(
        Expr::cust("ROW_NUMBER()"),
        window,
        Alias::new("preview_row_number"),
    );

    let mut outer = Query::select();
    outer
        .columns([
            Alias::new("id"),
            Alias::new("batch_id"),
            Alias::new("position"),
            Alias::new("port_id"),
            Alias::new("kind"),
            Alias::new("text"),
            Alias::new("asset_id"),
            Alias::new("meta_json"),
        ])
        .from_subquery(inner, Alias::new("preview_items"))
        .and_where(Expr::col(Alias::new("preview_row_number")).lte(PREVIEW_ITEMS as i64))
        .order_by(Alias::new("batch_id"), Order::Asc)
        .order_by(Alias::new("position"), Order::Asc)
        .order_by(Alias::new("id"), Order::Asc);
    outer
}

fn read_preview_items(
    conn: &DatabaseConnection,
    batch_ids: &[String],
) -> Result<Vec<result_items::Model>, String> {
    let mut items = Vec::new();
    for chunk in batch_ids.chunks(CHUNK) {
        let statement = preview_items_query(chunk);
        let rows = conn
            .query_all(&statement)
            .map_err(|error| error.to_string())?;
        for row in &rows {
            items.push(
                result_items::Model::from_query_result(row, "")
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    Ok(items)
}

/// The exact count of every requested batch, including the items the preview
/// query deliberately leaves out.
fn read_preview_counts(
    conn: &DatabaseConnection,
    batch_ids: &[String],
) -> Result<BTreeMap<String, usize>, String> {
    let mut counts = BTreeMap::new();
    for chunk in batch_ids.chunks(CHUNK) {
        let rows = result_items::Entity::find()
            .filter(result_items::Column::BatchId.is_in(chunk.to_vec()))
            .select_only()
            .column(result_items::Column::BatchId)
            .expr_as(
                Func::count(Expr::col(result_items::Column::Id)),
                "item_count",
            )
            .group_by(result_items::Column::BatchId)
            .into_model::<PreviewCountRow>()
            .all(conn)
            .map_err(|error| error.to_string())?;
        for row in rows {
            counts.insert(row.batch_id, std::cmp::Ord::max(row.item_count, 0) as usize);
        }
    }
    Ok(counts)
}

#[cfg(test)]
pub(crate) fn preview_items_statement(batch_ids: &[String]) -> SelectStatement {
    preview_items_query(batch_ids)
}

fn find_node(conn: &DatabaseConnection, id: &str) -> Result<Option<nodes::Model>, String> {
    nodes::Entity::find()
        .filter(nodes::Column::Id.eq(id))
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .one(conn)
        .map_err(|error| error.to_string())
}

fn read_batch(
    conn: &DatabaseConnection,
    batch_id: &str,
) -> Result<Option<ResultBatchSummary>, String> {
    let Some(batch) = result_batches::Entity::find_by_id(batch_id.to_owned())
        .one(conn)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let items = result_items::Entity::find()
        .filter(result_items::Column::BatchId.eq(batch_id))
        .order_by_asc(result_items::Column::Position)
        .order_by_asc(result_items::Column::Id)
        .all(conn)
        .map_err(|error| error.to_string())?;
    let asset_map = asset_map(conn, &items)?;

    Ok(Some(ResultBatchSummary {
        id: batch.id,
        node_id: batch.node_id,
        trigger: batch.trigger,
        provider: batch.provider,
        model: batch.model,
        params_json: batch.params_json,
        status: batch.status,
        error: batch.error,
        created_at: batch.created_at as f64,
        items: items
            .iter()
            .map(|item| item_summary(item, &asset_map))
            .collect(),
    }))
}

fn read_inputs(conn: &DatabaseConnection, node_id: &str) -> Result<Vec<InputItemSummary>, String> {
    let rows = node_inputs::Entity::find()
        .filter(node_inputs::Column::NodeId.eq(node_id))
        .order_by_asc(node_inputs::Column::Position)
        .order_by_asc(node_inputs::Column::Id)
        .all(conn)
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let item_ids: Vec<String> = rows.iter().filter_map(|row| row.item_id.clone()).collect();
    let mut item_by_id = BTreeMap::new();
    let mut item_rows = Vec::new();
    for chunk in item_ids.chunks(CHUNK) {
        let items = result_items::Entity::find()
            .filter(result_items::Column::Id.is_in(chunk.to_vec()))
            .all(conn)
            .map_err(|error| error.to_string())?;
        item_rows.extend(items);
    }
    let asset_map = asset_map(conn, &item_rows)?;
    for item in &item_rows {
        item_by_id.insert(item.id.clone(), item_summary(item, &asset_map));
    }

    let mut local_asset_ids = Vec::new();
    for row in &rows {
        if let Some(asset_id) = &row.asset_id {
            local_asset_ids.push(asset_id.clone());
        }
    }
    let local_assets = assets_by_id(conn, &local_asset_ids)?;
    let sources = input_sources(conn, &rows)?;

    Ok(rows
        .iter()
        .map(|row| {
            let source = row.edge_id.as_ref().and_then(|id| sources.get(id));
            InputItemSummary {
                id: row.id.clone(),
                node_id: row.node_id.clone(),
                position: row.position as f64,
                port_id: row.port_id.clone(),
                kind: row.kind.clone(),
                origin: row.origin.clone(),
                edge_id: row.edge_id.clone(),
                item_id: row.item_id.clone(),
                asset_id: row.asset_id.clone(),
                text: row.text.clone(),
                meta_json: row.meta_json.clone(),
                source_node_id: source.map(|(id, _)| id.clone()),
                source_title: source.map(|(_, title)| title.clone()),
                item: row
                    .item_id
                    .as_ref()
                    .and_then(|id| item_by_id.get(id))
                    .cloned(),
                asset: row
                    .asset_id
                    .as_ref()
                    .and_then(|id| local_assets.get(id))
                    .cloned(),
            }
        })
        .collect())
}

fn read_latest_batch(
    conn: &DatabaseConnection,
    node_id: &str,
    output: Option<&ResultBatchSummary>,
) -> Result<Option<ResultBatchSummary>, String> {
    let Some(batch) = result_batches::Entity::find()
        .filter(result_batches::Column::NodeId.eq(node_id))
        .order_by_desc(result_batches::Column::CreatedAt)
        .order_by_desc(result_batches::Column::Id)
        .one(conn)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    if let Some(output) = output
        && output.id == batch.id
    {
        return Ok(Some(output.clone()));
    }
    read_batch(conn, &batch.id)
}

/// The source node (id, title) of every edge that contributed an input.
fn input_sources(
    conn: &DatabaseConnection,
    rows: &[node_inputs::Model],
) -> Result<BTreeMap<String, (String, String)>, String> {
    let edge_ids: Vec<String> = rows.iter().filter_map(|row| row.edge_id.clone()).collect();
    let mut from_by_edge = BTreeMap::new();
    for chunk in edge_ids.chunks(CHUNK) {
        let edges = edges::Entity::find()
            .filter(edges::Column::Id.is_in(chunk.to_vec()))
            .all(conn)
            .map_err(|error| error.to_string())?;
        for edge in edges {
            from_by_edge.insert(edge.id, edge.from_id);
        }
    }
    let from_ids: Vec<String> = from_by_edge.values().cloned().collect();
    let mut title_by_id = BTreeMap::new();
    for chunk in from_ids.chunks(CHUNK) {
        let nodes = nodes::Entity::find()
            .filter(nodes::Column::Id.is_in(chunk.to_vec()))
            .all(conn)
            .map_err(|error| error.to_string())?;
        for node in nodes {
            title_by_id.insert(node.id, node.title);
        }
    }
    Ok(from_by_edge
        .into_iter()
        .filter_map(|(edge_id, node_id)| {
            let title = title_by_id.get(&node_id)?;
            Some((edge_id, (node_id, title.clone())))
        })
        .collect())
}

/// The unbounded chunked item read, kept only for the reference reader.
#[cfg(test)]
fn read_items_for_batches(
    conn: &DatabaseConnection,
    batch_ids: &[String],
) -> Result<Vec<(String, Vec<result_items::Model>)>, String> {
    let mut grouped: BTreeMap<String, Vec<result_items::Model>> = BTreeMap::new();
    for chunk in batch_ids.chunks(CHUNK) {
        let items = result_items::Entity::find()
            .filter(result_items::Column::BatchId.is_in(chunk.to_vec()))
            .order_by_asc(result_items::Column::Position)
            .order_by_asc(result_items::Column::Id)
            .all(conn)
            .map_err(|error| error.to_string())?;
        for item in items {
            grouped.entry(item.batch_id.clone()).or_default().push(item);
        }
    }
    Ok(grouped.into_iter().collect())
}

/// The pre-bounded preview reader, kept only as the comparison oracle for the
/// capped query's tests and its ignored benchmark. It loads every item and
/// builds one asset map per node.
#[cfg(test)]
pub(crate) fn previews_reference(
    conn: &DatabaseConnection,
    ids: Vec<String>,
) -> Result<Vec<NodePreview>, String> {
    let mut found = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        let nodes = nodes::Entity::find()
            .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
            .filter(nodes::Column::Id.is_in(chunk.to_vec()))
            .all(conn)
            .map_err(|error| error.to_string())?;
        let mut batch_ids = Vec::new();
        let mut batch_by_node = BTreeMap::new();
        for node in &nodes {
            if let Some(batch_id) = &node.output_batch_id {
                batch_ids.push(batch_id.clone());
                batch_by_node.insert(batch_id.clone(), node.id.clone());
            }
        }
        if batch_ids.is_empty() {
            continue;
        }

        let mut items_by_batch: BTreeMap<String, Vec<result_items::Model>> = BTreeMap::new();
        for (batch_id, items) in read_items_for_batches(conn, &batch_ids)? {
            items_by_batch.insert(batch_id, items);
        }
        for (batch_id, node_id) in batch_by_node {
            let items = items_by_batch.remove(&batch_id).unwrap_or_default();
            let asset_map = asset_map(conn, &items)?;
            let preview_items = items
                .iter()
                .take(PREVIEW_ITEMS)
                .map(|item| item_summary(item, &asset_map))
                .collect();
            found.push(NodePreview {
                node_id,
                item_count: items.len() as f64,
                items: preview_items,
            });
        }
    }
    Ok(found)
}

fn asset_map(
    conn: &DatabaseConnection,
    items: &[result_items::Model],
) -> Result<BTreeMap<String, AssetSummary>, String> {
    let mut ids = BTreeSet::new();
    for item in items {
        if let Some(asset_id) = &item.asset_id {
            ids.insert(asset_id.clone());
        }
    }
    assets_by_id(conn, &ids.into_iter().collect::<Vec<_>>())
}

fn assets_by_id(
    conn: &DatabaseConnection,
    ids: &[String],
) -> Result<BTreeMap<String, AssetSummary>, String> {
    let mut found = BTreeMap::new();
    for chunk in ids.chunks(CHUNK) {
        let rows = assets::Entity::find()
            .filter(assets::Column::Id.is_in(chunk.to_vec()))
            .all(conn)
            .map_err(|error| error.to_string())?;
        for row in rows {
            found.insert(row.id.clone(), asset_summary(&row));
        }
    }
    Ok(found)
}

fn item_summary(
    item: &result_items::Model,
    assets: &BTreeMap<String, AssetSummary>,
) -> ResultItemSummary {
    ResultItemSummary {
        id: item.id.clone(),
        batch_id: item.batch_id.clone(),
        position: item.position as f64,
        port_id: item.port_id.clone(),
        kind: item.kind.clone(),
        text: item.text.clone(),
        asset_id: item.asset_id.clone(),
        meta_json: item.meta_json.clone(),
        asset: item
            .asset_id
            .as_ref()
            .and_then(|id| assets.get(id))
            .cloned(),
    }
}

fn asset_summary(asset: &assets::Model) -> AssetSummary {
    AssetSummary {
        id: asset.id.clone(),
        hash: asset.hash.clone(),
        kind: asset.kind.clone(),
        name: asset.name.clone(),
        mime: asset.mime.clone(),
        size: asset.size as f64,
        meta_json: asset.meta_json.clone(),
        created_at: asset.created_at as f64,
    }
}

fn node_summary(node: &nodes::Model) -> NodeSummary {
    NodeSummary {
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        body: node.body.clone(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        z: node.z,
        rev: node.rev as f64,
        data_json: node.data_json.clone(),
        settings_json: node.settings_json.clone(),
        status: node.status.clone(),
        output_batch_id: node.output_batch_id.clone(),
    }
}
