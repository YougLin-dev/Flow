//! FTS5 and RTree integrity repair for `verify()`.
//!
//! These virtual tables have no ORM schema, so this module is their
//! maintenance adapter: it checks the indexes against their content tables
//! and rebuilds one that drifted. Everything here is plain DML against the
//! frozen v1 tables, so a repair needs no schema change.

use sea_orm::{ConnectionTrait, DbErr, Statement};

const FTS_INTEGRITY_CHECK: &str =
    "INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)";
const FTS_REBUILD: &str = "INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')";

const NODES_RTREE_CHECK: &str = "SELECT rtreecheck('nodes_rtree')";
const EDGES_RTREE_CHECK: &str = "SELECT rtreecheck('edges_rtree')";
// RTree cells are 32-bit floats; the tolerance follows their relative
// precision instead of demanding an exact f64 match.
const NODES_RTREE_PARITY: &str = "SELECT EXISTS ( \
       SELECT 1 FROM nodes AS n \
        LEFT JOIN nodes_rtree AS r ON r.id = n.seq \
        WHERE r.id IS NULL \
       UNION ALL \
       SELECT 1 FROM nodes_rtree AS r \
        LEFT JOIN nodes AS n ON n.seq = r.id \
        WHERE n.seq IS NULL \
       UNION ALL \
       SELECT 1 FROM nodes AS n \
        JOIN nodes_rtree AS r ON r.id = n.seq \
        WHERE abs(r.min_x - (n.x - 2.0)) \
                > 0.0000002 * max(1.0, abs(n.x - 2.0)) + 0.0001 \
           OR abs(r.max_x - (n.x + n.width + 2.0)) \
                > 0.0000002 * max(1.0, abs(n.x + n.width + 2.0)) + 0.0001 \
           OR abs(r.min_y - (n.y - 2.0)) \
                > 0.0000002 * max(1.0, abs(n.y - 2.0)) + 0.0001 \
           OR abs(r.max_y - (n.y + n.height + 2.0)) \
                > 0.0000002 * max(1.0, abs(n.y + n.height + 2.0)) + 0.0001)";
const EDGES_RTREE_PARITY: &str = "SELECT EXISTS ( \
       SELECT 1 FROM edges AS e \
        LEFT JOIN edges_rtree AS r ON r.id = e.seq \
        WHERE r.id IS NULL \
       UNION ALL \
       SELECT 1 FROM edges_rtree AS r \
        LEFT JOIN edges AS e ON e.seq = r.id \
        WHERE e.seq IS NULL \
       UNION ALL \
       SELECT 1 FROM edge_boxes AS b \
        JOIN edges_rtree AS r ON r.id = b.id \
        WHERE abs(r.min_x - b.min_x) \
                > 0.0000002 * max(1.0, abs(b.min_x)) + 0.0001 \
           OR abs(r.max_x - b.max_x) \
                > 0.0000002 * max(1.0, abs(b.max_x)) + 0.0001 \
           OR abs(r.min_y - b.min_y) \
                > 0.0000002 * max(1.0, abs(b.min_y)) + 0.0001 \
           OR abs(r.max_y - b.max_y) \
                > 0.0000002 * max(1.0, abs(b.max_y)) + 0.0001)";

/// Checks the FTS index against `nodes` and rebuilds it when the parity check
/// fails. The hidden `rank` argument makes FTS5 compare against the external
/// content table; a plain integrity-check only inspects the index itself.
pub(crate) fn repair_fts(conn: &impl ConnectionTrait) -> Result<(), DbErr> {
    if conn.execute_unprepared(FTS_INTEGRITY_CHECK).is_ok() {
        return Ok(());
    }
    conn.execute_unprepared(FTS_REBUILD)?;
    conn.execute_unprepared(FTS_INTEGRITY_CHECK)?;
    Ok(())
}

/// Checks both RTrees and rebuilds the ones whose structure, row set or cell
/// values drifted from `nodes`/`edges`. `rtreecheck` validates the virtual
/// table's own layout; the parity query catches a missing or extra box and a
/// stale cell.
pub(crate) fn repair_rtrees(conn: &impl ConnectionTrait) -> Result<(), DbErr> {
    if !rtree_healthy(conn, NODES_RTREE_CHECK, NODES_RTREE_PARITY)? {
        conn.execute_unprepared("DELETE FROM nodes_rtree")?;
        conn.execute_unprepared(
            "INSERT INTO nodes_rtree (id, min_x, max_x, min_y, max_y) \
             SELECT seq, x - 2.0, x + width + 2.0, y - 2.0, y + height + 2.0 \
               FROM nodes",
        )?;
        if !rtree_healthy(conn, NODES_RTREE_CHECK, NODES_RTREE_PARITY)? {
            return Err(DbErr::Custom(
                "the nodes RTree is still inconsistent after a rebuild".to_owned(),
            ));
        }
    }
    if !rtree_healthy(conn, EDGES_RTREE_CHECK, EDGES_RTREE_PARITY)? {
        conn.execute_unprepared("DELETE FROM edges_rtree")?;
        conn.execute_unprepared(
            "INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y) \
             SELECT id, min_x, max_x, min_y, max_y FROM edge_boxes",
        )?;
        if !rtree_healthy(conn, EDGES_RTREE_CHECK, EDGES_RTREE_PARITY)? {
            return Err(DbErr::Custom(
                "the edges RTree is still inconsistent after a rebuild".to_owned(),
            ));
        }
    }
    Ok(())
}

fn rtree_healthy(
    conn: &impl ConnectionTrait,
    check_sql: &str,
    parity_sql: &str,
) -> Result<bool, DbErr> {
    if scalar(conn, check_sql)?.as_deref() != Some("ok") {
        return Ok(false);
    }
    Ok(scalar(conn, parity_sql)?.as_deref() != Some("1"))
}

/// The first column of `sql` as text, however SQLite typed it.
fn scalar(conn: &impl ConnectionTrait, sql: &str) -> Result<Option<String>, DbErr> {
    let row = conn.query_one_raw(Statement::from_string(
        conn.get_database_backend(),
        sql.to_owned(),
    ))?;
    let Some(row) = row else {
        return Ok(None);
    };
    if let Ok(text) = row.try_get_by_index::<String>(0) {
        return Ok(Some(text));
    }
    if let Ok(number) = row.try_get_by_index::<i64>(0) {
        return Ok(Some(number.to_string()));
    }
    Ok(None)
}
