//! Viewport reads. The RTree is queried first and cross-joined to `nodes`;
//! `CROSS JOIN` is what keeps SQLite from scanning the document index.

use sea_orm::sea_query::{Condition, Expr, ExprTrait, Order, Query, SelectStatement};
use sea_orm::{ConnectionTrait, DatabaseConnection, FromQueryResult};

use crate::constants::DOCUMENT_ID;
use crate::entity::{nodes, nodes_rtree};
use crate::types::{NodeSummary, Viewport};

/// The most nodes one viewport read returns. The UI applies lower card caps
/// at low zoom; this is the hard upper bound on scene data crossing the FFI.
pub const NODE_LIMIT: u64 = 2_000;

#[derive(FromQueryResult)]
struct ViewportRow {
    id: String,
    kind: String,
    title: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z: f64,
    rev: i64,
    data_json: String,
}

pub fn viewport(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
) -> Result<Vec<NodeSummary>, String> {
    let statement = viewport_statement(rect, margin);
    let rows = conn
        .query_all(&statement)
        .map_err(|error| error.to_string())?;

    rows.iter()
        .map(|row| {
            ViewportRow::from_query_result(row, "")
                .map(|row| NodeSummary {
                    id: row.id,
                    kind: row.kind,
                    title: row.title,
                    x: row.x,
                    y: row.y,
                    width: row.width,
                    height: row.height,
                    z: row.z,
                    rev: row.rev as f64,
                    data_json: row.data_json,
                })
                .map_err(|error| error.to_string())
        })
        .collect()
}

pub(crate) fn viewport_statement(rect: Viewport, margin: f64) -> SelectStatement {
    let margin = margin.max(0.0);
    let min_x = rect.x - margin;
    let min_y = rect.y - margin;
    let max_x = rect.x + rect.width + margin;
    let max_y = rect.y + rect.height + margin;

    let mut statement = Query::select();
    // The margin is for prefetching, not for the first frame: with the limit
    // applied after ordering, nodes outside the visible rectangle but inside
    // the margin must not consume the UI's card budget. Sort the nodes that
    // intersect `rect` before the margin-only ones.
    let in_view = Expr::case(
        Condition::all()
            .add(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MaxX)).gte(rect.x))
            .add(
                Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MinX))
                    .lte(rect.x + rect.width),
            )
            .add(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MaxY)).gte(rect.y))
            .add(
                Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MinY))
                    .lte(rect.y + rect.height),
            ),
        0,
    )
    .finally(1)
    .into();
    // Ids cluster by insertion row, so taking the first N after a limit would
    // show one strip of a low-zoom viewport. A deterministic hash of the
    // internal seq spreads the sample over the whole rectangle; z still owns
    // the layer order.
    let sample_order = Expr::col((nodes::Entity, nodes::Column::Seq))
        .mul(2_654_435_761_i64)
        .modulo(2_147_483_647_i64);
    statement
        .columns([
            (nodes::Entity, nodes::Column::Id),
            (nodes::Entity, nodes::Column::Kind),
            (nodes::Entity, nodes::Column::Title),
            (nodes::Entity, nodes::Column::X),
            (nodes::Entity, nodes::Column::Y),
            (nodes::Entity, nodes::Column::Width),
            (nodes::Entity, nodes::Column::Height),
            (nodes::Entity, nodes::Column::Z),
            (nodes::Entity, nodes::Column::Rev),
            (nodes::Entity, nodes::Column::DataJson),
        ])
        .from(nodes_rtree::Entity)
        .cross_join(nodes::Entity)
        .and_where(
            Expr::col((nodes_rtree::Entity, nodes_rtree::Column::Id))
                .equals((nodes::Entity, nodes::Column::Seq)),
        )
        .and_where(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MaxX)).gte(min_x))
        .and_where(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MinX)).lte(max_x))
        .and_where(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MaxY)).gte(min_y))
        .and_where(Expr::col((nodes_rtree::Entity, nodes_rtree::Column::MinY)).lte(max_y))
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID))
        .order_by_expr(in_view, Order::Asc)
        .order_by((nodes::Entity, nodes::Column::Z), Order::Asc)
        .order_by_expr(sample_order, Order::Asc)
        .order_by((nodes::Entity, nodes::Column::Id), Order::Asc)
        .limit(NODE_LIMIT);

    statement
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::sea_query::SqliteQueryBuilder;

    #[test]
    fn viewport_statement_cross_joins_the_rtree_first() {
        let sql = viewport_statement(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            120.0,
        )
        .to_string(SqliteQueryBuilder);
        println!("{sql}");
        assert!(sql.contains("FROM \"nodes_rtree\" CROSS JOIN \"nodes\""));
        assert!(sql.contains("CASE WHEN"));
        assert!(sql.contains("ORDER BY (CASE"));
        assert!(sql.contains("\"nodes\".\"z\" ASC"));
    }
}
