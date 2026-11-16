//! Frozen release schema v1 and the project-file open guard.
//!
//! The DDL is a literal file (`v1.sql`), never generated from entities. The
//! guard runs before any DDL so a foreign SQLite file or a future schema is
//! refused without dropping anything. `create` is the only writer here. The
//! module uses the same SeaORM connection surface as the live database so the
//! guard can run on the production handle without a second implementation.

use sea_orm::{ConnectionTrait, DbBackend, Statement, Value};

/// `0x464C4F57`, "FLOW".
pub const APPLICATION_ID: i64 = 1_179_406_167;

/// The v1 file version stored in `PRAGMA user_version`.
pub const USER_VERSION: i64 = 1;

/// The frozen v1 DDL, stored verbatim beside this module.
pub const MIGRATION_1: &str = include_str!("v1.sql");

/// The frozen identity trigger, byte for byte, as `sqlite_master` stores it
/// (without the trailing semicolon). Rekeying a copied package drops the
/// trigger, updates the row and recreates this text; the containment test
/// below fails if the constant and `v1.sql` ever drift.
pub(crate) const PROJECT_ID_TRIGGER: &str =
    "CREATE TRIGGER document_project_id_immutable BEFORE UPDATE OF project_id ON document
WHEN NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'document.project_id is immutable');
END";

/// Objects an opened v1 package must contain. `verify()` checks their
/// contents; the open guard only proves they exist.
const REQUIRED_OBJECTS: &[(&str, &str)] = &[
    ("table", "document"),
    ("table", "assets"),
    ("table", "result_batches"),
    ("table", "nodes"),
    ("table", "edges"),
    ("table", "result_items"),
    ("table", "node_inputs"),
    ("table", "nodes_geometry_dirty"),
    ("table", "nodes_rtree"),
    ("table", "edges_rtree"),
    ("table", "nodes_fts"),
    ("view", "edge_boxes"),
    ("index", "nodes_sample"),
    ("index", "nodes_running"),
    ("index", "nodes_output"),
    ("index", "edges_port_pair"),
    ("index", "edges_to"),
    ("index", "result_batches_node"),
    ("index", "result_batches_latest"),
    ("index", "result_batches_running"),
    ("index", "result_items_asset"),
    ("index", "node_inputs_edge"),
    ("index", "node_inputs_item"),
    ("index", "node_inputs_asset"),
    ("trigger", "document_no_delete"),
    ("trigger", "document_rev_monotonic"),
    ("trigger", "document_project_id_immutable"),
    ("trigger", "document_no_replace"),
    ("trigger", "nodes_no_replace"),
    ("trigger", "nodes_identity_immutable"),
    ("trigger", "edges_no_replace"),
    ("trigger", "edges_identity_immutable"),
    ("trigger", "edges_no_duplicate_update"),
    ("trigger", "nodes_rev_monotonic"),
    ("trigger", "nodes_output_done_bi"),
    ("trigger", "nodes_output_done_bu"),
    ("trigger", "result_batches_owner_bi"),
    ("trigger", "result_batches_insert_running"),
    ("trigger", "result_batches_done_item"),
    ("trigger", "result_batches_terminal_immutable"),
    ("trigger", "result_batches_running_delete"),
    ("trigger", "result_batches_item_count_consistent"),
    ("trigger", "result_items_running_only"),
    ("trigger", "result_items_no_update"),
    ("trigger", "result_items_delete_guard"),
    ("trigger", "result_items_count_ai"),
    ("trigger", "result_items_count_ad"),
    ("trigger", "node_inputs_edge_shape_bi"),
    ("trigger", "node_inputs_edge_shape_bu"),
    ("trigger", "nodes_count_bounds_ai"),
    ("trigger", "nodes_count_bounds_ad"),
    ("trigger", "nodes_bounds_au"),
    ("trigger", "edges_count_ai"),
    ("trigger", "edges_count_ad"),
    ("trigger", "nodes_rtree_ai"),
    ("trigger", "nodes_rtree_au"),
    ("trigger", "nodes_rtree_ad"),
    ("trigger", "nodes_geometry_dirty_au"),
    ("trigger", "nodes_geometry_dirty_ad"),
    ("trigger", "edges_rtree_ai"),
    ("trigger", "edges_rtree_au"),
    ("trigger", "edges_rtree_ad"),
    ("trigger", "nodes_fts_ai"),
    ("trigger", "nodes_fts_ad"),
    ("trigger", "nodes_fts_au"),
];

/// The identity carried by the singleton `document` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectInfo {
    pub project_id: String,
    pub title: String,
}

/// What an opened SQLite file is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileState {
    /// An empty file with no Flow identity; safe to create a v1 package.
    New,
    /// A v1 Flow package with a valid document row.
    Current(ProjectInfo),
}

