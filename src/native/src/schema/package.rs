//! Package-level SQL: the operations a manager performs on a whole package
//! file rather than on ordinary rows. Snapshotting, checkpointing, rekeying
//! and the clean-shutdown flag live here beside the frozen schema because
//! they either copy the schema wholesale or dance around its triggers; no
//! entity models them.

use std::path::Path;

use sea_orm::{ActiveModelTrait, ActiveValue::Set, ActiveValue::Unchanged, ConnectionTrait};
use sea_orm::{DbBackend, Statement};

use crate::document;
use crate::entity::document as document_row;
use crate::schema::v1;

/// Folds committed write-ahead-log frames back into the package file and
/// truncates the log. Only a complete checkpoint is a successful one: a
/// concurrent reader makes TRUNCATE report busy or checkpointed < log
/// without an SQL error, and a package that is about to be copied, renamed
/// or deleted must not carry unmerged frames.
pub(crate) fn checkpoint_truncate<C: ConnectionTrait>(conn: &C) -> Result<(), String> {
    let row = conn
        .query_one_raw(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA wal_checkpoint(TRUNCATE)".to_owned(),
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "wal_checkpoint returned no row".to_owned())?;
    let busy = row
        .try_get_by_index::<i64>(0)
        .map_err(|error| error.to_string())?;
    let log = row
        .try_get_by_index::<i64>(1)
        .map_err(|error| error.to_string())?;
    let checkpointed = row
        .try_get_by_index::<i64>(2)
        .map_err(|error| error.to_string())?;
    if checkpointed != log {
        return Err(format!(
            "the package's write-ahead log is still busy \
             (busy={busy}, checkpointed={checkpointed} of {log})"
        ));
    }
    Ok(())
}

/// Records that this session closed its document cleanly. The open path sets
/// the flag back to 0 before serving a single command.
pub(crate) fn mark_clean<C: ConnectionTrait>(conn: &C) -> Result<(), String> {
    set_clean_shutdown(conn, true)
}

/// Records that a session owns the package and has not closed it yet.
pub(crate) fn mark_dirty<C: ConnectionTrait>(conn: &C) -> Result<(), String> {
    set_clean_shutdown(conn, false)
}

fn set_clean_shutdown<C: ConnectionTrait>(conn: &C, clean: bool) -> Result<(), String> {
    document_row::ActiveModel {
        id: Unchanged(document::ROW_ID),
        clean_shutdown: Set(if clean { 1 } else { 0 }),
        ..Default::default()
    }
    .update(conn)
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Writes a consistent copy of the open database to `target`, including rows
/// that only exist in the write-ahead log. `VACUUM INTO` reads the source and
/// never mutates it, so a foreign backup can be snapshotted without a lock.
/// The target must not exist.
pub(crate) fn export_snapshot<C: ConnectionTrait>(conn: &C, target: &Path) -> Result<(), String> {
    let path = target.to_string_lossy().into_owned();
    conn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "VACUUM INTO ?1",
        vec![path.into()],
    ))
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Gives a copied package a fresh identity in one transaction. The frozen
/// schema makes `document.project_id` immutable, so the canonical trigger is
/// dropped, the row is updated through the entity, and the exact trigger text
/// is recreated before the commit. Content, revision, camera, counts and the
/// lifecycle flags are preserved; timestamps are the caller's.
pub(crate) fn remint_project_id<C: ConnectionTrait>(
    conn: &C,
    new_id: &str,
    title: &str,
    created_at: i64,
    updated_at: i64,
) -> Result<(), String> {
    if !v1::is_project_id(new_id) {
        return Err("the project id is invalid".to_owned());
    }
    v1::validate_title(title)?;
    conn.execute_unprepared("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    match remint_in_transaction(conn, new_id, title, created_at, updated_at) {
        Ok(()) => {
            if let Err(error) = conn.execute_unprepared("COMMIT") {
                let _ = conn.execute_unprepared("ROLLBACK");
                return Err(error.to_string());
            }
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_unprepared("ROLLBACK");
            Err(error)
        }
    }
}

