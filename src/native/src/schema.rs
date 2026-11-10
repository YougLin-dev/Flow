//! Schema creation and the small virtual-table adapter.
//!
//! Ordinary tables come from the SeaORM entities. SQLite's FTS5 and RTree
//! tables are virtual tables with no ORM schema support, so their DDL lives
//! here, next to the migrations, and nowhere else.

use sea_orm::sea_query::Index;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, Schema, Set, Statement};

use crate::clock::now_ms;
use crate::constants::SCHEMA_VERSION;
use crate::entity::{
    assets, documents, edges, node_assets, node_inputs, nodes, result_batches, result_items,
    schema_migrations,
};

/// Every migration that this build knows, in order. Add a new entry here and
/// a matching arm in `apply_migration`.
const MIGRATIONS: &[i32] = &[1, 2, 3];

/// Migration 2 is the node editor's breaking reset: all document data is
/// discarded (the TSX side seeds the new example after opening).
const RESET_TABLES: &[&str] = &[
    "node_inputs",
    "result_items",
    "result_batches",
    "node_assets",
    "nodes_fts",
    "nodes_rtree",
    "edges_rtree",
    "assets_fts",
    "edges",
    "nodes",
    "assets",
    "documents",
];

/// Virtual tables cannot be expressed by `Schema::create_table_from_entity`.
/// Keep every virtual-table statement in this one list.
const VIRTUAL_TABLES: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_rtree USING rtree(id, min_x, max_x, min_y, max_y)",
    EDGES_RTREE,
    "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts \
     USING fts5(title, body, tags, tokenize = 'trigram')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts \
     USING fts5(id UNINDEXED, name, tags, tokenize = 'trigram')",
];

/// The connector index. Migration 3 creates it on a version 2 database and
/// fills it from the edge and node rows; `edge_index.rs` owns its contents.
const EDGES_RTREE: &str =
    "CREATE VIRTUAL TABLE IF NOT EXISTS edges_rtree USING rtree(id, min_x, max_x, min_y, max_y)";

pub fn migrate(conn: &DatabaseConnection) -> Result<(), String> {
    create_table(conn, schema_migrations::Entity).map_err(|error| error.to_string())?;
    // Check on every open, not only while applying migration 1: a P0 database
    // may already record version 1 and would otherwise pass the version guard
    // and fail later with a missing `seq` or virtual table.
    check_legacy_schema(conn).map_err(|error| error.to_string())?;

    let applied = schema_migrations::Entity::find()
        .all(conn)
        .map_err(|error| error.to_string())?;

    if let Some(row) = applied.iter().find(|row| row.version > SCHEMA_VERSION) {
        return Err(format!(
            "the database schema is newer ({}) than this app ({SCHEMA_VERSION})",
            row.version
        ));
    }

    for version in MIGRATIONS {
        if applied.iter().any(|row| row.version == *version) {
            continue;
        }
        apply_migration(conn, *version)?;
    }

    Ok(())
}

fn apply_migration(conn: &DatabaseConnection, version: i32) -> Result<(), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        match version {
            1 => migration_1(txn)?,
            2 => migration_2(txn)?,
            3 => migration_3(txn)?,
            _ => {
                return Err(DbErr::Custom(format!(
                    "unknown database migration {version}"
                )));
            }
        }

        schema_migrations::Entity::insert(schema_migrations::ActiveModel {
            version: Set(version),
            applied_at: Set(now_ms()),
        })
        .exec(txn)?;

        Ok(())
    })
    .map_err(|error| error.to_string())
}

fn migration_1<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    create_document_tables(conn)?;
    create_virtual_tables(conn)?;
    create_indexes(conn)?;
    Ok(())
}

/// The node editor's schema version: discard every document row and recreate
/// the tables with result batches, result items, node inputs and the node's
/// settings/status/output columns.
fn migration_2<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    for table in RESET_TABLES {
        conn.execute_unprepared(&format!("DROP TABLE IF EXISTS {table};"))?;
    }
    create_document_tables(conn)?;
    create_virtual_tables(conn)?;
    create_indexes(conn)?;
    Ok(())
}

