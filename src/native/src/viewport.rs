//! Viewport reads. The RTree is queried first and cross-joined to `nodes`;
//! `CROSS JOIN` is what keeps SQLite from scanning the document index.

use std::collections::HashMap;

use sea_orm::sea_query::{Condition, Expr, ExprTrait, Order, Query, SelectStatement, SimpleExpr};
use sea_orm::{ConnectionTrait, DatabaseConnection, FromQueryResult};

use crate::constants::DOCUMENT_ID;
use crate::entity::{nodes, nodes_rtree};
use crate::types::{NodeSummary, OverviewCard, Viewport};

/// The most nodes one viewport read returns. The UI applies lower card caps
/// at low zoom; this is the hard upper bound on scene data crossing the FFI.
pub const NODE_LIMIT: u64 = 2_000;

/// Phase 2 asks for the kept rows in chunks so the `IN` list stays below
/// SQLite's parameter limit.
const SEQ_CHUNK: usize = 400;

#[derive(FromQueryResult)]
struct ViewportRow {
    id: String,
    kind: String,
    title: String,
    body: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z: f64,
    rev: i64,
    data_json: String,
    settings_json: String,
    status: String,
    output_batch_id: Option<String>,
}

/// A minimap silhouette row: geometry only, no content.
#[derive(FromQueryResult)]
struct OverviewRow {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub fn viewport(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
    limit: u64,
) -> Result<Vec<NodeSummary>, String> {
    // Phase 1 keeps its payload narrow: the same RTree-first, in-view-first,
    // z/hash/id ordering as before, but only the internal seq crosses the
    // sorter. Phase 2 then fetches the summary columns for exactly those
    // rows, restoring phase-1 order instead of the `IN` result order.
    let seqs = viewport_seqs(conn, rect, margin, limit)?;
    if seqs.is_empty() {
        return Ok(Vec::new());
    }

    let mut rows: HashMap<i32, ViewportRow> = HashMap::with_capacity(seqs.len());
    for chunk in seqs.chunks(SEQ_CHUNK) {
        let statement = viewport_rows_statement(chunk);
        let fetched = conn
            .query_all(&statement)
            .map_err(|error| error.to_string())?;
        for row in fetched {
            let seq: i32 = row.try_get("", "seq").map_err(|error| error.to_string())?;
            let viewport_row =
                ViewportRow::from_query_result(&row, "").map_err(|error| error.to_string())?;
            rows.insert(seq, viewport_row);
        }
    }

    seqs.iter()
        .map(|seq| {
            rows.remove(seq)
                .map(node_summary)
                .ok_or_else(|| format!("the viewport row for seq {seq} disappeared"))
        })
        .collect()
}

fn viewport_seqs(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
    limit: u64,
) -> Result<Vec<i32>, String> {
    let statement = viewport_seq_statement(rect, margin, limit);
    let rows = conn
        .query_all(&statement)
        .map_err(|error| error.to_string())?;
    rows.iter()
        .map(|row| row.try_get("", "seq").map_err(|error| error.to_string()))
        .collect()
}

fn node_summary(row: ViewportRow) -> NodeSummary {
    NodeSummary {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        z: row.z,
        rev: row.rev as f64,
        data_json: row.data_json,
        settings_json: row.settings_json,
        status: row.status,
        output_batch_id: row.output_batch_id,
    }
}

/// Phase 1: the ordered seq sample the canvas will keep.
pub(crate) fn viewport_seq_statement(rect: Viewport, margin: f64, limit: u64) -> SelectStatement {
    let mut statement = ordered_viewport_query(rect, margin, limit);
    statement.column((nodes::Entity, nodes::Column::Seq));
    statement
}

/// The shape both the production read and the test-only reference share:
/// RTree-first `CROSS JOIN`, document/rect filter, and the in-view/z/hash/id
/// ordering that decides which cards survive the budget.
fn ordered_viewport_query(rect: Viewport, margin: f64, limit: u64) -> SelectStatement {
    let margin = margin.max(0.0);
    let mut statement = document_cards_query(&rect, margin);
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
    statement
        .order_by_expr(in_view, Order::Asc)
        .order_by((nodes::Entity, nodes::Column::Z), Order::Asc)
        .order_by_expr(sample_order(), Order::Asc)
        .order_by((nodes::Entity, nodes::Column::Id), Order::Asc)
        .limit(std::cmp::min(limit, NODE_LIMIT));

    statement
}

/// The RTree-first `CROSS JOIN` and the document/rect filter every spatial
/// read shares.
fn document_cards_query(rect: &Viewport, margin: f64) -> SelectStatement {
    let margin = margin.max(0.0);
    let min_x = rect.x - margin;
    let min_y = rect.y - margin;
    let max_x = rect.x + rect.width + margin;
    let max_y = rect.y + rect.height + margin;

    let mut statement = Query::select();
    statement
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
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID));

    statement
}

