//! Schema v1 tests: fixtures, open guard/identity, shape, surface, constraints,
//! producers and triggers.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sea_orm::{Database, DatabaseConnection, DbErr, QueryResult, Value};
use sha2::{Digest, Sha256};

use super::*;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new(label: &str) -> Self {
        let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("flow-v1-{label}-{}-{count}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(sidecar(&path, suffix));
        }
        Self { path }
    }

    fn connect(&self) -> DatabaseConnection {
        let path = self.path.to_string_lossy();
        let url = crate::db::sqlite_url(&path).expect("temp database URL");
        let conn = Database::connect(url).expect("connect temp database");
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

fn memory() -> DatabaseConnection {
    let conn = Database::connect("sqlite::memory:").expect("open in-memory SQLite");
    configure(&conn).expect("configure in-memory SQLite");
    conn
}

fn exec(conn: &DatabaseConnection, sql: &str) {
    conn.execute_unprepared(sql)
        .unwrap_or_else(|error| panic!("execute {sql}: {error}"));
}

fn execute(conn: &DatabaseConnection, sql: &str, values: Vec<Value>) -> Result<(), DbErr> {
    conn.execute_raw(statement_values(sql, values)).map(|_| ())
}

fn query_one(conn: &DatabaseConnection, sql: &str, values: Vec<Value>) -> Option<QueryResult> {
    conn.query_one_raw(statement_values(sql, values))
        .unwrap_or_else(|error| panic!("query {sql}: {error}"))
}

fn query_all(conn: &DatabaseConnection, sql: &str, values: Vec<Value>) -> Vec<QueryResult> {
    conn.query_all_raw(statement_values(sql, values))
        .unwrap_or_else(|error| panic!("query {sql}: {error}"))
}

fn pragma(conn: &DatabaseConnection, name: &str) -> i64 {
    query_one(conn, &format!("PRAGMA {name}"), vec![])
        .unwrap_or_else(|| panic!("PRAGMA {name} returned no row"))
        .try_get_by_index(0)
        .unwrap_or_else(|error| panic!("PRAGMA {name}: {error}"))
}

fn count(conn: &DatabaseConnection, sql: &str) -> i64 {
    query_one(conn, sql, vec![])
        .unwrap_or_else(|| panic!("count query returned no row: {sql}"))
        .try_get_by_index(0)
        .unwrap_or_else(|error| panic!("count query {sql}: {error}"))
}

fn columns(conn: &DatabaseConnection, table: &str) -> Vec<String> {
    query_all(conn, &format!("PRAGMA table_info({table})"), vec![])
        .into_iter()
        .map(|row| row.try_get_by_index(1).expect("column name"))
        .collect()
}

fn table_definition(conn: &DatabaseConnection, table: &str) -> Vec<String> {
    query_all(conn, &format!("PRAGMA table_info({table})"), vec![])
        .into_iter()
        .map(|row| {
            let name: String = row.try_get_by_index(1).expect("column name");
            let kind: String = row.try_get_by_index(2).expect("column type");
            let not_null: i64 = row.try_get_by_index(3).expect("not null");
            let default: Option<String> = row.try_get_by_index(4).expect("column default");
            let primary_key: i64 = row.try_get_by_index(5).expect("primary key");
            format!(
                "{name}|{kind}|{not_null}|{}|{primary_key}",
                default.unwrap_or_default()
            )
        })
        .collect()
}

fn objects(conn: &DatabaseConnection, kind: &str) -> Vec<String> {
    query_all(
        conn,
        "SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name",
        vec![kind.to_owned().into()],
    )
    .into_iter()
    .map(|row| row.try_get_by_index(0).expect("object name"))
    .collect()
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn insert_node(conn: &DatabaseConnection, id: &str, title: &str) {
    execute(
        conn,
        "INSERT INTO nodes (id, kind, title, x, y, width, height, z, created_at, updated_at) \
         VALUES (?1, 'text', ?2, 0, 0, 100, 50, 0, 0, 0)",
        vec![id.to_owned().into(), title.to_owned().into()],
    )
    .expect("insert node");
}

fn insert_edge(conn: &DatabaseConnection, id: &str, from: &str, to: &str) {
    execute(
        conn,
        "INSERT INTO edges (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES (?1, ?2, ?3, 'out', 'in', 'text', 0, 0)",
        vec![id.to_owned().into(), from.to_owned().into(), to.to_owned().into()],
    )
    .expect("insert edge");
}

fn ddl_objects() -> Vec<(&'static str, &'static str)> {
    const PREFIXES: &[(&str, &str)] = &[
        ("CREATE VIRTUAL TABLE ", "table"),
        ("CREATE TABLE ", "table"),
        ("CREATE VIEW ", "view"),
        ("CREATE UNIQUE INDEX ", "index"),
        ("CREATE INDEX ", "index"),
        ("CREATE TRIGGER ", "trigger"),
    ];
    let mut objects = Vec::new();
    for line in MIGRATION_1.lines() {
        let line = line.trim_start();
        for (prefix, kind) in PREFIXES {
            if let Some(rest) = line.strip_prefix(prefix) {
                let name = rest.split_whitespace().next().unwrap_or("");
                objects.push((*kind, name));
                break;
            }
        }
    }
    objects
}

mod constraints;
mod producers;
mod shape;
mod surface;
mod triggers;

#[test]
fn create_applies_v1_and_mints_identity() {
    let conn = memory();
    let project = create(&conn, "Test project").expect("create v1");

    assert_eq!(project.title, "Test project");
    assert_eq!(project.project_id.len(), 32);
    assert!(is_project_id(&project.project_id));
    assert_eq!(pragma(&conn, "application_id"), APPLICATION_ID);
    assert_eq!(pragma(&conn, "user_version"), USER_VERSION);

    let row = query_one(
        &conn,
        "SELECT title, camera_x, camera_y, camera_zoom, demo_seeded, clean_shutdown \
         FROM document WHERE id = 1",
        vec![],
    )
    .expect("read document");
    let title: String = row.try_get_by_index(0).expect("title");
    let camera_x: f64 = row.try_get_by_index(1).expect("camera_x");
    let camera_y: f64 = row.try_get_by_index(2).expect("camera_y");
    let camera_zoom: f64 = row.try_get_by_index(3).expect("camera_zoom");
    let demo_seeded: i64 = row.try_get_by_index(4).expect("demo_seeded");
    let clean_shutdown: i64 = row.try_get_by_index(5).expect("clean_shutdown");
    assert_eq!(title, "Test project");
    assert_eq!((camera_x, camera_y, camera_zoom), (0.0, 0.0, 1.0));
    assert_eq!((demo_seeded, clean_shutdown), (0, 0));
    assert_eq!(inspect(&conn), Ok(FileState::Current(project)));
}

#[test]
fn create_with_records_the_initial_content_decision() {
    let blank = memory();
    create_with(&blank, "Blank", true).expect("blank create");
    let row = query_one(
        &blank,
        "SELECT demo_seeded FROM document WHERE id = 1",
        vec![],
    )
    .expect("read document");
    assert_eq!(row.try_get_by_index::<i64>(0).expect("demo_seeded"), 1);

    let seeded = memory();
    create_with(&seeded, "Seeded", false).expect("seeded create");
    let row = query_one(
        &seeded,
        "SELECT demo_seeded FROM document WHERE id = 1",
        vec![],
    )
    .expect("read document");
    assert_eq!(row.try_get_by_index::<i64>(0).expect("demo_seeded"), 0);
}

#[test]
fn mint_project_id_is_32_lowercase_hex_and_unique() {
    let conn = memory();
    let first = mint_project_id(&conn).expect("first id");
    let second = mint_project_id(&conn).expect("second id");
    assert!(is_project_id(&first), "not a project id: {first}");
    assert!(is_project_id(&second), "not a project id: {second}");
    assert_ne!(first, second);
}

#[test]
fn validate_title_shares_the_ddl_rule() {
    assert_eq!(validate_title("Flow"), Ok(()));
    assert_eq!(
        validate_title(" \t\r\n"),
        Err("the project title is empty".to_owned())
    );
    assert_eq!(
        validate_title("a\0b"),
        Err("the project title is invalid".to_owned())
    );
}

#[test]
fn project_id_trigger_constant_is_the_schema_text() {
    assert!(MIGRATION_1.contains(PROJECT_ID_TRIGGER));
    let conn = memory();
    create(&conn, "Trigger").expect("create v1");
    let stored = scalar_string(
        &conn,
        "SELECT sql FROM sqlite_master \
         WHERE type = 'trigger' AND name = 'document_project_id_immutable'",
        vec![],
    )
    .expect("read trigger");
    assert_eq!(stored, PROJECT_ID_TRIGGER);
}

#[test]
fn create_persists_across_reopen() {
    let temp = TempDb::new("persist");
    let project = {
        let conn = temp.connect();
        create(&conn, "Persisted").expect("create v1")
    };

    let conn = temp.connect();
    assert_eq!(inspect(&conn), Ok(FileState::Current(project.clone())));
    assert_eq!(pragma(&conn, "application_id"), APPLICATION_ID);
    assert_eq!(pragma(&conn, "user_version"), USER_VERSION);
    assert_eq!(pragma(&conn, "foreign_keys"), 1);
    assert_eq!(pragma(&conn, "recursive_triggers"), 0);
}

#[test]
fn create_rolls_back_on_a_failed_ddl() {
    let temp = TempDb::new("rollback");
    let conn = temp.connect();
    exec(&conn, "PRAGMA max_page_count = 8");

    let error = create(&conn, "No room").expect_err("DDL must fail without pages");
    assert!(
        error.contains("full") || error.contains("disk"),
        "expected a page-limit error, got {error}"
    );
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
    exec(&table, "CREATE TABLE notes (body TEXT)");
    let error = inspect(&table).expect_err("foreign database must be refused");
    assert!(error.contains("not a Flow database"), "{error}");
    assert!(objects(&table, "table").iter().any(|name| name == "notes"));

    let view = memory();
    exec(&view, "CREATE VIEW foreign_view AS SELECT 1");
    let error = inspect(&view).expect_err("a view-only file must be refused");
    assert!(error.contains("not a Flow database"), "{error}");
}

#[test]
fn inspect_refuses_a_mismatched_application_id() {
    let conn = memory();
    exec(
        &conn,
        "PRAGMA application_id = 123; PRAGMA user_version = 1;",
    );
    let error = inspect(&conn).expect_err("mismatched application_id must be refused");
    assert!(error.contains("not a Flow database"), "{error}");
}

#[test]
fn inspect_refuses_a_newer_schema() {
    let conn = memory();
    create(&conn, "Newer").expect("create v1");
    exec(&conn, "PRAGMA user_version = 2");
    let error = inspect(&conn).expect_err("newer schema must be refused");
    assert!(error.contains("newer"), "{error}");
}

#[test]
fn inspect_refuses_an_older_schema() {
    let conn = memory();
    create(&conn, "Older").expect("create v1");
    exec(&conn, "PRAGMA user_version = 0");
    let error = inspect(&conn).expect_err("older schema must be refused");
    assert!(error.contains("older"), "{error}");
}

#[test]
fn inspect_refuses_an_incomplete_flow_database() {
    let conn = memory();
    exec(&conn, MIGRATION_1);
    exec(
        &conn,
        &format!("PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {USER_VERSION};"),
    );
    let error = inspect(&conn).expect_err("missing document row must be refused");
    assert_eq!(error, "the Flow database has no document row");

    let conn = memory();
    create(&conn, "Missing object").expect("create v1");
    exec(&conn, "PRAGMA foreign_keys = OFF; DROP TABLE assets;");
    let error = inspect(&conn).expect_err("missing required object must be refused");
    assert!(error.contains("missing table assets"), "{error}");

    let conn = memory();
    create(&conn, "Missing index").expect("create v1");
    exec(&conn, "DROP INDEX edges_port_pair");
    let error = inspect(&conn).expect_err("missing required index must be refused");
    assert!(error.contains("missing index edges_port_pair"), "{error}");

    let conn = memory();
    create(&conn, "Missing trigger").expect("create v1");
    exec(&conn, "DROP TRIGGER nodes_fts_ai");
    let error = inspect(&conn).expect_err("missing required trigger must be refused");
    assert!(error.contains("missing trigger nodes_fts_ai"), "{error}");

    let conn = memory();
    create(&conn, "Missing column").expect("create v1");
    exec(&conn, "PRAGMA writable_schema = ON");
    exec(
        &conn,
        "UPDATE sqlite_master \
         SET sql = replace(sql, 'camera_zoom', 'camera_zoom_removed') \
         WHERE type = 'table' AND name = 'document'",
    );
    exec(
        &conn,
        "PRAGMA schema_version = 9999; PRAGMA writable_schema = OFF",
    );
    let error = inspect(&conn).expect_err("missing document column must be refused");
    assert!(
        error.starts_with("the Flow database is incomplete:"),
        "{error}"
    );
    assert!(error.contains("camera_zoom"), "{error}");
}

#[test]
fn create_refuses_a_foreign_database_without_dropping_it() {
    let conn = memory();
    exec(
        &conn,
        "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep')",
    );
    let error = create(&conn, "Refused").expect_err("foreign database must be refused");
    assert!(error.contains("not a Flow database"), "{error}");
    let kept: String = query_one(&conn, "SELECT body FROM notes", vec![])
        .expect("foreign row survives")
        .try_get_by_index(0)
        .expect("foreign body");
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
    let stored: String = query_one(
        &conn,
        "SELECT project_id FROM document WHERE id = 1",
        vec![],
    )
    .expect("read project_id")
    .try_get_by_index(0)
    .expect("project_id");
    assert_eq!(stored, project.project_id);
}

#[test]
fn create_requires_a_non_empty_title() {
    let conn = memory();
    for title in ["   ", "\t\n", "\r"] {
        let error = create(&conn, title).expect_err("blank title must be refused");
        assert!(error.contains("title"), "{error}");
        assert_eq!(inspect(&conn), Ok(FileState::New));
    }
    for title in ["\0", "a\0", "\0b"] {
        let error = create(&conn, title).expect_err("NUL title must be refused");
        assert!(error.contains("invalid"), "{error}");
        assert_eq!(inspect(&conn), Ok(FileState::New));
    }
}

#[test]
fn create_configures_a_bare_connection() {
    let conn = Database::connect("sqlite::memory:").expect("open in-memory SQLite");
    exec(
        &conn,
        "PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = ON;",
    );
    assert_eq!(pragma(&conn, "foreign_keys"), 0);
    assert_eq!(pragma(&conn, "recursive_triggers"), 1);
    create(&conn, "Bare").expect("create v1");
    assert_eq!(pragma(&conn, "foreign_keys"), 1);
    assert_eq!(pragma(&conn, "recursive_triggers"), 0);
}

#[test]
fn inspect_accepts_a_v1_database_created_through_sea_orm() {
    let conn = memory();
    let project = create(&conn, "SeaORM").expect("create v1");
    assert_eq!(inspect(&conn), Ok(FileState::Current(project)));
}

#[test]
fn inspect_refuses_a_v5_application_id_zero_file_with_user_tables() {
    let conn = memory();
    exec(
        &conn,
        "CREATE TABLE documents (id TEXT PRIMARY KEY); CREATE TABLE nodes (id TEXT PRIMARY KEY);",
    );
    let error = inspect(&conn).expect_err("a v5-like file must be refused");
    assert!(error.contains("not a Flow database"), "{error}");
}

#[test]
fn create_then_inspect_round_trips_project_id_and_title() {
    let conn = memory();
    let project = create(&conn, "Round trip").expect("create v1");
    let state = inspect(&conn).expect("inspect v1");
    let FileState::Current(inspected) = state else {
        panic!("expected a current v1 state");
    };
    assert_eq!(inspected.project_id, project.project_id);
    assert_eq!(inspected.title, "Round trip");
}
