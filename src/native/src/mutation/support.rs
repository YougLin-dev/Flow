//! Row conversions and tag helpers.

use crate::clock::now_ms;
use crate::entity::{edges, node_inputs, nodes, result_items};
use crate::history::{EdgeRow, InputRow, NodeRow};

/// The snapshot row an edge contributes for one batch item. The caller owns
/// the position; the id scheme is shared by connect and input sync.
pub(in crate::mutation) fn edge_input_row(
    edge_id: &str,
    node_id: &str,
    port_id: &str,
    position: i32,
    item: &result_items::Model,
) -> InputRow {
    InputRow {
        id: format!("input-{edge_id}-{}", item.id),
        node_id: node_id.to_owned(),
        position,
        port_id: port_id.to_owned(),
        kind: item.kind.clone(),
        origin: "edge".to_owned(),
        edge_id: Some(edge_id.to_owned()),
        item_id: Some(item.id.clone()),
        asset_id: item.asset_id.clone(),
        text: item.text.clone(),
        meta_json: item.meta_json.clone(),
        created_at: now_ms(),
    }
}

/// The canonical `nodes.tags` form: one trimmed, non-empty tag per line. The
/// v1 CHECK forbids leading, trailing and doubled newlines, so a tag that
/// itself contains a newline is split into separate tags.
pub(in crate::mutation) fn canonical_tags(tags: &[String]) -> String {
    tags.iter()
        .flat_map(|tag| tag.split('\n'))
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(in crate::mutation) fn tags_from(text: &str) -> Vec<String> {
    text.split('\n')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(in crate::mutation) fn node_row(node: &nodes::Model) -> NodeRow {
    NodeRow {
        seq: node.seq,
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        body: node.body.clone(),
        tags: tags_from(&node.tags),
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

pub(in crate::mutation) fn edge_row(edge: &edges::Model) -> EdgeRow {
    EdgeRow {
        seq: edge.seq,
        id: edge.id.clone(),
        from_id: edge.from_id.clone(),
        to_id: edge.to_id.clone(),
        from_port: edge.from_port.clone(),
        to_port: edge.to_port.clone(),
        port_kind: edge.port_kind.clone(),
        from_offset: edge.from_offset,
        to_offset: edge.to_offset,
        kind: edge.kind.clone(),
        data_json: edge.data_json.clone(),
    }
}

pub(in crate::mutation) fn input_row(row: &node_inputs::Model) -> InputRow {
    InputRow {
        id: row.id.clone(),
        node_id: row.node_id.clone(),
        position: row.position as i32,
        port_id: row.port_id.clone(),
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