/// Ids cluster by insertion row, so taking the first N after a limit would
/// show one strip of a low-zoom viewport. A deterministic hash of the
/// internal seq spreads the sample over the whole rectangle.
fn sample_order() -> SimpleExpr {
    Expr::col((nodes::Entity, nodes::Column::Seq))
        .mul(2_654_435_761_i64)
        .modulo(2_147_483_647_i64)
}

/// The largest value `sample_order` can return.
const SAMPLE_HASH_MAX: i64 = 2_147_483_646;

/// The card silhouettes a minimap draws for the whole document: the same
/// deterministic insertion-hash sample as a viewport read, without the z
/// stacking order, so raised cards cannot crowd out the rest. `total` lets a
/// large document filter to about twice the cap before sorting, so the read
/// never sorts every row it scans.
pub(crate) fn overview_cards(
    conn: &DatabaseConnection,
    total: u64,
    limit: u64,
) -> Result<Vec<OverviewCard>, String> {
    let limit = std::cmp::min(limit, NODE_LIMIT);
    let mut statement = Query::select();
    statement
        .columns([
            (nodes::Entity, nodes::Column::Id),
            (nodes::Entity, nodes::Column::X),
            (nodes::Entity, nodes::Column::Y),
            (nodes::Entity, nodes::Column::Width),
            (nodes::Entity, nodes::Column::Height),
        ])
        .from(nodes::Entity)
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID));
    if total > limit {
        // Keep roughly two candidates per drawn card: enough that the final
        // limit still fills, small enough that the sort stays cheap.
        let keep = std::cmp::min(total, limit.saturating_mul(2));
        let threshold = (SAMPLE_HASH_MAX as u128 * keep as u128 / total as u128) as i64;
        statement
            .and_where(sample_order().lt(threshold))
            .order_by_expr(sample_order(), Order::Asc)
            .order_by((nodes::Entity, nodes::Column::Id), Order::Asc)
            .limit(limit);
    }
    let rows = conn
        .query_all(&statement)
        .map_err(|error| error.to_string())?;
    rows.iter()
        .map(|row| {
            let row = OverviewRow::from_query_result(row, "").map_err(|error| error.to_string())?;
            Ok(OverviewCard {
                id: row.id,
                x: row.x,
                y: row.y,
                width: row.width,
                height: row.height,
            })
        })
        .collect()
}

