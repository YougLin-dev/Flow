//! Query-plan assertions for hot read and write paths.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

fn explain_plan(conn: &DatabaseConnection, built: sea_orm::Statement) -> String {
    let statement = sea_orm::Statement {
        sql: format!("EXPLAIN QUERY PLAN {}", built.sql),
        values: built.values,
        db_backend: built.db_backend,
    };
    let rows = conn.query_all_raw(statement).expect("explain query plan");
    rows.iter()
        .map(|row| row.try_get::<String>("", "detail").expect("plan detail"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn running_work_queries_use_partial_indexes() {
    let conn = open_connection(":memory:", OpenMode::Create)
        .expect("open memory database")
        .conn;
    let nodes_statement = node_rows::Entity::find()
        .filter(node_rows::Column::Status.eq("running"))
        .select_only()
        .column(node_rows::Column::Id)
        .build(conn.get_database_backend());
    let nodes_plan = explain_plan(&conn, nodes_statement);
    assert!(
        nodes_plan.contains("nodes_running"),
        "the nodes recovery query uses its partial index: {nodes_plan}"
    );

    let batches_statement = result_batches::Entity::update_many()
        .col_expr(result_batches::Column::Status, Expr::value("interrupted"))
        .filter(result_batches::Column::Status.eq("running"))
        .build(conn.get_database_backend());
    let batches_plan = explain_plan(&conn, batches_statement);
    assert!(
        batches_plan.contains("result_batches_running"),
        "the batch recovery query uses its partial index: {batches_plan}"
    );
}

#[test]
fn geometry_flush_queries_drive_from_the_dirty_markers() {
    let conn = open_connection(":memory:", OpenMode::Create)
        .expect("open memory database")
        .conn;
    for sql in [
        crate::edge_index::dirty_edge_delete_statement(),
        crate::edge_index::dirty_edge_insert_statement(),
    ] {
        let plan = explain_plan(
            &conn,
            sea_orm::Statement::from_string(conn.get_database_backend(), sql.clone()),
        );
        assert!(
            plan.contains("edges_port_pair") && plan.contains("edges_to"),
            "the incident-edge predicate is a MULTI-INDEX OR: {sql}\n{plan}"
        );
        assert!(
            !plan.contains("SCAN e USING COVERING INDEX edges_port_pair"),
            "the flush must not scan every edge: {sql}\n{plan}"
        );
    }
}

#[test]
fn overview_sample_uses_the_sample_index() {
    let conn = open_connection(":memory:", OpenMode::Create)
        .expect("open memory database")
        .conn;
    let statement = viewport::overview_statement(100_000, 400);
    let (sql, values) = statement.build(sea_orm::sea_query::SqliteQueryBuilder);
    let plan = explain_plan(
        &conn,
        sea_orm::Statement {
            sql,
            values: Some(values),
            db_backend: conn.get_database_backend(),
        },
    );
    assert!(
        plan.contains("nodes_sample"),
        "the minimap sample uses its expression index: {plan}"
    );
    assert!(
        !plan.contains("SCAN nodes") && !plan.contains("USE TEMP B-TREE FOR ORDER BY"),
        "the minimap sample must not scan and sort the whole document: {plan}"
    );
}
