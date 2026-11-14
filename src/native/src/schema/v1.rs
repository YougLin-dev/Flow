//! Frozen release schema v1 and the project-file open guard.
//!
//! The DDL is a literal file (`v1.sql`), never generated from entities. The
//! guard runs before any DDL so a foreign SQLite file or a future schema is
//! refused without dropping anything. `create` is the only writer here.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

/// `0x464C4F57`, "FLOW".
pub const APPLICATION_ID: i64 = 1_179_406_167;

/// The v1 file version. `constants::SCHEMA_VERSION` is the legacy v5 ledger
/// until the live open path switches to v1.
pub const USER_VERSION: i64 = 1;

/// The frozen v1 DDL, stored verbatim beside this module.
pub const MIGRATION_1: &str = include_str!("v1.sql");

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
/// (`busy_timeout`, `cache_size`, WAL, `synchronous`) stays in `db.rs` until
/// the legacy and v1 open paths merge.
pub fn configure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;")
        .map_err(|error| error.to_string())?;
    let foreign_keys: i64 = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let recursive_triggers: i64 = conn
        .pragma_query_value(None, "recursive_triggers", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if foreign_keys != 1 {
        return Err("SQLite refused PRAGMA foreign_keys = ON".to_owned());
    }
    if recursive_triggers != 0 {
        return Err("SQLite refused PRAGMA recursive_triggers = OFF".to_owned());
    }
    Ok(())
}

/// Inspects a file without changing it.
///
/// A new empty file returns [`FileState::New`]. Anything that is not a v1
/// Flow package is an error: a foreign file, a newer or older schema, a
/// missing schema object, or an invalid document row. The caller adds the
/// package path to the message; this function sees only the connection.
pub fn inspect(conn: &Connection) -> Result<FileState, String> {
    let application_id: i64 = conn
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let user_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let user_objects: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master \
             WHERE type IN ('table', 'view') \
               AND substr(name, 1, 7) <> 'sqlite_'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

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

    validate_document(row.0, row.1, row.2, row.3, row.4).map(FileState::Current)
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
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let project = create_in_transaction(&transaction, title)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(project)
}

