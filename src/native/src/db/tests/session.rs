//! Package close, recovery state and the saved view.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows `crate::db::session` after the
//! production split; tests that need it spell the full path.

use super::*;
use crate::db::session::CLOSE_FAILED_AFTER_STOP;

#[test]
fn close_marks_the_package_clean_and_stops_the_worker() {
    let (path, database) = temp_database("close");
    {
        let db = Database::open(&database).expect("open");
        db.close().expect("close");
        assert!(
            db.count().is_err(),
            "a job after close must not reach SQLite"
        );
        db.close().expect("a second close is a no-op");
    }

    // close() acknowledges only after the worker released the file, so a
    // rename (or delete/backup) can follow immediately.
    let renamed = format!("{database}.closed");
    std::fs::rename(&database, &renamed).expect("close releases the package file");
    std::fs::rename(&renamed, &database).expect("restore the package file");

    let url = sqlite_url(&database).expect("raw URL");
    let conn = sea_orm::Database::connect(url.as_str()).expect("reopen raw database");
    let clean = conn
        .query_one_raw(sea_orm::Statement::from_string(
            conn.get_database_backend(),
            "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
        ))
        .expect("read clean flag")
        .expect("document row")
        .try_get_by_index::<i64>(0)
        .expect("clean flag");
    assert_eq!(clean, 1, "close records a clean shutdown");
    drop(conn);

    // Reopening marks the package dirty again until the next close.
    {
        let db = Database::open(&database).expect("reopen");
        let dirty = db
            .run(|conn| {
                conn.query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "missing document row".to_owned())?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())
            })
            .expect("read clean flag");
        assert_eq!(dirty, 0);
    }
    remove_database_files(&path);
}

#[test]
fn close_refuses_a_blocked_checkpoint() {
    use sea_orm::TransactionTrait;

    let (path, database) = temp_database("close-busy");
    let db = Database::open(&database).expect("open");

    // A reader whose snapshot predates the next commit keeps that frame
    // out of the main file, so TRUNCATE reports busy with
    // checkpointed < log.
    let url = sqlite_url(&database).expect("raw URL");
    let reader = sea_orm::Database::connect(url.as_str()).expect("open reader");
    let snapshot = reader.begin().expect("begin read transaction");
    snapshot
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Sqlite,
            "SELECT count(*) FROM document".to_owned(),
        ))
        .expect("pin the snapshot");

    db.insert_nodes(vec![node("late", "Late", "", &[], 0.0, 0.0)])
        .expect("commit after the snapshot");
    assert_eq!(
        CLOSE_FAILED_AFTER_STOP,
        "the document closed with a recovery warning: "
    );
    let error = db
        .close()
        .expect_err("a blocked checkpoint is not a clean close");
    assert!(error.contains("write-ahead log"), "{error}");
    assert!(
        error.starts_with(CLOSE_FAILED_AFTER_STOP),
        "the worker stopped, so the close must say so: {error}"
    );

    // The failed close leaves the package marked dirty, so the next open
    // schedules verification instead of skipping it.
    drop(snapshot);
    let clean = reader
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Sqlite,
            "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
        ))
        .expect("read clean flag")
        .expect("document row")
        .try_get_by_index::<i64>(0)
        .expect("clean flag");
    assert_eq!(clean, 0, "a refused checkpoint stays dirty");
    drop(reader);
    remove_database_files(&path);
}

