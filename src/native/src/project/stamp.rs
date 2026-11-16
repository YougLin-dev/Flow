//! Filesystem stamps for cached catalog rows.
//!
//! A readable catalog row is trusted only while the package it describes is
//! still the one that was read. The stamp is the length and modification time
//! of the database and its WAL sidecar: cheap to compare on every list, and
//! sensitive to a write that a closed package left in unmerged WAL frames. A
//! zero-length WAL holds no frames and is ignored: opening a WAL-mode package
//! may create or remove one, which must not look like a change. The stamp is
//! a freshness hint, not a hash: a coarse filesystem can miss a same-length
//! change inside one timestamp tick. Such a row stays trusted until a later
//! write changes the metadata again; only a deep refresh (or a new catalog)
//! repairs that miss.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::project::paths;

/// One file's identity for cache invalidation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileStamp {
    pub len: u64,
    pub mtime_ns: i64,
}

/// The database and optional WAL of one package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackageStamp {
    pub database: FileStamp,
    pub wal: Option<FileStamp>,
}

/// The stamp of a package directory, or `None` when a file that must be
/// inspected cannot be: a missing database, a symlink, or unreadable
/// metadata. A cached row without a stamp is never trusted.
pub(crate) fn package_stamp(dir: &Path) -> Option<PackageStamp> {
    let database = file_stamp(&dir.join(paths::DATABASE_FILE))?;
    // `Ok(None)` means the sidecar does not exist; any inspection failure
    // makes the whole package unstampable rather than "no WAL". A sidecar
    // without frames carries no state: reading a WAL-mode package may create
    // or remove an empty one, so its presence is not part of the identity.
    let wal = file_stamp_status(&dir.join(format!("{}-wal", paths::DATABASE_FILE)))
        .ok()?
        .filter(|stamp| stamp.len > 0);
    Some(PackageStamp { database, wal })
}

/// A missing file is `Ok(None)`; a regular file is its stamp. A symlink or
/// another file type is refused so a forged catalog cannot trust it.
fn file_stamp_status(path: &Path) -> Result<Option<FileStamp>, ()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            stamp_of(&metadata).map(Some)
        }
        Ok(_) => Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    stamp_of(&metadata).ok()
}

fn stamp_of(metadata: &fs::Metadata) -> Result<FileStamp, ()> {
    let elapsed = metadata
        .modified()
        .map_err(|_| ())?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?;
    let mtime_ns = i64::try_from(elapsed.as_nanos()).map_err(|_| ())?;
    Ok(FileStamp {
        len: metadata.len(),
        mtime_ns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::test_support::TempRoot;

    #[test]
    fn a_package_without_a_database_has_no_stamp() {
        let temp = TempRoot::new("stamp-missing");
        assert_eq!(package_stamp(temp.path()), None);
    }

    #[test]
    fn the_stamp_tracks_the_database_and_its_wal() {
        let temp = TempRoot::new("stamp-track");
        let dir = temp.path();
        fs::write(dir.join(paths::DATABASE_FILE), b"one").expect("database");
        let without_wal = package_stamp(dir).expect("stamp");
        assert!(without_wal.wal.is_none());

        let wal = dir.join(format!("{}-wal", paths::DATABASE_FILE));
        fs::write(&wal, b"").expect("empty wal");
        assert!(
            package_stamp(dir).expect("stamp").wal.is_none(),
            "an empty WAL carries no state"
        );

        fs::write(&wal, b"frames").expect("wal");
        let with_wal = package_stamp(dir).expect("stamp");
        assert!(with_wal.wal.is_some());
        assert_ne!(with_wal, without_wal, "adding WAL frames changes the stamp");

        fs::write(dir.join(paths::DATABASE_FILE), b"a longer database").expect("database");
        let rewritten = package_stamp(dir).expect("stamp");
        assert_ne!(
            rewritten.database, with_wal.database,
            "rewriting the database changes its stamp"
        );
    }
}