/// Phase 2: the summary columns for one `IN` chunk of kept seqs. Ordinary
/// table, ordinary SeaQuery — no RTree join and no raw SQL.
fn viewport_rows_statement(seqs: &[i32]) -> SelectStatement {
    let mut statement = Query::select();
    statement
        .columns([
            (nodes::Entity, nodes::Column::Id),
            (nodes::Entity, nodes::Column::Kind),
            (nodes::Entity, nodes::Column::Title),
            (nodes::Entity, nodes::Column::Body),
            (nodes::Entity, nodes::Column::X),
            (nodes::Entity, nodes::Column::Y),
            (nodes::Entity, nodes::Column::Width),
            (nodes::Entity, nodes::Column::Height),
            (nodes::Entity, nodes::Column::Z),
            (nodes::Entity, nodes::Column::Rev),
            (nodes::Entity, nodes::Column::DataJson),
            (nodes::Entity, nodes::Column::SettingsJson),
            (nodes::Entity, nodes::Column::Status),
            (nodes::Entity, nodes::Column::OutputBatchId),
        ])
        .column((nodes::Entity, nodes::Column::Seq))
        .from(nodes::Entity)
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID))
        .and_where(Expr::col((nodes::Entity, nodes::Column::Seq)).is_in(seqs.to_vec()));

    statement
}

/// The pre-two-phase single statement, kept as the ordering/data oracle for
/// the dense fixture test. It shares `ordered_viewport_query`, so the
/// ordering expression cannot drift from production.
#[cfg(test)]
pub(crate) fn viewport_statement_reference(
    rect: Viewport,
    margin: f64,
    limit: u64,
) -> SelectStatement {
    let mut statement = ordered_viewport_query(rect, margin, limit);
    statement.columns([
        (nodes::Entity, nodes::Column::Id),
        (nodes::Entity, nodes::Column::Kind),
        (nodes::Entity, nodes::Column::Title),
        (nodes::Entity, nodes::Column::Body),
        (nodes::Entity, nodes::Column::X),
        (nodes::Entity, nodes::Column::Y),
        (nodes::Entity, nodes::Column::Width),
        (nodes::Entity, nodes::Column::Height),
        (nodes::Entity, nodes::Column::Z),
        (nodes::Entity, nodes::Column::Rev),
        (nodes::Entity, nodes::Column::DataJson),
        (nodes::Entity, nodes::Column::SettingsJson),
        (nodes::Entity, nodes::Column::Status),
        (nodes::Entity, nodes::Column::OutputBatchId),
    ]);
    statement
}

/// Executes a statement and maps its rows exactly like the production read.
#[cfg(test)]
pub(crate) fn rows_from_statement(
    conn: &DatabaseConnection,
    statement: &SelectStatement,
) -> Result<Vec<NodeSummary>, String> {
    let rows = conn
        .query_all(statement)
        .map_err(|error| error.to_string())?;
    rows.iter()
        .map(|row| {
            ViewportRow::from_query_result(row, "")
                .map(node_summary)
                .map_err(|error| error.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::sea_query::SqliteQueryBuilder;

    #[test]
    fn viewport_statement_cross_joins_the_rtree_first() {
        let sql = viewport_seq_statement(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            120.0,
            5,
        )
        .to_string(SqliteQueryBuilder);
        println!("{sql}");
        assert!(sql.contains("FROM \"nodes_rtree\" CROSS JOIN \"nodes\""));
        assert!(sql.contains("CASE WHEN"));
        assert!(sql.contains("ORDER BY (CASE"));
        assert!(sql.contains("\"nodes\".\"z\" ASC"));
        assert!(sql.contains("\"nodes\".\"seq\""));
        assert!(sql.contains("LIMIT 5"));
    }

    #[test]
    fn the_reference_statement_keeps_the_legacy_columns_and_order() {
        let sql = viewport_statement_reference(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            120.0,
            5,
        )
        .to_string(SqliteQueryBuilder);
        println!("{sql}");
        assert!(sql.contains("FROM \"nodes_rtree\" CROSS JOIN \"nodes\""));
        assert!(sql.contains("CASE WHEN"));
        assert!(sql.contains("ORDER BY (CASE"));
        assert!(sql.contains("\"nodes\".\"z\" ASC"));
        assert!(sql.contains("\"nodes\".\"body\""));
        assert!(sql.contains("LIMIT 5"));
    }
}
