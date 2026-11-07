//! Scene reads: the viewport's nodes, the edges that touch them, and the
//! whole document's bounds for Fit.

use std::collections::BTreeMap;

use sea_orm::sea_query::{Alias, Expr, ExprTrait, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
};

use crate::constants::DOCUMENT_ID;
use crate::document;
use crate::entity::{edges, nodes};
use crate::types::{EdgeSummary, NodeSummary, SceneSnapshot, Viewport};
use crate::viewport;

/// Edges are queried in chunks so the `IN` list stays below SQLite's
/// parameter limit.
const EDGE_CHUNK: usize = 400;

pub fn snapshot(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
) -> Result<SceneSnapshot, String> {
    let nodes = viewport::viewport(conn, rect, margin)?;
    let edges = edges_for_nodes(conn, &nodes)?;
    let rev = document::current_rev(conn).map_err(|error| error.to_string())?;

    Ok(SceneSnapshot {
        rev: rev as f64,
        nodes,
        edges,
    })
}

/// One node by its public id, used to reveal a search hit.
pub fn get_node(conn: &DatabaseConnection, id: &str) -> Result<Option<NodeSummary>, String> {
    let row = nodes::Entity::find()
        .filter(nodes::Column::Id.eq(id))
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .one(conn)
        .map_err(|error| error.to_string())?;
    Ok(row.map(|row| node_summary(&row)))
}

pub fn bounds(conn: &DatabaseConnection) -> Result<Viewport, String> {
    let mut query = Query::select();
    query
        .expr_as(
            Expr::col((nodes::Entity, nodes::Column::X)).min(),
            Alias::new("min_x"),
        )
        .expr_as(
            Expr::col((nodes::Entity, nodes::Column::X))
                .add(Expr::col((nodes::Entity, nodes::Column::Width)))
                .max(),
            Alias::new("max_x"),
        )
        .expr_as(
            Expr::col((nodes::Entity, nodes::Column::Y)).min(),
            Alias::new("min_y"),
        )
        .expr_as(
            Expr::col((nodes::Entity, nodes::Column::Y))
                .add(Expr::col((nodes::Entity, nodes::Column::Height)))
                .max(),
            Alias::new("max_y"),
        )
        .from(nodes::Entity)
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID));

    let row = conn.query_one(&query).map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(empty_bounds());
    };

    let min_x: Option<f64> = row
        .try_get("", "min_x")
        .map_err(|error| error.to_string())?;
    let max_x: Option<f64> = row
        .try_get("", "max_x")
        .map_err(|error| error.to_string())?;
    let min_y: Option<f64> = row
        .try_get("", "min_y")
        .map_err(|error| error.to_string())?;
    let max_y: Option<f64> = row
        .try_get("", "max_y")
        .map_err(|error| error.to_string())?;

    match (min_x, max_x, min_y, max_y) {
        (Some(min_x), Some(max_x), Some(min_y), Some(max_y)) => Ok(Viewport {
            x: min_x,
            y: min_y,
            width: (max_x - min_x).max(1.0),
            height: (max_y - min_y).max(1.0),
        }),
        _ => Ok(empty_bounds()),
    }
}

fn edges_for_nodes(
    conn: &DatabaseConnection,
    nodes: &[NodeSummary],
) -> Result<Vec<EdgeSummary>, String> {
    if nodes.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
    let mut found = BTreeMap::new();

    for chunk in ids.chunks(EDGE_CHUNK) {
        let rows = edges::Entity::find()
            .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
            .filter(
                Condition::any()
                    .add(edges::Column::FromId.is_in(chunk.to_vec()))
                    .add(edges::Column::ToId.is_in(chunk.to_vec())),
            )
            .all(conn)
            .map_err(|error| error.to_string())?;

        for row in rows {
            found
                .entry(row.id.clone())
                .or_insert_with(|| edge_summary(&row));
        }
    }

    Ok(found.into_values().collect())
}

fn node_summary(node: &nodes::Model) -> NodeSummary {
    NodeSummary {
        id: node.id.clone(),
        kind: node.kind.clone(),
        title: node.title.clone(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        z: node.z,
        rev: node.rev as f64,
        data_json: node.data_json.clone(),
    }
}

fn edge_summary(edge: &edges::Model) -> EdgeSummary {
    EdgeSummary {
        id: edge.id.clone(),
        from_id: edge.from_id.clone(),
        to_id: edge.to_id.clone(),
        from_port: edge.from_port.clone(),
        to_port: edge.to_port.clone(),
        kind: edge.kind.clone(),
        data_json: edge.data_json.clone(),
    }
}

fn empty_bounds() -> Viewport {
    Viewport {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    }
}
