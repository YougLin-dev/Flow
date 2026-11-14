//! Frozen release schema v1 and the project-file open guard.
//!
//! The DDL is a literal file (`v1.sql`), never generated from entities. The
//! guard runs before any DDL so a foreign SQLite file or a future schema is
//! refused without dropping anything. `create` is the only writer here.

use rusqlite::{Connection, OptionalExtension, params};

/// `0x464C4F57`, "FLOW".
pub const APPLICATION_ID: i64 = 1_179_406_167;

/// The only release schema version this build knows.
pub const USER_VERSION: i64 = 1;

/// The frozen v1 DDL, stored verbatim beside this module.
pub const DDL: &str = include_str!("v1.sql");

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

/// Sets the pragmas the schema and every write rely on, and asserts them.
pub fn configure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;")
        .map_err(|error| error.to_string())?;
    let foreign_keys: i64 = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if foreign_keys != 1 {
        return Err("SQLite refused PRAGMA foreign_keys = ON".to_owned());
    }
    Ok(())
}

/// Inspects a file without changing it.
///
/// A new empty file returns [`FileState::New`]. Anything that is not a v1
/// Flow package is an error: a foreign file, a newer schema, an older schema,
/// an incomplete database or an invalid document row.
pub fn inspect(conn: &Connection) -> Result<FileState, String> {
    let application_id: i64 = conn
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let user_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let user_tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    if application_id == 0 {
        if user_version == 0 && user_tables == 0 {
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

    let row = conn
        .query_row(
            "SELECT project_id, title, camera_x, camera_y, camera_zoom \
             FROM document WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("the Flow database is incomplete: {error}"))?
        .ok_or_else(|| "the Flow database has no document row".to_owned())?;

    // The CHECK constraints and trigger enforce this on ordinary writes; the
    // guard rechecks it so a direct schema edit cannot smuggle a bad identity.
    if !is_project_id(&row.0) {
        return Err("the Flow database has an invalid project_id".to_owned());
    }
    if row.1.trim().is_empty() {
        return Err("the Flow database has an empty title".to_owned());
    }
    if !row.2.is_finite() || !row.3.is_finite() || !row.4.is_finite() || row.4 <= 0.0 {
        return Err("the Flow database has an invalid camera".to_owned());
    }

    Ok(FileState::Current(ProjectInfo {
        project_id: row.0,
        title: row.1,
    }))
}

/// Creates a v1 package in one transaction and returns its identity.
pub fn create(conn: &Connection, title: &str) -> Result<ProjectInfo, String> {
    if title.trim().is_empty() {
        return Err("the project title is empty".to_owned());
    }
    match inspect(conn)? {
        FileState::New => {}
        FileState::Current(_) => {
            return Err("the database is already a Flow project".to_owned());
        }
    }

    configure(conn)?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    match create_in_transaction(conn, title) {
        Ok(project) => {
            conn.execute_batch("COMMIT")
                .map_err(|error| error.to_string())?;
            Ok(project)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn create_in_transaction(conn: &Connection, title: &str) -> Result<ProjectInfo, String> {
    conn.execute_batch(DDL).map_err(|error| error.to_string())?;
    let project_id: String = conn
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let now = crate::clock::now_ms();
    conn.execute(
        "INSERT INTO document (id, project_id, title, created_at, updated_at) \
         VALUES (1, ?1, ?2, ?3, ?3)",
        params![project_id, title, now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute_batch(&format!(
        "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"
    ))
    .map_err(|error| error.to_string())?;
    Ok(ProjectInfo {
        project_id,
        title: title.to_owned(),
    })
}

fn is_project_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory SQLite");
        configure(&conn).expect("configure in-memory SQLite");
        conn
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table_info");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info");
        rows.map(Result::unwrap).collect()
    }

    fn objects(conn: &Connection, kind: &str) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name")
            .expect("prepare sqlite_master read");
        let rows = statement
            .query_map([kind], |row| row.get::<_, String>(0))
            .expect("query sqlite_master");
        rows.map(Result::unwrap).collect()
    }

    fn pragma(conn: &Connection, name: &str) -> i64 {
        conn.pragma_query_value(None, name, |row| row.get(0))
            .expect("read pragma")
    }

    #[test]
    fn create_applies_v1_and_mints_identity() {
        let conn = memory();
        let project = create(&conn, "Test project").expect("create v1");

        assert_eq!(project.title, "Test project");
        assert_eq!(project.project_id.len(), 32);
        assert!(is_project_id(&project.project_id));
        assert_eq!(pragma(&conn, "application_id"), APPLICATION_ID);
        assert_eq!(pragma(&conn, "user_version"), USER_VERSION);

        let (title, camera_x, camera_y, camera_zoom, demo_seeded, clean_shutdown): (
            String,
            f64,
            f64,
            f64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT title, camera_x, camera_y, camera_zoom, demo_seeded, clean_shutdown \
                 FROM document WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("read document");
        assert_eq!(title, "Test project");
        assert_eq!((camera_x, camera_y, camera_zoom), (0.0, 0.0, 1.0));
        assert_eq!((demo_seeded, clean_shutdown), (0, 0));
        assert_eq!(inspect(&conn), Ok(FileState::Current(project)));
    }

    #[test]
    fn v1_shape_has_the_release_tables_and_columns() {
        let conn = memory();
        create(&conn, "Shape").expect("create v1");

        let tables = objects(&conn, "table");
        for table in [
            "assets",
            "document",
            "edges",
            "node_inputs",
            "nodes",
            "nodes_fts",
            "nodes_geometry_dirty",
            "nodes_rtree",
            "result_batches",
            "result_items",
        ] {
            assert!(tables.iter().any(|name| name == table), "missing {table}");
        }
        assert!(
            objects(&conn, "view")
                .iter()
                .any(|name| name == "edge_boxes")
        );

        assert_eq!(
            columns(&conn, "document"),
            [
                "id",
                "project_id",
                "title",
                "rev",
                "node_count",
                "edge_count",
                "demo_seeded",
                "clean_shutdown",
                "min_x",
                "max_x",
                "min_y",
                "max_y",
                "bounds_exact",
                "camera_x",
                "camera_y",
                "camera_zoom",
                "created_at",
                "updated_at",
            ]
        );

        let nodes = columns(&conn, "nodes");
        for column in [
            "seq",
            "id",
            "title",
            "body",
            "tags",
            "status",
            "output_batch_id",
        ] {
            assert!(
                nodes.iter().any(|name| name == column),
                "missing nodes.{column}"
            );
        }
        assert!(!nodes.iter().any(|name| name == "document_id"));
        assert!(!nodes.iter().any(|name| name == "tags_json"));

        assert!(
            !columns(&conn, "edges")
                .iter()
                .any(|name| name == "document_id")
        );
        assert!(
            columns(&conn, "result_batches")
                .iter()
                .any(|name| name == "node_seq")
        );
        assert!(
            columns(&conn, "result_batches")
                .iter()
                .any(|name| name == "item_count")
        );
        assert!(
            columns(&conn, "result_items")
                .iter()
                .any(|name| name == "asset_id")
        );
        assert!(
            columns(&conn, "node_inputs")
                .iter()
                .any(|name| name == "edge_id")
        );
        assert!(columns(&conn, "assets").iter().any(|name| name == "hash"));

        let indexes = objects(&conn, "index");
        for index in [
            "nodes_sample",
            "nodes_running",
            "nodes_output",
            "edges_port_pair",
            "edges_to",
            "result_batches_node",
            "result_batches_latest",
            "result_batches_running",
            "result_items_asset",
            "node_inputs_edge",
            "node_inputs_item",
            "node_inputs_asset",
        ] {
            assert!(indexes.iter().any(|name| name == index), "missing {index}");
        }

        let triggers = objects(&conn, "trigger");
        for trigger in [
            "document_no_delete",
            "document_rev_monotonic",
            "document_project_id_immutable",
            "nodes_no_replace",
            "edges_no_replace",
            "result_batches_insert_running",
            "result_items_running_only",
            "nodes_rtree_ai",
            "edges_rtree_ai",
            "nodes_fts_ai",
        ] {
            assert!(
                triggers.iter().any(|name| name == trigger),
                "missing {trigger}"
            );
        }

        let fts: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'",
                [],
                |row| row.get(0),
            )
            .expect("read nodes_fts SQL");
        assert!(fts.contains("content = 'nodes'") || fts.contains("content='nodes'"));
        assert!(fts.contains("content_rowid = 'seq'") || fts.contains("content_rowid='seq'"));
    }

    #[test]
    fn inspect_reports_new_then_current() {
        let conn = memory();
        assert_eq!(inspect(&conn), Ok(FileState::New));
        let project = create(&conn, "Identity").expect("create v1");
        assert_eq!(inspect(&conn), Ok(FileState::Current(project.clone())));
        assert_eq!(pragma(&conn, "application_id"), APPLICATION_ID);
        assert_eq!(pragma(&conn, "user_version"), USER_VERSION);
    }

    #[test]
    fn inspect_refuses_a_foreign_database() {
        let conn = memory();
        conn.execute_batch("CREATE TABLE notes (body TEXT)")
            .expect("create foreign table");
        let error = inspect(&conn).expect_err("foreign database must be refused");
        assert!(error.contains("not a Flow database"), "{error}");
        assert!(objects(&conn, "table").iter().any(|name| name == "notes"));
    }

    #[test]
    fn inspect_refuses_a_newer_schema() {
        let conn = memory();
        create(&conn, "Newer").expect("create v1");
        conn.execute_batch("PRAGMA user_version = 2")
            .expect("bump version");
        let error = inspect(&conn).expect_err("newer schema must be refused");
        assert!(error.contains("newer"), "{error}");
    }

    #[test]
    fn inspect_refuses_an_incomplete_flow_database() {
        let conn = memory();
        conn.execute_batch(DDL).expect("apply DDL");
        conn.execute_batch(&format!(
            "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"
        ))
        .expect("stamp identity");
        let error = inspect(&conn).expect_err("missing document row must be refused");
        assert!(error.contains("document"), "{error}");
    }

    #[test]
    fn create_refuses_a_foreign_database_without_dropping_it() {
        let conn = memory();
        conn.execute_batch("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep')")
            .expect("create foreign table");
        let error = create(&conn, "Refused").expect_err("foreign database must be refused");
        assert!(error.contains("not a Flow database"), "{error}");
        let kept: String = conn
            .query_row("SELECT body FROM notes", [], |row| row.get(0))
            .expect("foreign row survives");
        assert_eq!(kept, "keep");
        assert!(objects(&conn, "table").iter().any(|name| name == "notes"));
        assert!(
            !objects(&conn, "table")
                .iter()
                .any(|name| name == "document")
        );
    }

    #[test]
    fn project_id_and_camera_checks_are_enforced() {
        let conn = memory();
        conn.execute_batch(DDL).expect("apply DDL");
        let now = crate::clock::now_ms();
        let bad_id = conn.execute(
            "INSERT INTO document (id, project_id, created_at, updated_at) VALUES (1, 'short', ?1, ?1)",
            params![now],
        );
        assert!(bad_id.is_err(), "short project_id must fail");

        let bad_camera = conn.execute(
            "INSERT INTO document (id, project_id, camera_zoom, created_at, updated_at) \
             VALUES (1, '0123456789abcdef0123456789abcdef', 0, ?1, ?1)",
            params![now],
        );
        assert!(bad_camera.is_err(), "non-positive camera_zoom must fail");

        conn.execute(
            "INSERT INTO document (id, project_id, created_at, updated_at) \
             VALUES (1, '0123456789abcdef0123456789abcdef', ?1, ?1)",
            params![now],
        )
        .expect("insert a valid document");
        let bad_update = conn.execute("UPDATE document SET camera_zoom = 0 WHERE id = 1", []);
        assert!(bad_update.is_err(), "camera_zoom update must fail");
    }

    #[test]
    fn document_is_immutable_in_the_expected_ways() {
        let conn = memory();
        create(&conn, "Immutable").expect("create v1");
        let delete = conn.execute("DELETE FROM document", []);
        assert!(delete.is_err(), "document delete must fail");
        let replace = conn.execute(
            "UPDATE document SET project_id = 'ffffffffffffffffffffffffffffffff'",
            [],
        );
        assert!(replace.is_err(), "project_id update must fail");
    }

    #[test]
    fn create_requires_a_non_empty_title() {
        let conn = memory();
        let error = create(&conn, "   ").expect_err("empty title must be refused");
        assert!(error.contains("title"), "{error}");
        assert_eq!(inspect(&conn), Ok(FileState::New));
    }
}
