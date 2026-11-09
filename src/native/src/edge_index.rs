//! The edge RTree: the world box around each connector's cubic curve.
//!
//! SQLite virtual tables have no ORM schema, so this module is the edge
//! index's adapter. A scene read uses it to find a connector whose curve
//! crosses the viewport while both of its cards are outside the node read.
//! The box mirrors `connectionBounds` in `src/flow/connection.ts`; every edge
//! or node write that changes it refreshes the row in the same transaction.

use sea_orm::sea_query::{Condition, Expr, ExprTrait, Order, Query, SelectStatement, Value};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, FromQueryResult, QueryFilter, Set,
    Statement,
};

use crate::constants::DOCUMENT_ID;
use crate::entity::{edges, edges_rtree, nodes};
use crate::types::{EdgePoint, Viewport};

/// The world box around a connector's whole cubic: `(min_x, max_x, min_y,
/// max_y)`. The control handles reach sideways, so the box starts from all
/// four of the cubic's points, exactly like the UI's `connectionBounds`.
pub fn connection_bounds(from: EdgePoint, to: EdgePoint) -> (f64, f64, f64, f64) {
    let dx = (to.x - from.x).abs();
    let dy = (to.y - from.y).abs();
    let reach = (dx * 0.5 + dy * 0.15).clamp(60.0, 260.0);
    let left = from.x.min(from.x + reach).min(to.x - reach).min(to.x);
    let right = from.x.max(from.x + reach).max(to.x - reach).max(to.x);
    let top = from.y.min(to.y);
    let bottom = from.y.max(to.y);
    (left, right, top, bottom)
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
            (edges::Entity, edges::Column::Id),
            (edges::Entity, edges::Column::DocumentId),
            (edges::Entity, edges::Column::FromId),
            (edges::Entity, edges::Column::ToId),
            (edges::Entity, edges::Column::FromPort),
            (edges::Entity, edges::Column::ToPort),
            (edges::Entity, edges::Column::Kind),
            (edges::Entity, edges::Column::DataJson),
        ])
        .from(edges_rtree::Entity)
        .cross_join(edges::Entity)
        // `edges.id` is a string; the RTree key is the edge's rowid.
        .and_where(Expr::cust("edges.rowid = edges_rtree.id"))
        .and_where(Expr::col((edges_rtree::Entity, edges_rtree::Column::MaxX)).gte(min_x))
        .and_where(Expr::col((edges_rtree::Entity, edges_rtree::Column::MinX)).lte(max_x))
        .and_where(Expr::col((edges_rtree::Entity, edges_rtree::Column::MaxY)).gte(min_y))
        .and_where(Expr::col((edges_rtree::Entity, edges_rtree::Column::MinY)).lte(max_y))
        .and_where(Expr::col((edges::Entity, edges::Column::DocumentId)).eq(DOCUMENT_ID))
        .order_by((edges::Entity, edges::Column::Id), Order::Asc);

    statement
}

/// Recomputes one connector's box from its current endpoints. An edge whose
/// endpoint rows are missing loses its index row instead of keeping a stale
/// box; the endpoint rows can only be missing mid-undo, and the restore of
/// the node refreshes the edge again.
pub fn sync_edge(conn: &impl ConnectionTrait, edge_id: &str) -> Result<(), DbErr> {
    let Some(edge) = find_edge(conn, edge_id)? else {
        return remove_edge(conn, edge_id);
    };
    match (
        find_node(conn, &edge.from_id)?,
        find_node(conn, &edge.to_id)?,
    ) {
        (Some(from), Some(to)) => write_bounds(conn, &edge, &from, &to),
        _ => remove_edge(conn, edge_id),
    }
}

/// Recomputes every connector that touches a node after its geometry moved
/// or resized.
pub fn sync_node_edges(conn: &impl ConnectionTrait, node_id: &str) -> Result<(), DbErr> {
    let Some(node) = find_node(conn, node_id)? else {
        return Ok(());
    };
    let rows = edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(
            Condition::any()
                .add(edges::Column::FromId.eq(node_id))
                .add(edges::Column::ToId.eq(node_id)),
        )
        .all(conn)?;
    for edge in rows {
        let from = if edge.from_id == node_id {
            Some(node.clone())
        } else {
            find_node(conn, &edge.from_id)?
        };
        let to = if edge.to_id == node_id {
            Some(node.clone())
        } else {
            find_node(conn, &edge.to_id)?
        };
        match (from, to) {
            (Some(from), Some(to)) => write_bounds(conn, &edge, &from, &to)?,
            _ => remove_edge(conn, &edge.id)?,
        }
    }
    Ok(())
}

/// Drops one edge's index row. Call it before the edge row itself goes.
pub fn remove_edge(conn: &impl ConnectionTrait, edge_id: &str) -> Result<(), DbErr> {
    conn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM edges_rtree WHERE id IN (SELECT rowid FROM edges WHERE id = ?)",
        [Value::from(edge_id)],
    ))?;
    Ok(())
}

