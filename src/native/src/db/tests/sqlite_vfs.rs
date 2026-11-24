//! Regression coverage for the SQLite 3.51.1 unix VFS lock-order inversion.
//!
//! Concurrent opens and closes of one WAL database must finish; on the
//! unfixed amalgamation two threads can hold `unixBigLock` and the per-inode
//! `pLockMutex` in opposite order, and every later SQLite call blocks.

use std::{
    sync::{Arc, Barrier, mpsc},
    time::Duration,
};

use rusqlite::Connection;

const THREADS: usize = 8;
const ROUNDS: usize = 500;

#[test]
fn concurrent_wal_open_and_close_does_not_deadlock() {
    let dir = std::env::temp_dir().join(format!(
        "flow-sqlite-vfs-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the database directory");
    let path = dir.join("document.sqlite");
    {
        let conn = Connection::open(&path).expect("create the WAL database");
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);",
        )
        .expect("initialize the WAL database");
    }

    let barrier = Arc::new(Barrier::new(THREADS));
    let (done, received) = mpsc::channel();
    let mut threads = Vec::with_capacity(THREADS);
    for _ in 0..THREADS {
        let barrier = Arc::clone(&barrier);
        let done = done.clone();
        let path = path.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..ROUNDS {
                let conn = Connection::open(&path).expect("open the WAL database");
                conn.busy_timeout(Duration::from_secs(5))
                    .expect("set the busy timeout");
                let _: i64 = conn
                    .query_row("SELECT count(*) FROM t", [], |row| row.get(0))
                    .expect("read the WAL database");
            }
            done.send(()).expect("report a finished worker");
        }));
    }
    for _ in 0..THREADS {
        received
            .recv_timeout(Duration::from_secs(30))
            .expect("concurrent WAL opens and closes deadlocked");
    }
    for thread in threads {
        thread.join().expect("the SQLite worker panicked");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