/// Sets the schema-context pragmas and asserts them. Connection tuning
/// (`busy_timeout`, `cache_size`, WAL, `synchronous`) stays in `db/worker.rs` until
/// the legacy and v1 open paths merge.
pub fn configure<C: ConnectionTrait>(conn: &C) -> Result<(), String> {
    conn.execute_unprepared("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;")
        .map_err(|error| error.to_string())?;
    if pragma(conn, "foreign_keys")? != 1 {
        return Err("SQLite refused PRAGMA foreign_keys = ON".to_owned());
    }
    if pragma(conn, "recursive_triggers")? != 0 {
        return Err("SQLite refused PRAGMA recursive_triggers = OFF".to_owned());
    }
    Ok(())
}

/// Inspects a file without changing it.
///
/// A new empty file returns [`FileState::New`]. Anything that is not a v1
/// Flow package is an error: a foreign file, a newer or older schema, a
/// missing schema object, or an invalid document row. The caller adds the
/// package path and the recovery suggestion (`verify()` or a reset/deletion);
/// this function sees only the connection.
pub fn inspect<C: ConnectionTrait>(conn: &C) -> Result<FileState, String> {
    let application_id = pragma(conn, "application_id")?;
    let user_version = pragma(conn, "user_version")?;
    let user_objects = scalar_i64(
        conn,
        "SELECT count(*) FROM sqlite_master \
         WHERE type IN ('table', 'view') \
           AND substr(name, 1, 7) <> 'sqlite_'",
        vec![],
    )?;

    if application_id == 0 {
        if user_version == 0 && user_objects == 0 {
            return Ok(FileState::New);
        }
        return Err("not a Flow database: application_id is not set".to_owned());
    }
    if application_id != APPLICATION_ID {
        return Err(format!(
            "not a Flow database: application_id {application_id} is not {APPLICATION_ID}"
        ));
    }
    if user_version > USER_VERSION {
        return Err(format!(
            "the database schema is newer ({user_version}) than this app ({USER_VERSION})"
        ));
    }
    if user_version < USER_VERSION {
        return Err(format!(
            "the database schema is older ({user_version}) than this app ({USER_VERSION}); reset the project"
        ));
    }

    require_objects(conn)?;

    let row = conn
        .query_one_raw(statement(
            "SELECT project_id, title, camera_x, camera_y, camera_zoom \
             FROM document WHERE id = 1",
        ))
        .map_err(incomplete)?
        .ok_or_else(|| "the Flow database has no document row".to_owned())?;
    let project_id: String = row.try_get_by_index(0).map_err(incomplete)?;
    let title: String = row.try_get_by_index(1).map_err(incomplete)?;
    let camera_x: f64 = row.try_get_by_index(2).map_err(incomplete)?;
    let camera_y: f64 = row.try_get_by_index(3).map_err(incomplete)?;
    let camera_zoom: f64 = row.try_get_by_index(4).map_err(incomplete)?;

    validate_document(project_id, title, camera_x, camera_y, camera_zoom).map(FileState::Current)
}

/// Creates a v1 package in one transaction and returns its identity.
pub fn create<C: ConnectionTrait>(conn: &C, title: &str) -> Result<ProjectInfo, String> {
    create_with(conn, title, false)
}

/// Creates a v1 package like [`create`], recording whether the initial-content
/// decision was already made. A managed blank project passes `true` so the
/// legacy auto-seed does not fill it; a project that is about to receive seed
/// data passes `false`, which [`crate::mutation::seed_document`] flips once the
/// content is written.
pub(crate) fn create_with<C: ConnectionTrait>(
    conn: &C,
    title: &str,
    demo_seeded: bool,
) -> Result<ProjectInfo, String> {
    validate_title(title)?;
    match inspect(conn)? {
        FileState::New => {}
        FileState::Current(_) => {
            return Err("the database is already a Flow project".to_owned());
        }
    }

    configure(conn)?;
    // BEGIN IMMEDIATE takes the write lock up front. The transaction is
    // issued as SQL rather than through SeaORM's DatabaseTransaction, whose
    // drop panics if an implicit ROLLBACK fails and would replace the create
    // error. SQLite rolls back on the fatal errors where ROLLBACK cannot run.
    conn.execute_unprepared("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    match create_in_transaction(conn, title, demo_seeded) {
        Ok(project) => {
            if let Err(error) = conn.execute_unprepared("COMMIT") {
                let _ = conn.execute_unprepared("ROLLBACK");
                return Err(error.to_string());
            }
            Ok(project)
        }
        Err(error) => {
            let _ = conn.execute_unprepared("ROLLBACK");
            Err(error)
        }
    }
}

