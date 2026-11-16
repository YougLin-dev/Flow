//! Worker queue and history-lock ordering tests.

use super::*;
use crate::db::undo::lock_history;

#[test]
fn a_panicking_job_is_reported_and_the_worker_survives() {
    let db = Database::open(":memory:").expect("open");
    let error = db
        .run(|_| -> Result<(), String> { panic!("deliberate job panic") })
        .expect_err("a panicking job must report an error");
    assert!(error.contains("panicked"), "{error}");
    assert_eq!(db.count().expect("count after a panic"), 0);
}

#[test]
fn clear_history_is_ordered_after_an_earlier_job() {
    let db = Database::open(":memory:").expect("open");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();

    let history = Arc::clone(&db.history);
    let job_db = db.clone();
    let job = std::thread::spawn(move || {
        job_db.run(move |_| {
            started_tx.send(()).expect("signal the job started");
            release_rx.recv().expect("wait for release");
            lock_history(&history)?.push(HistoryEntry::new(
                vec![HistoryOp::Delete {
                    id: "pending".to_owned(),
                }],
                Vec::new(),
                &HistoryRefs::default(),
            ));
            Ok(())
        })
    });

    started_rx.recv().expect("worker started the job");
    let (clear_started_tx, clear_started_rx) = mpsc::channel();
    let (cleared_tx, cleared_rx) = mpsc::channel();
    let clear_db = db.clone();
    let clear = std::thread::spawn(move || {
        clear_started_tx.send(()).expect("signal clear started");
        let result = clear_db.clear_history();
        let _ = cleared_tx.send(());
        result
    });
    clear_started_rx.recv().expect("clear thread started");
    assert!(
        cleared_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "clear_history must wait for the earlier job"
    );
    release_tx.send(()).expect("release the job");

    job.join().expect("job thread").expect("blocking job");
    clear.join().expect("clear thread").expect("clear history");

    assert!(
        db.history.lock().expect("history").take_undo().is_none(),
        "clear_history must run after the earlier job pushed its entry"
    );
}

#[test]
fn a_poisoned_history_lock_is_reported() {
    let db = Database::open(":memory:").expect("open");
    let history = Arc::clone(&db.history);
    let poisoned = std::thread::spawn(move || {
        let _guard = history.lock().expect("lock history");
        panic!("deliberate history poison");
    });
    assert!(poisoned.join().is_err(), "the helper thread must panic");

    let error = db
        .insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .map(|_| ())
        .expect_err("a poisoned history lock must fail before the write");
    assert!(error.contains("poisoned"), "{error}");
    assert_eq!(db.count().expect("count after a poisoned write"), 0);

    let error = db
        .clear_history()
        .expect_err("a poisoned history lock must report an error");
    assert!(error.contains("poisoned"), "{error}");
    assert_eq!(db.count().expect("count after a poisoned clear"), 0);
}