/// The connector index: a connector whose curve crosses the viewport must be
/// read even when both of its cards are outside the node read, so each edge
/// gets the world box of its cubic. A version 2 database already holds edges,
/// so the index is filled from them in the same migration transaction.
fn migration_3<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    conn.execute_unprepared(EDGES_RTREE)?;
    crate::edge_index::backfill(conn)
}

fn create_document_tables<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    create_table(conn, documents::Entity)?;
    create_table(conn, nodes::Entity)?;
    create_table(conn, edges::Entity)?;
    create_table(conn, assets::Entity)?;
    create_table(conn, node_assets::Entity)?;
    create_table(conn, result_batches::Entity)?;
    create_table(conn, result_items::Entity)?;
    create_table(conn, node_inputs::Entity)?;
    Ok(())
}

fn create_table<C, E>(conn: &C, entity: E) -> Result<(), DbErr>
where
    C: ConnectionTrait,
    E: EntityTrait,
{
    let schema = Schema::new(conn.get_database_backend());
    let mut statement = schema.create_table_from_entity(entity);
    statement.if_not_exists();
    conn.execute(&statement)?;
    Ok(())
}

fn create_virtual_tables<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    for statement in VIRTUAL_TABLES {
        conn.execute_unprepared(statement)?;
    }
    Ok(())
}

fn create_indexes<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    let mut nodes_document = Index::create();
    nodes_document
        .if_not_exists()
        .name("nodes_document")
        .table(nodes::Entity)
        .col(nodes::Column::DocumentId);
    conn.execute(&nodes_document)?;

    let mut nodes_kind = Index::create();
    nodes_kind
        .if_not_exists()
        .name("nodes_kind")
        .table(nodes::Entity)
        .col(nodes::Column::DocumentId)
        .col(nodes::Column::Kind);
    conn.execute(&nodes_kind)?;

    let mut edges_from = Index::create();
    edges_from
        .if_not_exists()
        .name("edges_from")
        .table(edges::Entity)
        .col(edges::Column::FromId);
    conn.execute(&edges_from)?;

    let mut edges_to = Index::create();
    edges_to
        .if_not_exists()
        .name("edges_to")
        .table(edges::Entity)
        .col(edges::Column::ToId);
    conn.execute(&edges_to)?;

    let mut node_assets_asset = Index::create();
    node_assets_asset
        .if_not_exists()
        .name("node_assets_asset")
        .table(node_assets::Entity)
        .col(node_assets::Column::AssetId);
    conn.execute(&node_assets_asset)?;

    let mut batches_node = Index::create();
    batches_node
        .if_not_exists()
        .name("result_batches_node")
        .table(result_batches::Entity)
        .col(result_batches::Column::NodeId)
        .col(result_batches::Column::CreatedAt);
    conn.execute(&batches_node)?;

    let mut items_batch = Index::create();
    items_batch
        .if_not_exists()
        .name("result_items_batch")
        .table(result_items::Entity)
        .col(result_items::Column::BatchId)
        .col(result_items::Column::Position);
    conn.execute(&items_batch)?;

    let mut inputs_node = Index::create();
    inputs_node
        .if_not_exists()
        .name("node_inputs_node")
        .table(node_inputs::Entity)
        .col(node_inputs::Column::NodeId)
        .col(node_inputs::Column::Position);
    conn.execute(&inputs_node)?;

    let mut inputs_edge = Index::create();
    inputs_edge
        .if_not_exists()
        .name("node_inputs_edge")
        .table(node_inputs::Entity)
        .col(node_inputs::Column::EdgeId);
    conn.execute(&inputs_edge)?;

    let mut inputs_item = Index::create();
    inputs_item
        .if_not_exists()
        .name("node_inputs_item")
        .table(node_inputs::Entity)
        .col(node_inputs::Column::ItemId);
    conn.execute(&inputs_item)?;

    Ok(())
}