fn create_in_transaction(conn: &Connection, title: &str) -> Result<ProjectInfo, String> {
    conn.execute_batch(MIGRATION_1)
        .map_err(|error| error.to_string())?;
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

fn require_objects(conn: &Connection) -> Result<(), String> {
    for (kind, name) in REQUIRED_OBJECTS {
        let present = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2",
                params![kind, name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if present.is_none() {
            return Err(format!(
                "the Flow database is incomplete: missing {kind} {name}"
            ));
        }
    }
    Ok(())
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
    if title.trim().is_empty() {
        return Err("the Flow database has an empty title".to_owned());
    }
    if !camera_x.is_finite()
        || !camera_y.is_finite()
        || !camera_zoom.is_finite()
        || camera_zoom <= 0.0
    {
        return Err("the Flow database has an invalid camera".to_owned());
    }
    Ok(ProjectInfo { project_id, title })
}

fn is_project_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDb {
        path: PathBuf,
    }

    impl TempDb {
        fn new(label: &str) -> Self {
            let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("flow-v1-{label}-{}-{count}.db", std::process::id()));
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(sidecar(&path, suffix));
            }
            Self { path }
        }

        fn open(&self) -> Connection {
            let conn = Connection::open(&self.path).expect("open temp database");
            configure(&conn).expect("configure temp database");
            conn
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(sidecar(&self.path, suffix));
            }
        }
    }

    fn sidecar(path: &Path, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{suffix}", path.display()))
    }

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

    fn normalize_sql(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn insert_node(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO nodes (id, kind, title, x, y, width, height, z, created_at, updated_at) \
             VALUES (?1, 'text', ?2, 0, 0, 100, 50, 0, 0, 0)",
            params![id, title],
        )
        .expect("insert node");
    }

    fn insert_edge(conn: &Connection, id: &str, from: &str, to: &str) {
        conn.execute(
            "INSERT INTO edges (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
             VALUES (?1, ?2, ?3, 'out', 'in', 'text', 0, 0)",
            params![id, from, to],
        )
        .expect("insert edge");
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0))
            .expect("count rows")
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
    fn create_persists_across_reopen() {
        let temp = TempDb::new("persist");
        let project = {
            let conn = temp.open();
            create(&conn, "Persisted").expect("create v1")
        };

        let conn = temp.open();
        assert_eq!(inspect(&conn), Ok(FileState::Current(project.clone())));
        assert_eq!(pragma(&conn, "application_id"), APPLICATION_ID);
        assert_eq!(pragma(&conn, "user_version"), USER_VERSION);
        assert_eq!(pragma(&conn, "foreign_keys"), 1);
        assert_eq!(pragma(&conn, "recursive_triggers"), 0);
    }

    #[test]
    fn create_rolls_back_on_a_failed_ddl() {
        let temp = TempDb::new("rollback");
        let conn = temp.open();
        conn.execute_batch("PRAGMA max_page_count = 8")
            .expect("cap the database size");

        let error = create(&conn, "No room").expect_err("DDL must fail without pages");
        assert!(!error.is_empty(), "{error}");
        assert_eq!(pragma(&conn, "application_id"), 0);
        assert_eq!(pragma(&conn, "user_version"), 0);
        assert!(
            !objects(&conn, "table")
                .iter()
                .any(|name| name == "document")
        );
        assert_eq!(inspect(&conn), Ok(FileState::New));
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
            "edges_rtree",
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
        assert_eq!(
            columns(&conn, "assets"),
            [
                "id",
                "hash",
                "kind",
                "name",
                "mime",
                "size",
                "meta_json",
                "created_at"
            ]
        );
        assert_eq!(
            columns(&conn, "result_batches"),
            [
                "seq",
                "id",
                "node_id",
                "node_seq",
                "trigger",
                "provider",
                "model",
                "params_json",
                "status",
                "error",
                "item_count",
                "created_at",
                "finished_at",
            ]
        );
        assert_eq!(
            columns(&conn, "nodes"),
            [
                "seq",
                "id",
                "kind",
                "title",
                "body",
                "tags",
                "x",
                "y",
                "width",
                "height",
                "z",
                "data_json",
                "settings_json",
                "status",
                "output_batch_id",
                "rev",
                "created_at",
                "updated_at",
            ]
        );
        assert_eq!(
            columns(&conn, "edges"),
            [
                "seq",
                "id",
                "from_id",
                "to_id",
                "from_port",
                "to_port",
                "port_kind",
                "from_offset",
                "to_offset",
                "kind",
                "data_json",
            ]
        );
        assert_eq!(
            columns(&conn, "result_items"),
            [
                "id",
                "batch_id",
                "position",
                "port_id",
                "kind",
                "text",
                "asset_id",
                "meta_json",
            ]
        );
        assert_eq!(
            columns(&conn, "node_inputs"),
            [
                "id",
                "node_id",
                "port_id",
                "position",
                "kind",
                "origin",
                "edge_id",
                "item_id",
                "asset_id",
                "text",
                "meta_json",
                "created_at",
            ]
        );
        assert_eq!(columns(&conn, "nodes_geometry_dirty"), ["node_id"]);

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
        let edge_pair_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'edges_port_pair'",
                [],
                |row| row.get(0),
            )
            .expect("read edges_port_pair SQL");
        assert!(edge_pair_sql.to_uppercase().contains("UNIQUE"));

        let triggers = objects(&conn, "trigger");
        for trigger in [
            "document_no_delete",
            "document_rev_monotonic",
            "document_project_id_immutable",
            "document_no_replace",
            "nodes_no_replace",
            "edges_no_replace",
            "nodes_rev_monotonic",
            "nodes_output_done_bi",
            "nodes_output_done_bu",
            "result_batches_owner_bi",
            "result_batches_insert_running",
            "result_batches_done_item",
            "result_batches_terminal_immutable",
            "result_batches_running_delete",
            "result_batches_item_count_consistent",
            "result_items_running_only",
            "result_items_no_update",
            "result_items_delete_guard",
            "result_items_count_ai",
            "result_items_count_ad",
            "node_inputs_edge_shape_bi",
            "node_inputs_edge_shape_bu",
            "nodes_count_bounds_ai",
            "nodes_count_bounds_ad",
            "nodes_bounds_au",
            "edges_count_ai",
            "edges_count_ad",
            "nodes_rtree_ai",
            "nodes_rtree_au",
            "nodes_rtree_ad",
            "nodes_geometry_dirty_au",
            "nodes_geometry_dirty_ad",
            "edges_rtree_ai",
            "edges_rtree_au",
            "edges_rtree_ad",
            "nodes_fts_ai",
            "nodes_fts_ad",
            "nodes_fts_au",
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
        let fts = normalize_sql(&fts);
        assert!(fts.contains("content = 'nodes'"), "{fts}");
        assert!(fts.contains("content_rowid = 'seq'"), "{fts}");
        assert!(fts.contains("tokenize = 'trigram'"), "{fts}");

        let view: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'edge_boxes'",
                [],
                |row| row.get(0),
            )
            .expect("read edge_boxes SQL");
        let view = normalize_sql(&view);
        for fragment in [
            "f.x + f.width + 14.0",
            "t.x - 14.0",
            "60.0",
            "260.0",
            "- 4.0",
            "+ 4.0",
        ] {
            assert!(
                view.contains(fragment),
                "edge_boxes missing {fragment}: {view}"
            );
        }

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity_check");
        assert_eq!(integrity, "ok");
        let mut statement = conn
            .prepare("PRAGMA foreign_key_check")
            .expect("prepare foreign_key_check");
        assert_eq!(statement.query_map([], |_| Ok(())).unwrap().count(), 0);
    }

    #[test]
    fn trigger_maintenance_updates_counts_indexes_and_cascades() {
        let conn = memory();
        create(&conn, "Triggers").expect("create v1");
        insert_node(&conn, "n1", "alpha");
        insert_node(&conn, "n2", "beta");
        assert_eq!(count(&conn, "SELECT node_count FROM document"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM nodes_rtree"), 2);
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
            ),
            1
        );

        insert_edge(&conn, "e1", "n1", "n2");
        assert_eq!(count(&conn, "SELECT edge_count FROM document"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM edges_rtree"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM edge_boxes"), 1);

        conn.execute("DELETE FROM nodes WHERE id = 'n1'", [])
            .expect("delete the source node");
        assert_eq!(count(&conn, "SELECT node_count FROM document"), 1);
        assert_eq!(count(&conn, "SELECT edge_count FROM document"), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM nodes_rtree"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM edges_rtree"), 0);
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
            ),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'beta'"
            ),
            1
        );
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
        let table = memory();
        table
            .execute_batch("CREATE TABLE notes (body TEXT)")
            .expect("create foreign table");
        let error = inspect(&table).expect_err("foreign database must be refused");
        assert!(error.contains("not a Flow database"), "{error}");
        assert!(objects(&table, "table").iter().any(|name| name == "notes"));

        let view = memory();
        view.execute_batch("CREATE VIEW foreign_view AS SELECT 1")
            .expect("create foreign view");
        let error = inspect(&view).expect_err("a view-only file must be refused");
        assert!(error.contains("not a Flow database"), "{error}");
    }

    #[test]
    fn inspect_refuses_a_mismatched_application_id() {
        let conn = memory();
        conn.execute_batch("PRAGMA application_id = 123; PRAGMA user_version = 1;")
            .expect("stamp a foreign identity");
        let error = inspect(&conn).expect_err("mismatched application_id must be refused");
        assert!(error.contains("not a Flow database"), "{error}");
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
    fn inspect_refuses_an_older_schema() {
        let conn = memory();
        create(&conn, "Older").expect("create v1");
        conn.execute_batch("PRAGMA user_version = 0")
            .expect("drop version");
        let error = inspect(&conn).expect_err("older schema must be refused");
        assert!(error.contains("older"), "{error}");
    }

    #[test]
    fn inspect_refuses_an_incomplete_flow_database() {
        let conn = memory();
        conn.execute_batch(MIGRATION_1).expect("apply DDL");
        conn.execute_batch(&format!(
            "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"
        ))
        .expect("stamp identity");
        let error = inspect(&conn).expect_err("missing document row must be refused");
        assert_eq!(error, "the Flow database has no document row");

        let conn = memory();
        create(&conn, "Missing object").expect("create v1");
        conn.execute_batch("PRAGMA foreign_keys = OFF; DROP TABLE assets;")
            .expect("drop a required table");
        let error = inspect(&conn).expect_err("missing required object must be refused");
        assert!(error.contains("missing table assets"), "{error}");
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
        assert_eq!(pragma(&conn, "application_id"), 0);
        assert_eq!(pragma(&conn, "user_version"), 0);
    }

    #[test]
    fn create_refuses_a_current_package() {
        let conn = memory();
        let project = create(&conn, "Once").expect("create v1");
        let error = create(&conn, "Twice").expect_err("a current package must be refused");
        assert!(error.contains("already a Flow project"), "{error}");
        assert_eq!(count(&conn, "SELECT count(*) FROM document"), 1);
        let stored: String = conn
            .query_row("SELECT project_id FROM document WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("read project_id");
        assert_eq!(stored, project.project_id);
    }

    #[test]
    fn schema_checks_are_enforced() {
        let conn = memory();
        conn.execute_batch(MIGRATION_1).expect("apply DDL");
        let now = crate::clock::now_ms();
        let bad_id = conn.execute(
            "INSERT INTO document (id, project_id, created_at, updated_at) VALUES (1, 'short', ?1, ?1)",
            params![now],
        );
        assert!(bad_id.is_err(), "short project_id must fail");

        let bad_title = conn.execute(
            "INSERT INTO document (id, project_id, title, created_at, updated_at) \
             VALUES (1, '0123456789abcdef0123456789abcdef', '', ?1, ?1)",
            params![now],
        );
        assert!(bad_title.is_err(), "empty title must fail");

        let bad_camera = conn.execute(
            "INSERT INTO document (id, project_id, camera_zoom, created_at, updated_at) \
             VALUES (1, '0123456789abcdef0123456789abcdef', 0, ?1, ?1)",
            params![now],
        );
        assert!(bad_camera.is_err(), "non-positive camera_zoom must fail");

        let infinite_camera = conn.execute(
            "INSERT INTO document (id, project_id, camera_zoom, created_at, updated_at) \
             VALUES (1, '0123456789abcdef0123456789abcdef', 9e999, ?1, ?1)",
            params![now],
        );
        assert!(infinite_camera.is_err(), "infinite camera_zoom must fail");

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
    fn guard_rechecks_a_tampered_document_row() {
        let conn = memory();
        create(&conn, "Tamper").expect("create v1");

        conn.execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("ignore checks");
        conn.execute("UPDATE document SET title = '' WHERE id = 1", [])
            .expect("write an empty title past the CHECK");
        conn.execute_batch("PRAGMA ignore_check_constraints = OFF")
            .expect("restore checks");
        let error = inspect(&conn).expect_err("empty title must be refused");
        assert_eq!(error, "the Flow database has an empty title");

        conn.execute("UPDATE document SET title = 'Restored' WHERE id = 1", [])
            .expect("restore title");
        conn.execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("ignore checks");
        conn.execute("UPDATE document SET camera_zoom = 9e999 WHERE id = 1", [])
            .expect("write an infinite camera past the CHECK");
        conn.execute_batch("PRAGMA ignore_check_constraints = OFF")
            .expect("restore checks");
        let error = inspect(&conn).expect_err("infinite camera must be refused");
        assert_eq!(error, "the Flow database has an invalid camera");

        conn.execute("UPDATE document SET camera_zoom = 1.0 WHERE id = 1", [])
            .expect("restore camera");
        conn.execute_batch("DROP TRIGGER document_project_id_immutable")
            .expect("drop the immutability trigger");
        conn.execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("ignore checks");
        conn.execute(
            "UPDATE document SET project_id = 'ABCDEF0123456789ABCDEF0123456789' WHERE id = 1",
            [],
        )
        .expect("write an uppercase project_id past the CHECK");
        conn.execute_batch("PRAGMA ignore_check_constraints = OFF")
            .expect("restore checks");
        let error = inspect(&conn).expect_err("invalid project_id must be refused");
        assert_eq!(error, "the Flow database has an invalid project_id");
    }

    #[test]
    fn document_is_immutable_in_the_expected_ways() {
        let conn = memory();
        let project = create(&conn, "Immutable").expect("create v1");
        let delete = conn.execute("DELETE FROM document", []);
        assert!(delete.is_err(), "document delete must fail");
        let replace = conn.execute(
            "INSERT OR REPLACE INTO document (id, project_id, created_at, updated_at) \
             VALUES (1, 'ffffffffffffffffffffffffffffffff', 0, 0)",
            [],
        );
        assert!(replace.is_err(), "document REPLACE must fail");
        let stored: String = conn
            .query_row("SELECT project_id FROM document WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("read project_id");
        assert_eq!(stored, project.project_id);
        let update = conn.execute(
            "UPDATE document SET project_id = 'ffffffffffffffffffffffffffffffff'",
            [],
        );
        assert!(update.is_err(), "project_id update must fail");
    }

    #[test]
    fn replace_cannot_bypass_node_or_edge_checks() {
        let conn = memory();
        create(&conn, "Replace").expect("create v1");
        insert_node(&conn, "n1", "alpha");
        insert_node(&conn, "n2", "beta");
        insert_edge(&conn, "e1", "n1", "n2");

        let node_by_id = conn.execute(
            "INSERT OR REPLACE INTO nodes (id, kind, x, y, width, height, z, created_at, updated_at) \
             VALUES ('n1', 'text', 0, 0, 100, 50, 0, 0, 0)",
            [],
        );
        assert!(node_by_id.is_err(), "REPLACE by node id must fail");

        let node_by_seq = conn.execute(
            "INSERT OR REPLACE INTO nodes \
             (seq, id, kind, title, x, y, width, height, z, created_at, updated_at) \
             SELECT seq, 'z', kind, 'zulu', x, y, width, height, z, created_at, updated_at \
             FROM nodes WHERE id = 'n1'",
            [],
        );
        assert!(node_by_seq.is_err(), "REPLACE by node seq must fail");
        assert_eq!(count(&conn, "SELECT node_count FROM document"), 2);
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
            ),
            1
        );

        let edge_by_seq = conn.execute(
            "INSERT OR REPLACE INTO edges \
             (seq, id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
             SELECT seq, 'z', from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset \
             FROM edges WHERE id = 'e1'",
            [],
        );
        assert!(edge_by_seq.is_err(), "REPLACE by edge seq must fail");
        assert_eq!(count(&conn, "SELECT edge_count FROM document"), 1);
    }

    #[test]
    fn duplicate_edge_port_pair_is_rejected() {
        let conn = memory();
        create(&conn, "Unique edge").expect("create v1");
        insert_node(&conn, "n1", "one");
        insert_node(&conn, "n2", "two");
        insert_edge(&conn, "e1", "n1", "n2");
        let duplicate = conn.execute(
            "INSERT INTO edges (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
             VALUES ('e2', 'n1', 'n2', 'out', 'in', 'text', 0, 0)",
            [],
        );
        assert!(duplicate.is_err(), "duplicate port pair must fail");
    }

    #[test]
    fn create_requires_a_non_empty_title() {
        let conn = memory();
        let error = create(&conn, "   ").expect_err("empty title must be refused");
        assert!(error.contains("title"), "{error}");
        assert_eq!(inspect(&conn), Ok(FileState::New));
    }
}