#[test]
fn close_with_view_saves_the_camera_and_a_clean_state() {
    let (path, database) = temp_database("close-view");
    {
        let db = Database::open(&database).expect("open");
        let error = db
            .close_with_view(f64::NAN, 0.0, 1.0)
            .expect_err("an invalid camera must not close the package");
        assert!(error.contains("camera"), "{error}");
        assert!(
            !error.starts_with(CLOSE_FAILED_AFTER_STOP),
            "no close job ran, so the worker may still hold the package"
        );
        db.close_with_view(120.0, -40.0, 2.5)
            .expect("close with the view");
    }
    {
        let db = Database::open(&database).expect("reopen");
        let info = db.project_info().expect("info");
        assert!(info.opened_clean, "the combined close is clean");
        assert_eq!(
            (info.camera_x, info.camera_y, info.camera_zoom),
            (120.0, -40.0, 2.5),
            "the camera was saved before the checkpoint"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn a_failed_verify_keeps_the_package_due_for_recovery() {
    let dir = std::env::temp_dir().join(format!(
        "flow-verify-dirty-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).expect("create package directory");
    let path = dir.join("flow.db");
    let database = path.to_string_lossy().into_owned();
    {
        let db = Database::open(&database).expect("open");
        test_asset(&db, "asset-orphan");
        db.run(|conn| {
            conn.execute_unprepared("PRAGMA foreign_keys = OFF")
                .map_err(|error| error.to_string())?;
            let inserted = conn.execute_unprepared(
                "INSERT INTO node_inputs \
                     (id, node_id, position, port_id, kind, origin, asset_id, \
                      text, meta_json, created_at) \
                     VALUES ('orphan', 'missing', 0, 'references', 'image', 'local', \
                             'asset-orphan', '', '{}', 0)",
            );
            conn.execute_unprepared("PRAGMA foreign_keys = ON")
                .map_err(|error| error.to_string())?;
            inserted.map(|_| ()).map_err(|error| error.to_string())
        })
        .expect("insert an orphan input");
        db.verify().expect_err("verify reports the orphan");
        db.close().expect("close after a failed verify");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "a failed verify leaves the package due for recovery"
        );
        db.close().expect("close");
    }
    remove_path_retrying(&dir);
}

#[test]
fn a_close_request_skips_a_queued_read_but_runs_a_queued_command() {
    let db = Database::open(":memory:").expect("open");
    db.closing.store(true, Ordering::SeqCst);
    let skipped = db
        .run_read(|_| -> Result<(), String> {
            panic!("a read after the close request must not touch SQLite")
        })
        .expect_err("the queued read answers closed");
    assert!(skipped.contains("closed"), "{skipped}");

    // A command the UI already issued must still reach the checkpoint.
    db.insert_nodes(vec![node("queued", "Queued", "", &[], 0.0, 0.0)])
        .expect("a queued command still runs");
    let count = db
        .run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the count");
    assert_eq!(count, 1);
}

#[test]
fn closing_before_verify_keeps_a_crashed_package_dirty() {
    let (path, database) = temp_database("close-pending");
    {
        let db = Database::open(&database).expect("open");
        db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .expect("insert");
        // Drop without close: the package stays dirty.
    }
    {
        let db = Database::open(&database).expect("reopen after a crash");
        assert!(!db.project_info().expect("info").opened_clean);
        // Quit before the recovery check ever runs.
        db.close().expect("close without verify");
    }
    {
        let db = Database::open(&database).expect("reopen again");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "the recovery check is still pending"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen after verify");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a completed verify lets the next close mark the package clean"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn a_close_job_reads_the_recovery_state_after_earlier_jobs() {
    let (path, database) = temp_database("close-order");
    {
        let db = Database::open(&database).expect("open");
        let pending = Arc::clone(&db.recovery_pending);
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        // Queue the jobs by hand: a blocked verify would be skipped by the
        // close gate, so this pins the FIFO ordering of an earlier job
        // that did run and stored its outcome before the close is read.
        db.closing.store(true, Ordering::SeqCst);
        db.closed.store(true, Ordering::SeqCst);
        db.tx
            .lock()
            .expect("lock the job queue")
            .send(Job::Run(Box::new(move |_| {
                pending.store(true, Ordering::SeqCst);
            })))
            .expect("queue the marking job");
        db.tx
            .lock()
            .expect("lock the job queue")
            .send(Job::Close {
                ack: ack_tx,
                camera: None,
                recovery_pending: Arc::clone(&db.recovery_pending),
            })
            .expect("queue the close job");
        ack_rx.recv().expect("close ack").expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "the close job must read the state after the earlier job ran"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn save_view_persists_without_bumping_the_revision() {
    let db = Database::open(":memory:").expect("open");
    let before = current_rev(&db);
    db.save_view(120.0, -40.0, 2.5).expect("save view");
    let info = db.project_info().expect("project info");
    assert_eq!(
        (info.camera_x, info.camera_y, info.camera_zoom),
        (120.0, -40.0, 2.5)
    );
    assert_eq!(current_rev(&db), before, "the camera is not an undo step");

    for (x, y, zoom) in [
        (f64::NAN, 0.0, 1.0),
        (0.0, f64::INFINITY, 1.0),
        (0.0, 0.0, 0.0),
    ] {
        let error = db
            .save_view(x, y, zoom)
            .expect_err("an invalid camera must be refused");
        assert!(error.contains("camera"), "{error}");
    }
}

#[test]
fn set_title_changes_only_the_title_and_timestamp() {
    let (path, database) = temp_database("set-title");
    {
        let db = Database::open(&database).expect("open");
        // Age the row so the rename's timestamp write is observable; a
        // non-strict comparison would pass even if updated_at were untouched.
        db.run(|conn| {
            conn.execute_unprepared("UPDATE document SET updated_at = 0 WHERE id = 1")
                .map_err(|error| error.to_string())?;
            Ok(())
        })
        .expect("age the timestamp");
        let before = current_document(&db);
        assert_eq!(before.updated_at, 0);
        db.set_title("Renamed".to_owned()).expect("rename");
        let after = current_document(&db);
        assert_eq!(after.title, "Renamed");
        assert!(
            after.updated_at > before.updated_at,
            "the rename writes its timestamp"
        );
        assert_eq!(after.rev, before.rev, "the title is not an undo step");
        assert_eq!(after.created_at, before.created_at);
        db.close().expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert_eq!(db.project_info().expect("info").title, "Renamed");
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn set_title_refuses_an_invalid_or_closed_document() {
    let db = Database::open(":memory:").expect("open");
    for title in ["", "   ", "bad\0title"] {
        let error = db
            .set_title(title.to_owned())
            .expect_err("an invalid title must be refused");
        assert!(error.contains("title"), "{error}");
    }
    db.close().expect("close");
    assert_eq!(
        db.set_title("After close".to_owned()).err(),
        Some("the database is closed".to_owned())
    );
}

#[test]
fn project_info_reports_the_previous_shutdown_state() {
    let (path, database) = temp_database("opened-clean");
    {
        let db = Database::open(&database).expect("open");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a new package has nothing from a previous session"
        );
        db.close().expect("close");
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a clean close reopens clean"
        );
        // Dropping without close leaves the package dirty.
    }
    {
        let db = Database::open(&database).expect("reopen after an abandoned session");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "an abandoned session schedules verify"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

/// The lease the project store hands out is what a managed workspace opens:
/// `open_package` accepts its path and identity, `close` marks the package
/// clean, and a fresh lease on the same store proves the window slot and the
/// OS package lock were released.
#[test]
fn a_managed_session_opens_the_leased_package_and_closes_cleanly() {
    let temp = crate::project::test_support::TempRoot::new("managed");

    let (state, mut lease) = crate::project::test_support::create_and_lease(temp.path(), "Managed");
    let project_id = lease.project_id();
    // The lease recorded the package and its open time in the catalog before
    // the document touched it.
    let before = crate::project::test_support::catalog_list(temp.path());
    let before_row = before
        .iter()
        .find(|entry| entry.path == project_id)
        .expect("catalog row before the open");
    assert!(before_row.last_opened_at.is_some());
    let db = Database::open_package(&lease.database_path(), project_id.clone())
        .expect("open the leased package");
    let info = db.project_info().expect("project info");
    assert_eq!(info.project_id, project_id);
    assert_eq!(info.title, "Managed");
    assert!(info.opened_clean, "a freshly created package opens clean");
    assert_eq!(info.node_count, 0.0);
    db.close().expect("close the managed document");
    lease.release();

    // The managed session rewrote the package. The next list must re-read
    // it, store the closed package's stamp, and keep the open order.
    let after = crate::project::test_support::catalog_list(temp.path());
    let after_row = after
        .iter()
        .find(|entry| entry.path == project_id)
        .expect("catalog row after the close");
    assert_ne!(
        after_row.stamp, before_row.stamp,
        "the managed session changed the package"
    );
    assert_eq!(
        after_row.stamp,
        crate::project::test_support::catalog_stamp(temp.path(), &project_id),
        "the list stored the closed package's stamp"
    );
    assert_eq!(
        after_row.last_opened_at, before_row.last_opened_at,
        "the open order survives the re-read"
    );

    let mut second = crate::project::test_support::lease_from(&state, &project_id);
    let reopened = Database::open_package(&second.database_path(), project_id.clone())
        .expect("reopen after a clean close");
    assert!(
        reopened.project_info().expect("reopened info").opened_clean,
        "close marked the package clean"
    );
    reopened.close().expect("close the reopened document");
    second.release();
}
