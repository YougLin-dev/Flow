//! The edge RTree: the world box around each connector's cubic curve.
//!
//! SQLite virtual tables have no ORM schema, so this module is the edge
//! index's adapter. A scene read uses it to find a connector whose curve
//! crosses the viewport while both of its cards are outside the node read.
//! The box mirrors the canvas connector box: it moves the edge DTO's
//! card-edge points to the port centres (`PORT_CENTER_GAP` 14), encloses the
//! cubic's control points with the 60–260 reach, and adds `EDGE_PADDING` 4
//! for the stroke.
//!
//! The frozen v1 schema owns the rows: triggers fill and refresh an edge's
//! box from the `edge_boxes` view when the edge changes, and record a moved
//! node in `nodes_geometry_dirty`. `flush_geometry_tx` rebuilds the boxes of
//! every connector touching a moved node once per command, then clears the
//! marker table. No app write touches `edges_rtree` directly.

use sea_orm::sea_query::{Expr, ExprTrait, Order, Query, SelectStatement};
use sea_orm::{ConnectionTrait, DbErr, FromQueryResult};

use crate::entity::edges;
use crate::types::{EdgePoint, Viewport};

/// How far outside a card's border its port icon's centre sits. Mirrors
/// `PORT_CENTER_GAP` in `src/flow/canvas/geometry/connection.ts`.
pub const PORT_CENTER_GAP: f64 = 14.0;
/// The room around a connector's cubic for its stroke. Mirrors
/// `EDGE_PADDING` in the TSX geometry and the v1 `edge_boxes` view.
pub const EDGE_PADDING: f64 = 4.0;

/// The world box around a connector's whole cubic: `(min_x, max_x, min_y,
/// max_y)`. `from` and `to` are the card-edge points carried by the edge
/// DTO; the box shifts them to the port icons' centres and adds the stroke
/// padding, exactly like the v1 `edge_boxes` view. The app never computes an
/// edge box in Rust now that the triggers own the index; this is the oracle
/// the frozen SQL and the TSX geometry are tested against.
#[cfg_attr(not(test), allow(dead_code))]
pub fn connection_bounds(from: EdgePoint, to: EdgePoint) -> (f64, f64, f64, f64) {
    let from_x = from.x + PORT_CENTER_GAP;
    let to_x = to.x - PORT_CENTER_GAP;
    let dx = (to_x - from_x).abs();
    let dy = (to.y - from.y).abs();
    let reach = (dx * 0.5 + dy * 0.15).clamp(60.0, 260.0);
    let left = from_x.min(from_x + reach).min(to_x - reach).min(to_x);
    let right = from_x.max(from_x + reach).max(to_x - reach).max(to_x);
    let top = from.y.min(to.y);
    let bottom = from.y.max(to.y);
    (
        left - EDGE_PADDING,
        right + EDGE_PADDING,
        top - EDGE_PADDING,
        bottom + EDGE_PADDING,
    )
}

/// The connectors whose curve boxes intersect the viewport read. This is the
/// indexed half of a scene read; it does not depend on either card being
/// returned, so a long connector crossing the viewport still draws.
pub fn viewport(
    conn: &impl ConnectionTrait,
    rect: &Viewport,
    margin: f64,
) -> Result<Vec<edges::Model>, DbErr> {
    let statement = viewport_statement(rect, margin);
    let rows = conn.query_all(&statement)?;
    rows.iter()
        .map(|row| edges::Model::from_query_result(row, ""))
        .collect()
}

pub(crate) fn viewport_statement(rect: &Viewport, margin: f64) -> SelectStatement {
    let margin = margin.max(0.0);
    let min_x = rect.x - margin;
    let min_y = rect.y - margin;
    let max_x = rect.x + rect.width + margin;
    let max_y = rect.y + rect.height + margin;

    let mut statement = Query::select();
    statement
        .columns([
            (edges::Entity, edges::Column::Seq),
            (edges::Entity, edges::Column::Id),
            (edges::Entity, edges::Column::FromId),
            (edges::Entity, edges::Column::ToId),
            (edges::Entity, edges::Column::FromPort),
            (edges::Entity, edges::Column::ToPort),
            (edges::Entity, edges::Column::PortKind),
            (edges::Entity, edges::Column::FromOffset),
            (edges::Entity, edges::Column::ToOffset),
            (edges::Entity, edges::Column::Kind),
            (edges::Entity, edges::Column::DataJson),
        ])
        .from(crate::entity::edges_rtree::Entity)
        .cross_join(edges::Entity)
        // Both keys are the edge's insertion sequence in v1.
        .and_where(Expr::col((edges::Entity, edges::Column::Seq)).equals((
            crate::entity::edges_rtree::Entity,
            crate::entity::edges_rtree::Column::Id,
        )))
        .and_where(
            Expr::col((
                crate::entity::edges_rtree::Entity,
                crate::entity::edges_rtree::Column::MaxX,
            ))
            .gte(min_x),
        )
        .and_where(
            Expr::col((
                crate::entity::edges_rtree::Entity,
                crate::entity::edges_rtree::Column::MinX,
            ))
            .lte(max_x),
        )
        .and_where(
            Expr::col((
                crate::entity::edges_rtree::Entity,
                crate::entity::edges_rtree::Column::MaxY,
            ))
            .gte(min_y),
        )
        .and_where(
            Expr::col((
                crate::entity::edges_rtree::Entity,
                crate::entity::edges_rtree::Column::MinY,
            ))
            .lte(max_y),
        )
        .order_by((edges::Entity, edges::Column::Id), Order::Asc);

    statement
}