/// Drops the index rows of every edge touching a node. Call it before the
/// node row goes, while the cascade has not removed the edges yet.
pub fn remove_node_edges(conn: &impl ConnectionTrait, node_id: &str) -> Result<(), DbErr> {
    conn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM edges_rtree WHERE id IN \
         (SELECT rowid FROM edges WHERE from_id = ? OR to_id = ?)",
        [Value::from(node_id), Value::from(node_id)],
    ))?;
    Ok(())
}

fn write_bounds(
    conn: &impl ConnectionTrait,
    edge: &edges::Model,
    from: &nodes::Model,
    to: &nodes::Model,
) -> Result<(), DbErr> {
    let Some(rowid) = edge_rowid(conn, &edge.id)? else {
        return Ok(());
    };
    let (min_x, max_x, min_y, max_y) = connection_bounds(
        EdgePoint::output(from.x, from.y, from.width, from.height),
        EdgePoint::input(to.x, to.y, to.height),
    );
    edges_rtree::Entity::delete_by_id(rowid).exec(conn)?;
    edges_rtree::Entity::insert(edges_rtree::ActiveModel {
        id: Set(rowid),
        min_x: Set(min_x),
        max_x: Set(max_x),
        min_y: Set(min_y),
        max_y: Set(max_y),
    })
    .exec(conn)?;
    Ok(())
}

fn find_node(conn: &impl ConnectionTrait, id: &str) -> Result<Option<nodes::Model>, DbErr> {
    nodes::Entity::find()
        .filter(nodes::Column::Id.eq(id))
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .one(conn)
}

fn find_edge(conn: &impl ConnectionTrait, id: &str) -> Result<Option<edges::Model>, DbErr> {
    edges::Entity::find_by_id(id.to_owned())
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .one(conn)
}

fn edge_rowid(conn: &impl ConnectionTrait, id: &str) -> Result<Option<i64>, DbErr> {
    let statement = Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "SELECT rowid AS seq FROM edges WHERE id = ?",
        [Value::from(id)],
    );
    conn.query_one_raw(statement)?
        .map(|row| row.try_get::<i64>("", "seq"))
        .transpose()
}

/// Fills the index from the edge and node tables. Runs once when migration 3
/// lands and is idempotent: a rebuild replaces every row.
pub fn backfill(conn: &impl ConnectionTrait) -> Result<(), DbErr> {
    conn.execute_unprepared("DELETE FROM edges_rtree")?;
    let statement = Statement::from_string(
        DbBackend::Sqlite,
        "SELECT edges.rowid AS seq, \
                f.x AS from_x, f.y AS from_y, f.width AS from_width, f.height AS from_height, \
                t.x AS to_x, t.y AS to_y, t.height AS to_height \
         FROM edges \
         JOIN nodes AS f ON f.id = edges.from_id \
         JOIN nodes AS t ON t.id = edges.to_id"
            .to_owned(),
    );
    for row in conn.query_all_raw(statement)? {
        let seq: i64 = row.try_get("", "seq")?;
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint::output(
                row.try_get("", "from_x")?,
                row.try_get("", "from_y")?,
                row.try_get("", "from_width")?,
                row.try_get("", "from_height")?,
            ),
            EdgePoint::input(
                row.try_get("", "to_x")?,
                row.try_get("", "to_y")?,
                row.try_get("", "to_height")?,
            ),
        );
        edges_rtree::Entity::insert(edges_rtree::ActiveModel {
            id: Set(seq),
            min_x: Set(min_x),
            max_x: Set(max_x),
            min_y: Set(min_y),
            max_y: Set(max_y),
        })
        .exec(conn)?;
    }
    Ok(())
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
        assert!(sql.contains("edges.rowid = edges_rtree.id"));
    }

    #[test]
    fn the_box_holds_the_cubic_of_a_forward_connector() {
        // The handles sit between the ports, so the box is the ports' span.
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 200.0, y: 42.0 },
            EdgePoint { x: 900.0, y: 142.0 },
        );
        assert_eq!((min_x, max_x), (200.0, 900.0));
        assert_eq!((min_y, max_y), (42.0, 142.0));
    }

    #[test]
    fn the_box_uses_the_minimum_reach_for_a_short_connector() {
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 200.0, y: 42.0 },
            EdgePoint { x: 250.0, y: 62.0 },
        );
        assert_eq!((min_x, max_x), (190.0, 260.0));
        assert_eq!((min_y, max_y), (42.0, 62.0));
    }

    #[test]
    fn a_backward_connector_still_covers_both_handles() {
        let (min_x, max_x, min_y, max_y) = connection_bounds(
            EdgePoint { x: 900.0, y: 142.0 },
            EdgePoint { x: 200.0, y: 42.0 },
        );
        assert_eq!((min_x, max_x), (-60.0, 1160.0));
        assert_eq!((min_y, max_y), (42.0, 142.0));
    }
}
