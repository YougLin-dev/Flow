//! Durable filesystem helpers for package commits.
//!
//! A package becomes visible through a single directory rename, so the files
//! inside it must be on disk before the rename. Windows also holds directory
//! handles briefly (indexers, antivirus), which turns a rename or removal
//! that is legal in principle into a transient `PermissionDenied`; those few
//! operations retry instead of failing the user's action.

use std::fs;
use std::io;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

const ATTEMPTS: u32 = 5;
const RETRY_DELAY: Duration = Duration::from_millis(10);

/// Flushes a file's contents and metadata to disk. Windows refuses
/// `FlushFileBuffers` on a handle without write access, so the file is
/// opened read-write even though nothing is written.
pub(crate) fn sync_file(path: &Path) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

/// Flushes a directory entry list. Directories cannot be opened as plain
/// files on Windows; `FILE_FLAG_BACKUP_SEMANTICS` permits it there.
pub(crate) fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let handle = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
    };
    #[cfg(not(windows))]
    let handle = fs::File::open(path);
    handle
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

/// Directory fsync is a durability nicety, not a correctness requirement on
/// Windows; callers ignore a refusal to flush one.
pub(crate) fn sync_dir_best_effort(path: &Path) {
    let _ = sync_dir(path);
}

/// Renames, retrying the transient sharing violation Windows file indexers
/// and antivirus scanners cause.
pub(crate) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    retry(|| fs::rename(from, to))
}

/// Removes a tree, retrying the same transient sharing violation. A file
/// that is still held leaves the tree in place for the residue sweep.
pub(crate) fn remove_dir_all(path: &Path) -> io::Result<()> {
    retry(|| fs::remove_dir_all(path))
}

fn retry<T>(mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 1;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && attempt < ATTEMPTS => {
                sleep(RETRY_DELAY);
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_and_remove_retry_helpers_move_and_delete() {
        let root = std::env::temp_dir().join(format!(
            "flow-fsutil-{}-{}",
            std::process::id(),
            crate::clock::now_ms()
        ));
        fs::create_dir_all(root.join("from")).expect("from dir");
        fs::write(root.join("from").join("file"), b"x").expect("write file");
        sync_file(&root.join("from").join("file")).expect("sync file");
        sync_dir(&root).expect("sync dir");

        rename(&root.join("from"), &root.join("to")).expect("rename");
        assert!(!root.join("from").exists());
        assert!(root.join("to").join("file").is_file());
        remove_dir_all(&root.join("to")).expect("remove");
        assert!(!root.join("to").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