fn remint_in_transaction<C: ConnectionTrait>(
    conn: &C,
    new_id: &str,
    title: &str,
    created_at: i64,
    updated_at: i64,
) -> Result<(), String> {
    conn.execute_unprepared("DROP TRIGGER document_project_id_immutable")
        .map_err(|error| error.to_string())?;
    document_row::ActiveModel {
        id: Unchanged(document::ROW_ID),
        project_id: Set(new_id.to_owned()),
        title: Set(title.to_owned()),
        created_at: Set(created_at),
        updated_at: Set(updated_at),
        ..Default::default()
    }
    .update(conn)
    .map_err(|error| error.to_string())?;
    conn.execute_unprepared(v1::PROJECT_ID_TRIGGER)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use sea_orm::{Database, DatabaseConnection, Statement};

    use super::*;
    use crate::schema::v1::{self, FileState};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDb {
        path: PathBuf,
    }

    impl TempDb {
        fn new(label: &str) -> Self {
            let count = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "flow-pkg-{label}-{}-{count}.db",
                std::process::id()
            ));
            remove_files(&path);
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn connect(&self) -> DatabaseConnection {
            let url = crate::db::sqlite_url(&self.path.to_string_lossy()).expect("database URL");
            let conn = Database::connect(url).expect("connect temp database");
            v1::configure(&conn).expect("configure temp database");
            conn
        }

        fn snapshot_path(&self, suffix: &str) -> PathBuf {
            self.path.with_extension(suffix)
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            remove_files(&self.path);
            remove_files(&self.snapshot_path("snapshot"));
        }
    }

    fn remove_files(path: &Path) {
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(sidecar));
        }
        let _ = std::fs::remove_file(path);
    }

    fn wall(path: &Path) -> PathBuf {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push("-wal");
        PathBuf::from(sidecar)
    }

    fn sqlite_wal(conn: &DatabaseConnection) {
        conn.execute_unprepared("PRAGMA journal_mode = WAL")
            .expect("enable WAL");
    }

    fn insert_node(conn: &DatabaseConnection, id: &str, title: &str) {
        conn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO nodes (id, kind, title, x, y, width, height, z, created_at, updated_at) \
             VALUES (?1, 'note', ?2, 0.0, 0.0, 100.0, 50.0, 0.0, 1, 1)",
            vec![id.to_owned().into(), title.to_owned().into()],
        ))
        .expect("insert node");
    }

    fn read_document(conn: &DatabaseConnection) -> document_row::Model {
        use sea_orm::EntityTrait;
        document_row::Entity::find_by_id(document::ROW_ID)
            .one(conn)
            .expect("read document")
            .expect("document row")
    }

    fn project_id(conn: &DatabaseConnection) -> String {
        read_document(conn).project_id
    }

    #[test]
    fn checkpoint_truncate_folds_committed_frames() {
        let temp = TempDb::new("checkpoint");
        let project = {
            let conn = temp.connect();
            sqlite_wal(&conn);
            v1::create(&conn, "Checkpoint").expect("create");
            insert_node(&conn, "n1", "Written before checkpoint");
            assert!(std::fs::metadata(wall(temp.path())).expect("wal").len() > 0);
            checkpoint_truncate(&conn).expect("checkpoint");
            assert_eq!(std::fs::metadata(wall(temp.path())).expect("wal").len(), 0);
            project_id(&conn)
        };

        let conn = temp.connect();
        assert_eq!(
            v1::inspect(&conn),
            Ok(FileState::Current(v1::ProjectInfo {
                project_id: project,
                title: "Checkpoint".to_owned(),
            }))
        );
        let row = conn
            .query_one_raw(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT title FROM nodes WHERE id = 'n1'".to_owned(),
            ))
            .expect("query node")
            .expect("node row");
        assert_eq!(
            row.try_get_by_index::<String>(0).expect("title"),
            "Written before checkpoint"
        );
    }

    #[test]
    fn export_snapshot_copies_wal_rows_and_the_schema() {
        let temp = TempDb::new("snapshot");
        let target = temp.snapshot_path("snapshot");
        let source = temp.connect();
        sqlite_wal(&source);
        v1::create(&source, "Snapshot").expect("create");
        insert_node(&source, "n1", "Only in the log");
        assert!(std::fs::metadata(wall(temp.path())).expect("wal").len() > 0);

        export_snapshot(&source, &target).expect("export snapshot");

        let copy = Database::connect(
            crate::db::sqlite_url(&target.to_string_lossy()).expect("snapshot URL"),
        )
        .expect("connect snapshot");
        v1::configure(&copy).expect("configure snapshot");
        let state = v1::inspect(&copy).expect("inspect snapshot");
        assert!(matches!(state, FileState::Current(_)));
        assert_eq!(
            copy.query_one_raw(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT title FROM nodes WHERE id = 'n1'".to_owned(),
            ))
            .expect("query node")
            .expect("node row")
            .try_get_by_index::<String>(0)
            .expect("title"),
            "Only in the log"
        );
        assert_eq!(
            copy.query_one_raw(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT sql FROM sqlite_master \
                 WHERE type = 'trigger' AND name = 'document_project_id_immutable'"
                    .to_owned(),
            ))
            .expect("query trigger")
            .expect("trigger row")
            .try_get_by_index::<String>(0)
            .expect("trigger text"),
            v1::PROJECT_ID_TRIGGER
        );
        assert_eq!(
            copy.query_one_raw(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'log'".to_owned(),
            ))
            .expect("query fts")
            .expect("fts row")
            .try_get_by_index::<i64>(0)
            .expect("fts count"),
            1
        );
        for sql in [
            "SELECT count(*) FROM nodes_rtree",
            "SELECT count(*) FROM edges_rtree",
            "SELECT count(*) FROM edge_boxes",
        ] {
            let row = copy
                .query_one_raw(Statement::from_string(DbBackend::Sqlite, sql.to_owned()))
                .expect("query index")
                .expect("index row");
            let expected = i64::from(sql.contains("nodes_rtree"));
            assert_eq!(
                row.try_get_by_index::<i64>(0).expect("count"),
                expected,
                "{sql}"
            );
        }
    }

    #[test]
    fn remint_changes_identity_and_restores_the_trigger() {
        let temp = TempDb::new("remint");
        let conn = temp.connect();
        v1::create(&conn, "Original").expect("create");
        insert_node(&conn, "n1", "Kept");
        let old = read_document(&conn);
        let new_id = "0123456789abcdef0123456789abcdef";

        remint_project_id(&conn, new_id, "Renamed", 111, 222).expect("remint");

        let row = read_document(&conn);
        assert_eq!(row.project_id, new_id);
        assert_eq!(row.title, "Renamed");
        assert_eq!((row.created_at, row.updated_at), (111, 222));
        assert_eq!(row.rev, old.rev);
        assert_eq!(row.node_count, old.node_count);
        assert_eq!(row.camera_zoom, old.camera_zoom);
        assert_eq!(row.demo_seeded, old.demo_seeded);
        assert_eq!(row.clean_shutdown, old.clean_shutdown);
        assert_eq!(
            conn.query_one_raw(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT sql FROM sqlite_master \
                 WHERE type = 'trigger' AND name = 'document_project_id_immutable'"
                    .to_owned(),
            ))
            .expect("query trigger")
            .expect("trigger row")
            .try_get_by_index::<String>(0)
            .expect("trigger text"),
            v1::PROJECT_ID_TRIGGER
        );
        let error = conn
            .execute_unprepared(
                "UPDATE document SET project_id = 'ffffffffffffffffffffffffffffffff' WHERE id = 1",
            )
            .expect_err("the recreated trigger must still abort");
        assert!(error.to_string().contains("project_id is immutable"));
        assert_eq!(project_id(&conn), new_id);
    }

    #[test]
    fn remint_refuses_an_invalid_identity_without_changing_the_row() {
        let temp = TempDb::new("remint-invalid");
        let conn = temp.connect();
        v1::create(&conn, "Original").expect("create");
        let before = read_document(&conn);

        assert_eq!(
            remint_project_id(&conn, "not-a-project-id", "Renamed", 1, 2),
            Err("the project id is invalid".to_owned())
        );
        assert_eq!(
            remint_project_id(&conn, "0123456789abcdef0123456789abcdef", "", 1, 2),
            Err("the project title is empty".to_owned())
        );
        assert_eq!(read_document(&conn), before);
    }

    #[test]
    fn mark_clean_flips_the_shutdown_flag() {
        let temp = TempDb::new("mark-clean");
        let conn = temp.connect();
        v1::create(&conn, "Clean").expect("create");
        assert_eq!(read_document(&conn).clean_shutdown, 0);
        mark_clean(&conn).expect("mark clean");
        assert_eq!(read_document(&conn).clean_shutdown, 1);
    }
}
