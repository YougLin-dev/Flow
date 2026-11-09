//! Reads the composer and card views: one node with its output batch and
//! inputs, and the first items of several nodes' batches for card previews.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};

use crate::constants::DOCUMENT_ID;
use crate::entity::{assets, edges, node_inputs, nodes, result_batches, result_items};
use crate::types::{
    AssetSummary, InputItemSummary, NodeDetail, NodePreview, NodeSummary, ResultBatchSummary,
    ResultItemSummary,
};

const CHUNK: usize = 400;
const PREVIEW_ITEMS: usize = 4;

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
    Ok(Some(NodeDetail {
        node: node_summary(&node),
        batch,
        latest_batch,
        inputs,
    }))
}

pub fn inputs(conn: &DatabaseConnection, node_id: &str) -> Result<Vec<InputItemSummary>, String> {
    read_inputs(conn, node_id)
}

pub fn previews(conn: &DatabaseConnection, ids: Vec<String>) -> Result<Vec<NodePreview>, String> {
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