fn create_in_transaction<C: ConnectionTrait>(
    conn: &C,
    title: &str,
    demo_seeded: bool,
) -> Result<ProjectInfo, String> {
    match inspect(conn)? {
        FileState::New => {}
        FileState::Current(_) => {
            return Err("the database is already a Flow project".to_owned());
        }
    }
    conn.execute_unprepared(MIGRATION_1)
        .map_err(|error| error.to_string())?;
    let project_id = mint_project_id(conn)?;
    let now = crate::clock::now_ms();
    conn.execute_raw(statement_values(
        "INSERT INTO document (id, project_id, title, created_at, updated_at, demo_seeded) \
         VALUES (1, ?1, ?2, ?3, ?3, ?4)",
        vec![
            project_id.clone().into(),
            title.to_owned().into(),
            now.into(),
            (if demo_seeded { 1i64 } else { 0i64 }).into(),
        ],
    ))
    .map_err(|error| error.to_string())?;
    conn.execute_unprepared(&format!(
        "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"
    ))
    .map_err(|error| error.to_string())?;
    Ok(ProjectInfo {
        project_id,
        title: title.to_owned(),
    })
}

fn require_objects<C: ConnectionTrait>(conn: &C) -> Result<(), String> {
    for (kind, name) in REQUIRED_OBJECTS {
        let present = conn
            .query_one_raw(statement_values(
                "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2",
                vec![(*kind).into(), (*name).into()],
            ))
            .map_err(|error| error.to_string())?
            .is_some();
        if !present {
            return Err(format!(
                "the Flow database is incomplete: missing {kind} {name}"
            ));
        }
    }
    Ok(())
}

fn pragma<C: ConnectionTrait>(conn: &C, name: &str) -> Result<i64, String> {
    let row = conn
        .query_one_raw(statement(format!("PRAGMA {name}")))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("PRAGMA {name} returned no row"))?;
    row.try_get_by_index(0).map_err(|error| error.to_string())
}

fn scalar_i64<C: ConnectionTrait>(conn: &C, sql: &str, values: Vec<Value>) -> Result<i64, String> {
    let row = conn
        .query_one_raw(statement_values(sql, values))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the query returned no row".to_owned())?;
    row.try_get_by_index(0).map_err(|error| error.to_string())
}

fn scalar_string<C: ConnectionTrait>(
    conn: &C,
    sql: &str,
    values: Vec<Value>,
) -> Result<String, String> {
    let row = conn
        .query_one_raw(statement_values(sql, values))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the query returned no row".to_owned())?;
    row.try_get_by_index(0).map_err(|error| error.to_string())
}

fn statement(sql: impl Into<String>) -> Statement {
    Statement::from_string(DbBackend::Sqlite, sql)
}

fn statement_values(sql: impl Into<String>, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Sqlite, sql, values)
}

fn incomplete(error: impl std::fmt::Display) -> String {
    format!("the Flow database is incomplete: {error}")
}

fn validate_document(
    project_id: String,
    title: String,
    camera_x: f64,
    camera_y: f64,
    camera_zoom: f64,
) -> Result<ProjectInfo, String> {
    // The CHECK constraints and triggers enforce this on ordinary writes; the
    // guard rechecks it so a direct schema edit cannot smuggle a bad identity.
    if !is_project_id(&project_id) {
        return Err("the Flow database has an invalid project_id".to_owned());
    }
    if title.contains('\0') {
        return Err("the Flow database has an invalid title".to_owned());
    }
    if is_blank_title(&title) {
        return Err("the Flow database has an empty title".to_owned());
    }
    if !is_valid_camera(camera_x, camera_y, camera_zoom) {
        return Err("the Flow database has an invalid camera".to_owned());
    }
    Ok(ProjectInfo { project_id, title })
}

/// The title rule shared by create, rename and import: no NUL and, after the
/// DDL's ASCII-space trimming, not empty.
pub(crate) fn validate_title(title: &str) -> Result<(), String> {
    if title.contains('\0') {
        return Err("the project title is invalid".to_owned());
    }
    if is_blank_title(title) {
        return Err("the project title is empty".to_owned());
    }
    Ok(())
}

/// Mints a fresh package identity: 16 random bytes as 32 lowercase hex.
pub(crate) fn mint_project_id<C: ConnectionTrait>(conn: &C) -> Result<String, String> {
    scalar_string(conn, "SELECT lower(hex(randomblob(16)))", vec![])
}

/// Mirrors the DDL's `trim(title, ' ' || char(9) || char(10) || char(13))`.
fn is_blank_title(title: &str) -> bool {
    title
        .trim_matches(|character: char| matches!(character, ' ' | '\t' | '\n' | '\r'))
        .is_empty()
}

/// Mirrors the DDL's camera CHECKs: finite and inside the frozen envelope.
pub(crate) fn is_valid_camera(x: f64, y: f64, zoom: f64) -> bool {
    x.is_finite()
        && (-1.0e308..=1.0e308).contains(&x)
        && y.is_finite()
        && (-1.0e308..=1.0e308).contains(&y)
        && zoom.is_finite()
        && zoom > 0.0
        && zoom < 1.0e308
}

pub(crate) fn is_project_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests;
