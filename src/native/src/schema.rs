//! Schema creation and the small virtual-table adapter.
//!
//! Ordinary tables come from the SeaORM entities. SQLite's FTS5 and RTree
//! tables are virtual tables with no ORM schema support, so their DDL lives
//! here, next to the migrations, and nowhere else.

use sea_orm::sea_query::Index;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, Schema, Set, Statement};

use crate::clock::now_ms;
use crate::constants::SCHEMA_VERSION;
use crate::entity::{assets, documents, edges, node_assets, nodes, schema_migrations};

/// Every migration that this build knows, in order. Add a new entry here and
/// a matching arm in `apply_migration`.
const MIGRATIONS: &[i32] = &[1];

/// Virtual tables cannot be expressed by `Schema::create_table_from_entity`.
/// Keep every virtual-table statement in this one list.
const VIRTUAL_TABLES: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_rtree USING rtree(id, min_x, max_x, min_y, max_y)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts \
     USING fts5(title, body, tags, tokenize = 'trigram')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts \
     USING fts5(id UNINDEXED, name, tags, tokenize = 'trigram')",
];

pub fn migrate(conn: &DatabaseConnection) -> Result<(), String> {
    create_table(conn, schema_migrations::Entity).map_err(|error| error.to_string())?;

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
    check_legacy_schema(conn)?;
    create_document_tables(conn)?;
    create_virtual_tables(conn)?;
    create_indexes(conn)?;
    Ok(())
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