/// P0 stored `nodes.id` as the primary key. The ORM schema adds the internal
/// `seq` key used by the RTree and FTS indexes; refuse to silently reinterpret
/// an old development database.
fn check_legacy_schema<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    let statement = Statement::from_string(
        conn.get_database_backend(),
        "PRAGMA table_info(nodes)".to_owned(),
    );
    let columns = conn.query_all_raw(statement)?;
    if columns.is_empty() {
        return Ok(());
    }
    let has_seq = columns.iter().any(|row| {
        row.try_get::<String>("", "name")
            .is_ok_and(|name| name == "seq")
    });
    if has_seq {
        Ok(())
    } else {
        Err(DbErr::Custom(
            "the database was created by an older Flow build; delete it and reopen".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database};

    #[test]
    fn rejects_a_legacy_nodes_table_even_with_a_version_row() {
        let conn = Database::connect("sqlite::memory:").expect("open memory database");
        conn.execute_unprepared(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .expect("create migrations");
        conn.execute_unprepared(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)",
        )
        .expect("record version");
        conn.execute_unprepared("CREATE TABLE nodes (id TEXT PRIMARY KEY)")
            .expect("create legacy nodes");

        let error = migrate(&conn).expect_err("legacy schema must be rejected");
        assert!(error.contains("older Flow build"), "{error}");
    }

    #[test]
    fn migration_3_backfills_the_connector_index() {
        use crate::types::{NodeInput, Viewport};

        fn far(id: &str, x: f64) -> NodeInput {
            NodeInput {
                id: id.to_owned(),
                kind: "text".to_owned(),
                title: id.to_owned(),
                body: String::new(),
                tags: Vec::new(),
                x,
                y: 0.0,
                width: 200.0,
                height: 84.0,
                z: 0.0,
                data_json: None,
                settings_json: None,
            }
        }

        let conn = Database::connect("sqlite::memory:").expect("open memory database");
        create_table(&conn, schema_migrations::Entity).expect("create migrations");
        migration_1(&conn).expect("create version 1");
        conn.execute_unprepared(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0), (2, 0)",
        )
        .expect("record version 2");
        // A version 2 database predates the connector index.
        conn.execute_unprepared("DROP TABLE edges_rtree")
            .expect("drop the version 3 index");
        conn.execute_unprepared(
            "INSERT INTO documents (id, title, rev, created_at, updated_at) \
             VALUES ('default', 'Flow', 0, 0, 0)",
        )
        .expect("insert document");
        crate::mutation::insert_nodes(&conn, vec![far("left", -5_000.0), far("right", 5_000.0)])
            .expect("insert nodes");
        // Written without the new code's index maintenance, like a real
        // version 2 database.
        conn.execute_unprepared(
            "INSERT INTO edges (id, document_id, from_id, to_id, from_port, to_port, kind, data_json) \
             VALUES ('left-right', 'default', 'left', 'right', NULL, NULL, 'flow', '{}')",
        )
        .expect("insert edge");

        migrate(&conn).expect("upgrade to version 3");

        let scene = crate::scene::snapshot(
            &conn,
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            0.0,
            crate::viewport::NODE_LIMIT,
        )
        .expect("scene");
        assert!(scene.nodes.is_empty());
        assert_eq!(scene.edges.len(), 1);
        assert_eq!(
            scene.edges[0].from_point.map(|point| point.x),
            Some(-4_800.0)
        );
    }

    #[test]
    fn migration_2_discards_the_version_1_document() {
        use crate::types::NodeInput;
        use sea_orm::PaginatorTrait;

        let conn = Database::connect("sqlite::memory:").expect("open memory database");
        create_table(&conn, schema_migrations::Entity).expect("create migrations");
        migration_1(&conn).expect("create version 1");
        conn.execute_unprepared(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)",
        )
        .expect("record version");
        conn.execute_unprepared(
            "INSERT INTO documents (id, title, rev, created_at, updated_at) \
             VALUES ('default', 'Flow', 0, 0, 0)",
        )
        .expect("insert document");
        crate::mutation::insert_nodes(
            &conn,
            vec![NodeInput {
                id: "old".to_owned(),
                kind: "panel".to_owned(),
                title: "Old panel".to_owned(),
                body: String::new(),
                tags: Vec::new(),
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 84.0,
                z: 0.0,
                data_json: None,
                settings_json: None,
            }],
        )
        .expect("insert old node");

        migrate(&conn).expect("upgrade to version 2");

        assert_eq!(
            nodes::Entity::find()
                .count(&conn)
                .expect("count nodes after reset"),
            0
        );
        assert_eq!(
            result_batches::Entity::find()
                .count(&conn)
                .expect("count batches after reset"),
            0
        );
        assert_eq!(
            node_inputs::Entity::find()
                .count(&conn)
                .expect("count inputs after reset"),
            0
        );
    }
}