/// The edges touching a dirty node. The two `IN` subqueries are what let
/// SQLite plan a MULTI-INDEX OR over `edges_port_pair` and `edges_to`; a
/// `JOIN ... ON d.node_id = e.from_id OR d.node_id = e.to_id` cannot be
/// driven from the marker table and scans every edge on every command.
const DIRTY_EDGE_SEQS: &str = "SELECT e.seq FROM edges AS e \
     WHERE e.from_id IN (SELECT node_id FROM nodes_geometry_dirty) \
        OR e.to_id IN (SELECT node_id FROM nodes_geometry_dirty)";

pub(crate) fn dirty_edge_delete_statement() -> String {
    format!("DELETE FROM edges_rtree WHERE id IN ({DIRTY_EDGE_SEQS})")
}

pub(crate) fn dirty_edge_insert_statement() -> String {
    format!(
        "INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y) \
         SELECT b.id, b.min_x, b.max_x, b.min_y, b.max_y \
           FROM edge_boxes AS b \
          WHERE b.id IN ({DIRTY_EDGE_SEQS})"
    )
}

/// Rebuilds the connector boxes of every edge touching a moved or resized
/// node and clears the markers. Runs once per command transaction; with no
/// dirty nodes it returns after one marker lookup, before touching the index.
pub fn flush_geometry_tx(txn: &impl ConnectionTrait) -> Result<(), DbErr> {
    if !has_dirty_geometry(txn)? {
        return Ok(());
    }
    txn.execute_unprepared(&dirty_edge_delete_statement())?;
    txn.execute_unprepared(&dirty_edge_insert_statement())?;
    txn.execute_unprepared("DELETE FROM nodes_geometry_dirty")?;
    Ok(())
}

fn has_dirty_geometry(txn: &impl ConnectionTrait) -> Result<bool, DbErr> {
    let row = txn.query_one_raw(sea_orm::Statement::from_string(
        txn.get_database_backend(),
        "SELECT EXISTS (SELECT 1 FROM nodes_geometry_dirty)".to_owned(),
    ))?;
    row.ok_or_else(|| DbErr::Custom("the dirty marker check returned no row".to_owned()))?
        .try_get_by_index::<i64>(0)
        .map(|found| found != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::sea_query::SqliteQueryBuilder;

    #[test]
    fn viewport_statement_cross_joins_the_rtree_first() {
        let sql = viewport_statement(
            &Viewport {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            120.0,
        )
        .to_string(SqliteQueryBuilder);
        assert!(sql.contains("FROM \"edges_rtree\" CROSS JOIN \"edges\""));
        assert!(sql.contains("\"edges\".\"seq\" = \"edges_rtree\".\"id\""));
    }

    #[test]
    fn the_box_holds_the_cubic_of_a_forward_connector() {
        // The handles sit between the ports, so the box is the port centres'
        // span (card edge ±14) plus the stroke padding.
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 200.0, y: 42.0 },
            EdgePoint { x: 900.0, y: 142.0 },
        );
        assert_eq!((min_x, max_x), (210.0, 890.0));
        assert_eq!((min_y, max_y), (38.0, 146.0));
    }

    #[test]
    fn the_box_uses_the_minimum_reach_for_a_short_connector() {
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 200.0, y: 42.0 },
            EdgePoint { x: 250.0, y: 62.0 },
        );
        assert_eq!((min_x, max_x), (172.0, 278.0));
        assert_eq!((min_y, max_y), (38.0, 66.0));
    }

    #[test]
    fn a_backward_connector_still_covers_both_handles() {
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 900.0, y: 142.0 },
            EdgePoint { x: 200.0, y: 42.0 },
        );
        assert_eq!((min_x, max_x), (-78.0, 1178.0));
        assert_eq!((min_y, max_y), (38.0, 146.0));
    }
}
