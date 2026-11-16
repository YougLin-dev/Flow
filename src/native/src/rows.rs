//! Model → summary conversions shared by the write and read paths.

use crate::entity::{assets, edges, nodes};
use crate::types::{AssetSummary, EdgeSummary, NodeSummary};

impl From<&nodes::Model> for NodeSummary {
    fn from(node: &nodes::Model) -> Self {
        Self {
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
}

impl From<&edges::Model> for EdgeSummary {
    /// The row's own fields; a read that knows the endpoint cards fills the
    /// points itself.
    fn from(edge: &edges::Model) -> Self {
        Self {
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
            from_point: None,
            to_point: None,
        }
    }
}

impl From<&assets::Model> for AssetSummary {
    fn from(asset: &assets::Model) -> Self {
        Self {
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
}
