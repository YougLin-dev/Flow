//! Dev-only destructive reset of the open package.
//!
//! Recreates the frozen v1 objects and restores the captured project identity
//! in one transaction. The caller parks the asset directory around this call;
//! nothing here touches files. There is no migration path from an older schema
//! to reset: `DROP` plus the frozen DDL is only valid because v1 is the first
//! release schema.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, Set};

use crate::clock::now_ms;
use crate::document;
use crate::entity::document as document_row;
use crate::schema::v1;

/// Child tables and virtual tables first: dropping a parent with foreign keys
/// enabled performs an implicit delete that would violate a RESTRICT edge.
const DROP_OBJECTS: &str = "\
DROP VIEW IF EXISTS edge_boxes;
DROP TABLE IF EXISTS nodes_fts;
DROP TABLE IF EXISTS nodes_rtree;
DROP TABLE IF EXISTS edges_rtree;
DROP TABLE IF EXISTS node_inputs;
DROP TABLE IF EXISTS result_items;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS result_batches;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS nodes_geometry_dirty;
DROP TABLE IF EXISTS document;
";

/// Drops the v1 objects and recreates them with one fresh `document` row.
/// `project_id` and `created_at` survive; the title is the project's title and
/// content, history, camera and the seed flag start empty.
pub fn reset_schema(
    conn: &DatabaseConnection,
    project_id: &str,
    title: &str,
    created_at: i64,
) -> Result<(), String> {
    let project_id = project_id.to_owned();
    let title = title.to_owned();
    conn.transaction::<_, (), DbErr>(|txn| {
        txn.execute_unprepared(DROP_OBJECTS)?;
        txn.execute_unprepared(v1::MIGRATION_1)?;
        document_row::Entity::insert(document_row::ActiveModel {
            id: Set(document::ROW_ID),
            project_id: Set(project_id.clone()),
            title: Set(title.clone()),
            created_at: Set(created_at),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;
        Ok(())
    })
    .map_err(|error| format!("the document reset failed: {error}"))
}
