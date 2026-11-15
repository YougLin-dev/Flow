//! The cross-process package lock.
//!
//! Ownership is the operating system's: an exclusive `try_lock` on
//! `<root>/.locks/<project_id>.lock`. Process death releases it, so there is
//! no stale-lock detection, heartbeat or steal path; the holder JSON written
//! through the locked handle is diagnostics only. The file is never
//! unlinked: unlinking after unlocking can split the inode and let a second
//! opener lock a path the first still holds.
//!
//! The lock file sits beside the package rather than inside it because
//! Windows refuses to rename a directory while any handle inside it is open.
//! Holding an in-package lock would make delete's rename-to-trash and
//! duplicate/import's final rename fail.

use std::fs::{self, File, TryLockError};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::clock;
use crate::project::paths;

/// The open-elsewhere error both the store and the OS lock report.
pub(crate) const OPEN_ELSEWHERE: &str = "the project is open in another window";

/// An exclusive lease on one package. Dropping it releases the OS lock.
pub(crate) struct PackageLock {
    file: File,
    project_id: String,
}

impl PackageLock {
    /// Takes the package lock without waiting. A concurrent holder in this
    /// process or any other means the package is open elsewhere.
    pub(crate) fn acquire(root: &Path, project_id: &str) -> Result<Self, String> {
        paths::validate_id(project_id)?;
        let directory = root.join(paths::LOCKS_DIR);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("the project lock could not be taken: {error}"))?;
        let path = paths::lock_path(root, project_id);
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| format!("the project lock could not be taken: {error}"))?;
        // A list refresh probes with a shared lock for the duration of one
        // probe; retrying briefly keeps that probe from being reported as a
        // real holder. A genuine holder keeps the lock, so the bounded wait
        // ends in OPEN_ELSEWHERE.
        let deadline = Instant::now() + Duration::from_millis(50);
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(OPEN_ELSEWHERE.to_owned());
                    }
                    sleep(Duration::from_millis(2));
                }
                Err(TryLockError::Error(error)) => {
                    return Err(format!("the project lock could not be taken: {error}"));
                }
            }
        }
        let lock = Self {
            file,
            project_id: project_id.to_owned(),
        };
        lock.write_holder();
        Ok(lock)
    }

    /// Best effort: a reader cannot read these bytes while the lock is held
    /// on Windows, so the JSON is for crash-site diagnostics, not protocol.
    fn write_holder(&self) {
        let holder = serde_json::json!({
            "version": 1,
            "pid": std::process::id(),
            "projectId": self.project_id,
            "openedAt": clock::now_ms(),
            "nonce": paths::unique_suffix(),
        });
        let mut handle = &self.file;
        let _ = handle.set_len(0);
        let _ = handle.seek(SeekFrom::Start(0));
        let _ = handle.write_all(holder.to_string().as_bytes());
        let _ = handle.flush();
    }
}

/// Whether another holder currently owns the package. A missing lock file,
/// an unreadable one or a probe error all report free: the open path then
/// reports the real failure instead of a misleading "open elsewhere".
pub(crate) fn is_open_elsewhere(root: &Path, project_id: &str) -> bool {
    if !paths::is_package_name(project_id) {
        return false;
    }
    let path = paths::lock_path(root, project_id);
    let Ok(file) = File::open(path) else {
        return false;
    };
    match file.try_lock_shared() {
        Ok(()) => false,
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("flow-lock-{label}-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        root
    }

    fn package(root: &Path, id: &str) {
        let dir = paths::package_dir(root, id);
        fs::create_dir_all(&dir).expect("package dir");
        fs::write(dir.join(paths::DATABASE_FILE), b"database").expect("database file");
    }

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn acquire_excludes_a_second_holder_and_release_reacquires() {
        let root = temp_root("exclusive");
        let first = PackageLock::acquire(&root, ID).expect("first lock");
        assert_eq!(
            PackageLock::acquire(&root, ID).err(),
            Some(OPEN_ELSEWHERE.to_owned())
        );
        drop(first);
        PackageLock::acquire(&root, ID).expect("reacquire after release");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_reports_held_and_released_without_creating_a_lock() {
        let root = temp_root("probe");
        assert!(!is_open_elsewhere(&root, ID));
        assert!(!paths::lock_path(&root, ID).exists());

        let held = PackageLock::acquire(&root, ID).expect("lock");
        assert!(is_open_elsewhere(&root, ID));
        drop(held);
        assert!(!is_open_elsewhere(&root, ID));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stale_holder_file_is_acquired_and_overwritten() {
        let root = temp_root("stale");
        let lock_path = paths::lock_path(&root, ID);
        fs::create_dir_all(lock_path.parent().expect("locks dir")).expect("locks dir");
        fs::write(&lock_path, b"{\"version\":1,\"pid\":999999}").expect("stale holder");
        let lock = PackageLock::acquire(&root, ID).expect("stale lock is free");
        drop(lock);
        let text = fs::read_to_string(&lock_path).expect("holder json");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid holder json");
        assert_eq!(parsed["projectId"], ID);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_package_directory_can_move_while_the_outside_lock_is_held() {
        let root = temp_root("rename");
        package(&root, ID);
        let lock = PackageLock::acquire(&root, ID).expect("lock");
        let moved = root.join(".moved");
        fs::rename(paths::package_dir(&root, ID), &moved).expect("rename under the lock");
        fs::rename(&moved, paths::package_dir(&root, ID)).expect("rename back");
        drop(lock);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_refuses_to_move_a_directory_with_an_open_handle_inside() {
        let root = temp_root("inside-handle");
        package(&root, ID);
        let held = fs::File::open(paths::package_dir(&root, ID).join(paths::DATABASE_FILE))
            .expect("open inside handle");
        let error = fs::rename(paths::package_dir(&root, ID), root.join(".moved"))
            .expect_err("Windows must refuse the rename");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        drop(held);
        let _ = fs::remove_dir_all(&root);
    }
}
