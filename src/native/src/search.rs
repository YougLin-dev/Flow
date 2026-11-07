//! Search over the FTS5 index, with a bounded `LIKE` fallback for queries
//! shorter than the trigram tokenizer can index.
//!
//! SeaQuery builds the joins, filters and ordering. The three SQLite-specific
//! fragments below are unavoidable: `MATCH`, `snippet()`/`bm25()`, and the
//! escaped `LIKE` fallback. Every value is still bound, never interpolated.

use sea_orm::sea_query::{Alias, Expr, ExprTrait, Order, Query, SelectStatement};
use sea_orm::{ConnectionTrait, DatabaseConnection, FromQueryResult};

use crate::constants::DOCUMENT_ID;
use crate::entity::{nodes, nodes_fts};
use crate::types::{SearchFilters, SearchHit};

#[derive(FromQueryResult)]
struct SearchHitRow {
    id: String,
    kind: String,
    title: String,
    snippet: String,
    score: f64,
}

pub fn search(
    conn: &DatabaseConnection,
    query: String,
    filters: SearchFilters,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    let limit = u64::from(limit.clamp(1, 200));
    let kind = filters.kind;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let shortest = query
        .split_whitespace()
        .map(|term| term.chars().count())
        .min()
        .unwrap_or(0);
    if shortest < 3 {
        return collect(conn, &like_statement(query, kind.as_deref(), limit));
    }

    let match_query = fts_match_query(query);
    if match_query.is_empty() {
        return Ok(Vec::new());
    }

    collect(conn, &fts_statement(&match_query, kind.as_deref(), limit))
}

pub(crate) fn fts_statement(match_query: &str, kind: Option<&str>, limit: u64) -> SelectStatement {
    let mut statement = Query::select();
    statement
        .column((nodes::Entity, nodes::Column::Id))
        .column((nodes::Entity, nodes::Column::Kind))
        .column((nodes::Entity, nodes::Column::Title))
        .expr_as(
            Expr::cust("snippet(nodes_fts, 1, '', '', '…', 16)"),
            Alias::new("snippet"),
        )
        .expr_as(
            Expr::cust("(-bm25(nodes_fts, 8.0, 2.0, 1.0))"),
            Alias::new("score"),
        )
        // `CROSS JOIN` is deliberate: it keeps FTS5 as the outer table. With a
        // plain `INNER JOIN`, SQLite scans `nodes` by document and re-runs the
        // FTS match per row, which turns a 10k-node search into 26 seconds.
        .from(nodes_fts::Entity)
        .cross_join(nodes::Entity)
        .and_where(
            Expr::col((nodes_fts::Entity, nodes_fts::Column::Rowid))
                .equals((nodes::Entity, nodes::Column::Seq)),
        )
        .and_where(Expr::cust_with_values(
            "nodes_fts MATCH ?",
            [match_query.to_owned()],
        ))
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID));

    if let Some(kind) = kind {
        statement.and_where(Expr::col((nodes::Entity, nodes::Column::Kind)).eq(kind));
    }

    statement
        .order_by_expr(Expr::cust("score"), Order::Desc)
        .limit(limit);

    statement
}

fn like_statement(query: &str, kind: Option<&str>, limit: u64) -> SelectStatement {
    let pattern = format!("%{}%", escape_like(query));

    let mut statement = Query::select();
    statement
        .column((nodes::Entity, nodes::Column::Id))
        .column((nodes::Entity, nodes::Column::Kind))
        .column((nodes::Entity, nodes::Column::Title))
        .expr_as(
            Expr::cust("substr(nodes.body, 1, 120)"),
            Alias::new("snippet"),
        )
        .expr_as(Expr::val(0.0), Alias::new("score"))
        .from(nodes::Entity)
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID))
        .and_where(Expr::cust_with_values(
            "(nodes.title LIKE ? ESCAPE '\\' OR nodes.body LIKE ? ESCAPE '\\' \
             OR nodes.tags_json LIKE ? ESCAPE '\\')",
            [pattern.clone(), pattern.clone(), pattern],
        ));

    if let Some(kind) = kind {
        statement.and_where(Expr::col((nodes::Entity, nodes::Column::Kind)).eq(kind));
    }

    statement
        .order_by_expr(
            Expr::col((nodes::Entity, nodes::Column::Title)).eq(query),
            Order::Desc,
        )
        .order_by((nodes::Entity, nodes::Column::Z), Order::Asc)
        .limit(limit);

    statement
}

fn collect(
    conn: &DatabaseConnection,
    statement: &SelectStatement,
) -> Result<Vec<SearchHit>, String> {
    let rows = conn
        .query_all(statement)
        .map_err(|error| error.to_string())?;

    rows.iter()
        .map(|row| {
            SearchHitRow::from_query_result(row, "")
                .map(|hit| SearchHit {
                    id: hit.id,
                    kind: hit.kind,
                    title: hit.title,
                    snippet: hit.snippet,
                    score: hit.score,
                })
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn fts_match_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::sea_query::SqliteQueryBuilder;

    #[test]
    fn fts_statement_matches_before_joining_nodes() {
        let sql = fts_statement("\"generator\"", None, 20).to_string(SqliteQueryBuilder);
        println!("{sql}");
        assert!(sql.contains("FROM \"nodes_fts\" CROSS JOIN \"nodes\""));
        assert!(sql.contains("MATCH"));
        assert!(sql.contains("bm25"));
    }

    #[test]
    fn like_statement_escapes_the_pattern() {
        let sql = like_statement("50%_off", None, 20).to_string(SqliteQueryBuilder);
        println!("{sql}");
        assert!(sql.contains("LIKE"));
        assert!(sql.contains("ESCAPE '\\'"));
    }
}
