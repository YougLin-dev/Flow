//! The derived project list: `<root>/catalog.json`.
//!
//! The packages on disk are the source of truth; the catalog only saves
//! reopening every package on startup. It is validated strictly, rebuilt on
//! any doubt, and written atomically. Entries are keyed by their root-relative
//! 32-hex directory name, never by an absolute path, so a tampered cache
//! cannot point outside the root and moving the root keeps it valid.
//!
//! A package that fails identity reading is still listed with a fallback
//! entry (title = directory name, `updated_at = 0`) so it is not silently
//! lost; opening or mutating it still fails its identity guard. A readable
//! cached entry is trusted while reconciling only when its package stamp
//! still matches the files on disk; a fallback row, one whose identity no
//! longer matches its directory, or one whose stamp changed is re-read on
//! that list, so recovery and out-of-band changes surface without a manual
//! refresh. The row is then written with the new stamp, so a quiet package
//! is not reopened again.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde_json::{Value, json};

use crate::project::package;
use crate::project::paths;
use crate::project::stamp::{self, PackageStamp};
use crate::schema::v1;

/// The catalog format this build understands. Version 1 had no package
/// stamp; it is rebuilt once rather than trusted.
const VERSION: i64 = 2;
/// A catalog larger than this is not ours; rebuilding is cheaper than
/// trusting it.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    /// The root-relative package directory name.
    pub path: String,
    pub project_id: String,
    pub title: String,
    pub updated_at: i64,
    /// Best-effort ordering metadata (the frozen schema has no column for
    /// it); lost when a corrupt catalog is rebuilt.
    pub last_opened_at: Option<i64>,
    /// True when this row is a directory fallback: the package could not be
    /// read at the last scan. The list re-reads these, so a package that
    /// recovers keeps its title without a manual refresh. The flag is stored
    /// rather than inferred from a title equal to the directory, because a
    /// readable package may legitimately have such a title.
    pub fallback: bool,
    /// The package files at the time this row was read. The list trusts a
    /// readable row only when this still matches; `None` never matches.
    pub stamp: Option<PackageStamp>,
}

/// Lists the projects, reconciling a valid catalog with the directories on
/// disk. An invalid or missing catalog is rebuilt from scratch. New entries
/// are read from their packages; a readable cached entry is trusted only
/// while its package stamp still matches, while a fallback row, one whose
/// identity differs from its directory, or one whose stamp changed is
/// re-read.
pub(crate) fn list(root: &Path) -> Result<Vec<Entry>, String> {
    let candidates = scan(root)?;
    let Some(previous) = load_valid(root) else {
        return rebuild(root, &candidates, HashMap::new());
    };
    let mut known: HashMap<String, Entry> = previous
        .iter()
        .cloned()
        .map(|e| (e.path.clone(), e))
        .collect();
    let mut entries = Vec::with_capacity(candidates.len());
    for (path, dir) in &candidates {
        // One stat per candidate, taken before identity is read. If the
        // package changes during the read, the stored stamp stays older than
        // the files and the next list reads it again.
        let current = stamp::package_stamp(dir);
        match known.remove(path) {
            // A cached entry whose identity differs from its directory is
            // stale (the package changed out of band); list rows must carry
            // the directory as their operation key, so re-read it. A cached
            // fallback is likewise re-read so a package that was briefly
            // unreadable recovers its title without a manual refresh. A
            // readable entry is trusted only while its stamp still matches.
            Some(entry)
                if entry.project_id == *path
                    && !is_fallback(&entry)
                    && entry.stamp.is_some()
                    && entry.stamp == current =>
            {
                entries.push(entry);
            }
            Some(previous) => {
                // Reading a changed package keeps the row's last-opened
                // ordering metadata; only a stored identity that disagrees
                // with its directory drops it. A fallback keeps it too, so a
                // stable unreadable row does not rewrite the catalog on
                // every list.
                let mut entry = read_candidate(path, dir, current);
                if entry.project_id == previous.project_id {
                    entry.last_opened_at = previous.last_opened_at;
                }
                entries.push(entry);
            }
            None => entries.push(read_candidate(path, dir, current)),
        }
    }
    sort_entries(&mut entries);
    let mut previous = previous;
    sort_entries(&mut previous);
    // Entries for vanished packages were dropped above; new packages were
    // added. Persist only when the set really changed.
    if entries != previous {
        merge_open_times(root, &mut entries);
        let _ = write(root, &entries);
    }
    Ok(entries)
}

/// Rebuilds every entry from its package, preserving `last_opened_at` only
/// for a package whose path and identity both match the previous catalog.
pub(crate) fn refresh(root: &Path) -> Result<Vec<Entry>, String> {
    let candidates = scan(root)?;
    let preserved = load_valid(root)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.path.clone(), (entry.project_id, entry.last_opened_at)))
        .collect();
    rebuild(root, &candidates, preserved)
}

fn rebuild(
    root: &Path,
    candidates: &[(String, std::path::PathBuf)],
    preserved: HashMap<String, (String, Option<i64>)>,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::with_capacity(candidates.len());
    for (path, dir) in candidates {
        let mut entry = read_candidate(path, dir, stamp::package_stamp(dir));
        if let Some((project_id, last_opened_at)) = preserved.get(path)
            && *project_id == entry.project_id
        {
            entry.last_opened_at = *last_opened_at;
        }
        entries.push(entry);
    }
    sort_entries(&mut entries);
    merge_open_times(root, &mut entries);
    let _ = write(root, &entries);
    Ok(entries)
}

/// Carries a concurrently recorded open time into a whole-file rewrite and
/// restores recency order (a merged time can move a row). `last_opened_at`
/// is not derivable from a package, so a rewrite built from an older
/// snapshot must not drop another window's `mark_opened`. Only a matching
/// path and identity carries the value; the later time wins.
fn merge_open_times(root: &Path, entries: &mut [Entry]) {
    let Some(latest) = load_valid(root) else {
        return;
    };
    let mut open_times: HashMap<String, (String, Option<i64>)> = latest
        .into_iter()
        .map(|entry| (entry.path, (entry.project_id, entry.last_opened_at)))
        .collect();
    for entry in entries.iter_mut() {
        let Some((project_id, at)) = open_times.remove(&entry.path) else {
            continue;
        };
        if project_id != entry.project_id {
            continue;
        }
        entry.last_opened_at = match (entry.last_opened_at, at) {
            (Some(ours), Some(theirs)) => Some(ours.max(theirs)),
            (ours, theirs) => ours.or(theirs),
        };
    }
    sort_entries(entries);
}

/// Whether this row is a directory fallback rather than a read package.
pub(crate) fn is_fallback(entry: &Entry) -> bool {
    entry.fallback
}

/// Reads one candidate package; a package that cannot be read — or whose
/// document identity does not match its directory — still gets a visible
/// fallback entry keyed by the directory. Every listed entry's `project_id`
/// is therefore the operation key the store resolves.
fn read_candidate(path: &str, dir: &Path, stamp: Option<PackageStamp>) -> Entry {
    match package::read_identity(&dir.join(paths::DATABASE_FILE)) {
        Ok(identity) if identity.project_id == path => Entry {
            path: path.to_owned(),
            project_id: identity.project_id,
            title: identity.title,
            updated_at: identity.updated_at,
            last_opened_at: None,
            fallback: false,
            stamp,
        },
        _ => Entry {
            path: path.to_owned(),
            project_id: path.to_owned(),
            title: path.to_owned(),
            updated_at: 0,
            last_opened_at: None,
            fallback: true,
            // A fallback is re-read on every list and has no readable
            // identity for the stamp to protect.
            stamp: None,
        },
    }
}

/// The package directories directly under the root: 32-hex names, real
/// directories, with a regular database file. Symlinks and residue are
/// ignored.
fn scan(root: &Path) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|error| format!("the projects directory could not be read: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("the projects directory could not be read: {error}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !paths::is_package_name(name) {
            continue;
        }
        let dir = entry.path();
        if !paths::is_real_dir(&dir) {
            continue;
        }
        if !paths::is_regular_file(&dir.join(paths::DATABASE_FILE)) {
            continue;
        }
        candidates.push((name.to_owned(), dir));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates)
}

/// Stores one entry, replacing the entry for the same directory.
pub(crate) fn upsert(root: &Path, entry: Entry) -> Result<(), String> {
    let mut entries = load_valid(root).unwrap_or_default();
    entries.retain(|existing| existing.path != entry.path);
    entries.push(entry);
    sort_entries(&mut entries);
    write(root, &entries)
}

/// Drops the entry for a deleted package directory.
pub(crate) fn remove(root: &Path, project_id: &str) -> Result<(), String> {
    let mut entries = load_valid(root).unwrap_or_default();
    entries.retain(|entry| entry.path != project_id);
    sort_entries(&mut entries);
    write(root, &entries)
}

/// Records that a project was opened. Ordering metadata only; failure is not
/// worth interrupting the open.
pub(crate) fn mark_opened(root: &Path, project_id: &str, at: i64) -> Result<(), String> {
    let mut entries = load_valid(root).unwrap_or_default();
    let Some(entry) = entries.iter_mut().find(|entry| entry.path == project_id) else {
        return Ok(());
    };
    entry.last_opened_at = Some(at);
    sort_entries(&mut entries);
    write(root, &entries)
}

/// Loads a catalog only when every byte of it validates. Missing, unreadable
/// and malformed files all mean "rebuild".
pub(crate) fn load_valid(root: &Path) -> Option<Vec<Entry>> {
    let path = paths::catalog_path(root);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    parse_entries(&value)
}

fn parse_stamp(value: &Value) -> Option<PackageStamp> {
    let object = value.as_object()?;
    let database = parse_file_stamp(object.get("database")?)?;
    let wal = match object.get("wal")? {
        Value::Null => None,
        value => Some(parse_file_stamp(value)?),
    };
    Some(PackageStamp { database, wal })
}

fn parse_file_stamp(value: &Value) -> Option<stamp::FileStamp> {
    let object = value.as_object()?;
    let len = object.get("len")?.as_u64()?;
    let mtime_ns = object.get("mtime_ns")?.as_i64()?;
    if mtime_ns < 0 {
        return None;
    }
    Some(stamp::FileStamp { len, mtime_ns })
}

fn parse_entries(value: &Value) -> Option<Vec<Entry>> {
    let object = value.as_object()?;
    if object.get("version")?.as_i64()? != VERSION {
        return None;
    }
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for item in object.get("entries")?.as_array()? {
        let item = item.as_object()?;
        let path = item.get("path")?.as_str()?;
        let project_id = item.get("project_id")?.as_str()?;
        let title = item.get("title")?.as_str()?;
        let updated_at = item.get("updated_at")?.as_i64()?;
        let last_opened_at = match item.get("last_opened_at")? {
            Value::Null => None,
            value => Some(value.as_i64()?),
        };
        let fallback = match item.get("fallback")? {
            Value::Bool(fallback) => *fallback,
            _ => return None,
        };
        let stamp = match item.get("stamp")? {
            Value::Null => None,
            value => Some(parse_stamp(value)?),
        };
        if !paths::is_package_name(path) || !paths::is_package_name(project_id) {
            return None;
        }
        if v1::validate_title(title).is_err() {
            return None;
        }
        if updated_at < 0 || last_opened_at.is_some_and(|value| value < 0) {
            return None;
        }
        if !seen.insert(path.to_owned()) {
            return None;
        }
        entries.push(Entry {
            path: path.to_owned(),
            project_id: project_id.to_owned(),
            title: title.to_owned(),
            updated_at,
            last_opened_at,
            fallback,
            stamp,
        });
    }
    Some(entries)
}

/// Writes the catalog through a synced temp file and one rename. On any
/// failure the temp file is removed and the old catalog stays intact.
pub(crate) fn write(root: &Path, entries: &[Entry]) -> Result<(), String> {
    let serialized = serde_json::to_vec(&json!({
        "version": VERSION,
        "entries": entries
            .iter()
            .map(|entry| json!({
                "path": entry.path,
                "project_id": entry.project_id,
                "title": entry.title,
                "updated_at": entry.updated_at,
                "last_opened_at": entry.last_opened_at,
                "fallback": entry.fallback,
                "stamp": entry.stamp.as_ref().map(|stamp| json!({
                    "database": {
                        "len": stamp.database.len,
                        "mtime_ns": stamp.database.mtime_ns,
                    },
                    "wal": stamp.wal.map(|wal| json!({
                        "len": wal.len,
                        "mtime_ns": wal.mtime_ns,
                    })),
                })),
            }))
            .collect::<Vec<_>>(),
    }))
    .expect("a catalog of strings and integers serializes");
    let temp = root.join(format!(".catalog.json.tmp-{}", paths::unique_suffix()));
    let outcome = write_temp(&temp, &serialized).and_then(|()| {
        crate::fsutil::rename(&temp, &paths::catalog_path(root)).map_err(|error| error.to_string())
    });
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome.map_err(|error| format!("the project list could not be saved: {error}"))?;
    crate::fsutil::sync_dir_best_effort(root);
    Ok(())
}

fn write_temp(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let result: io::Result<()> = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    result.map_err(|error| error.to_string())
}

/// Newest-opened first (never-opened last), then newest-updated, then
/// case-insensitive title, then directory for a total order.
fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        let recency = match (a.last_opened_at, b.last_opened_at) {
            (Some(a), Some(b)) => b.cmp(&a),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        recency
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    use super::*;
    use crate::project::test_support::TempRoot;

    /// Creates a valid package under a temp name, then moves it to its
    /// minted identity's directory. Returns the id.
    fn package(temp: &TempRoot, title: &str) -> String {
        let dir = paths::create_temp_dir(temp.path(), "test").expect("temp dir");
        let database = dir.join(paths::DATABASE_FILE);
        let url = crate::db::sqlite_url(&database.to_string_lossy()).expect("url");
        let conn = Database::connect(url).expect("connect");
        v1::create(&conn, title).expect("create v1");
        crate::schema::package::mark_clean(&conn).expect("mark clean");
        let id = crate::document::current(&conn)
            .expect("document")
            .project_id;
        drop(conn);
        fs::rename(&dir, temp.path().join(&id)).expect("move package into place");
        id
    }

    /// A valid package installed under a chosen directory id.
    fn package_with_id(temp: &TempRoot, title: &str, id: &str) {
        let dir = paths::create_temp_dir(temp.path(), "test").expect("temp dir");
        let database = dir.join(paths::DATABASE_FILE);
        let url = crate::db::sqlite_url(&database.to_string_lossy()).expect("url");
        let conn = Database::connect(url).expect("connect");
        v1::create(&conn, title).expect("create v1");
        crate::schema::package::remint_project_id(&conn, id, title, 1, 1).expect("rekey");
        drop(conn);
        fs::rename(&dir, temp.path().join(id)).expect("install package");
    }

    /// A directory with the given 32-hex name that is not a Flow package.
    fn foreign(temp: &TempRoot, id: &str) {
        let dir = temp.path().join(id);
        fs::create_dir_all(&dir).expect("foreign dir");
        fs::write(dir.join(paths::DATABASE_FILE), b"not a database").expect("foreign db");
    }

    fn catalog(temp: &TempRoot) -> Value {
        let bytes = fs::read(paths::catalog_path(temp.path())).expect("read catalog");
        serde_json::from_slice(&bytes).expect("catalog json")
    }

    /// A readable cached row carrying the package's current stamp, as every
    /// writer of the catalog stores it.
    fn stored_entry(
        temp: &TempRoot,
        id: &str,
        title: &str,
        updated_at: i64,
        last_opened_at: Option<i64>,
    ) -> Entry {
        Entry {
            path: id.to_owned(),
            project_id: id.to_owned(),
            title: title.to_owned(),
            updated_at,
            last_opened_at,
            fallback: false,
            stamp: stamp::package_stamp(&paths::package_dir(temp.path(), id)),
        }
    }

    const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn list_rebuilds_invalid_catalogs_from_the_directories() {
        let valid = |path: &str| {
            serde_json::json!({
                "path": path,
                "project_id": ID_A,
                "title": "A",
                "updated_at": 1,
                "last_opened_at": null,
                "fallback": false,
                "stamp": {"database": {"len": 0, "mtime_ns": 0}, "wal": null},
            })
        };
        for (label, contents) in [
            ("missing", None),
            ("truncated", Some("{\"version\":2,\"entries\":[".to_owned())),
            ("version", Some("{\"version\":3,\"entries\":[]}".to_owned())),
            (
                "duplicate",
                Some(
                    serde_json::json!({
                        "version": VERSION,
                        "entries": [valid(ID_A), valid(ID_A)],
                    })
                    .to_string(),
                ),
            ),
            (
                "escape",
                Some(
                    serde_json::json!({
                        "version": VERSION,
                        "entries": [valid(&format!("../{ID_A}"))],
                    })
                    .to_string(),
                ),
            ),
        ] {
            let temp = TempRoot::new(label);
            let id = package(&temp, "Real");
            if let Some(contents) = contents {
                fs::write(paths::catalog_path(temp.path()), contents).expect("write catalog");
            }
            let entries = list(temp.path()).expect("list");
            assert_eq!(entries.len(), 1, "{label}: rebuilt from directories");
            assert_eq!(entries[0].path, id);
            assert_eq!(entries[0].title, "Real");
            assert_eq!(catalog(&temp)["version"], VERSION);
        }
    }

    #[test]
    fn list_drops_vanished_packages_and_adds_unknown_ones() {
        let temp = TempRoot::new("reconcile");
        let kept = package(&temp, "Kept");
        write(
            temp.path(),
            &[stored_entry(&temp, &kept, "Kept", 1, Some(7))],
        )
        .expect("write catalog");
        let added = package(&temp, "Added");
        fs::create_dir_all(temp.path().join(ID_B)).expect("empty dir");

        let entries = list(temp.path()).expect("list");
        let paths: HashSet<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, HashSet::from([kept.as_str(), added.as_str()]));
        let known = entries
            .iter()
            .find(|entry| entry.path == kept)
            .expect("kept");
        assert_eq!(known.last_opened_at, Some(7), "known entry is not reopened");
        assert_eq!(known.title, "Kept");
        let new = entries
            .iter()
            .find(|entry| entry.path == added)
            .expect("added");
        assert_eq!(new.title, "Added");
        let stored = catalog(&temp);
        let stored_paths: Vec<&str> = stored["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| entry["path"].as_str().expect("path"))
            .collect();
        assert!(stored_paths.contains(&kept.as_str()));
        assert!(stored_paths.contains(&added.as_str()));
    }

    #[test]
    fn residue_directories_are_never_listed() {
        let temp = TempRoot::new("residue");
        let id = package(&temp, "Real");
        let residue = temp
            .path()
            .join(format!(".create-{}", paths::unique_suffix()));
        fs::create_dir_all(&residue).expect("residue dir");
        fs::write(residue.join(paths::DATABASE_FILE), b"junk").expect("residue db");
        let entries = list(temp.path()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, id);
    }

    #[test]
    fn unreadable_packages_stay_visible_as_fallback_entries() {
        let temp = TempRoot::new("fallback");
        foreign(&temp, ID_A);
        let entries = list(temp.path()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, ID_A);
        assert_eq!(entries[0].project_id, ID_A);
        assert_eq!(entries[0].title, ID_A);
        assert_eq!(entries[0].updated_at, 0);
        assert!(entries[0].last_opened_at.is_none());
        assert!(is_fallback(&entries[0]));
        assert!(
            entries[0].stamp.is_none(),
            "a fallback has no readable package to stamp"
        );
    }

    #[test]
    fn list_reuses_a_cached_row_whose_stamp_matches() {
        let temp = TempRoot::new("matching-stamp");
        let id = package(&temp, "Real");
        // A forged title with the package's real stamp is trusted: the list
        // does not reopen a package whose files did not change.
        write(
            temp.path(),
            &[stored_entry(&temp, &id, "Cached", 42, Some(7))],
        )
        .expect("write catalog");

        let entries = list(temp.path()).expect("list");
        assert_eq!(entries[0].title, "Cached");
        assert_eq!(entries[0].updated_at, 42);
        assert_eq!(entries[0].last_opened_at, Some(7));
    }

    #[test]
    fn list_rereads_a_cached_row_whose_package_changed() {
        let temp = TempRoot::new("changed-stamp");
        let id = package(&temp, "Before");
        let entries = list(temp.path()).expect("first list");
        assert_eq!(entries[0].title, "Before");
        mark_opened(temp.path(), &id, 77).expect("mark opened");

        // Change the title out of band, as another build or a restore would.
        let database = paths::database_path(temp.path(), &id);
        let conn =
            Database::connect(crate::db::sqlite_url(&database.to_string_lossy()).expect("url"))
                .expect("connect");
        conn.execute_raw(Statement::from_string(
            DbBackend::Sqlite,
            "UPDATE document SET title = 'After', updated_at = 9 WHERE id = 1".to_owned(),
        ))
        .expect("rename out of band");
        drop(conn);
        // Force a distinct stamp even on a coarse filesystem: the point is
        // the invalidation gate, not this platform's timestamp resolution.
        fs::OpenOptions::new()
            .write(true)
            .open(&database)
            .expect("open database")
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(1))
            .expect("bump the modification time");

        let entries = list(temp.path()).expect("second list");
        assert_eq!(entries[0].title, "After", "the changed package is re-read");
        assert_eq!(entries[0].updated_at, 9);
        assert_eq!(
            entries[0].last_opened_at,
            Some(77),
            "a re-read keeps the row's open order"
        );
    }

    #[test]
    fn a_cached_fallback_is_reread_after_the_package_recovers() {
        let temp = TempRoot::new("fallback-recovery");
        foreign(&temp, ID_A);
        let entries = list(temp.path()).expect("first list");
        assert_eq!(entries[0].title, ID_A);
        assert_eq!(entries[0].updated_at, 0);

        fs::remove_dir_all(temp.path().join(ID_A)).expect("remove the foreign package");
        package_with_id(&temp, "Recovered", ID_A);

        let entries = list(temp.path()).expect("second list");
        assert_eq!(entries[0].project_id, ID_A);
        assert_eq!(entries[0].title, "Recovered");
        assert_eq!(
            entries[0].updated_at, 1,
            "the real row replaces the fallback"
        );
    }

    #[test]
    fn a_mismatched_identity_is_a_fallback_keyed_by_its_directory() {
        let temp = TempRoot::new("mismatch");
        let real = package(&temp, "Real");
        let forged = ID_A;
        fs::rename(temp.path().join(&real), temp.path().join(forged)).expect("forge directory");
        let entries = list(temp.path()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, forged);
        assert_eq!(
            entries[0].project_id, forged,
            "the operation key is the directory, not the document identity"
        );
        assert_eq!(entries[0].title, forged);
        assert_eq!(entries[0].updated_at, 0);
    }

    #[test]
    fn a_readable_package_whose_title_matches_its_directory_stays_readable() {
        let temp = TempRoot::new("title-collision");
        // A legal package may be titled with its own 32-hex identity and
        // carry a zero timestamp; neither makes it a fallback row.
        package_with_id(&temp, ID_A, ID_A);
        let database = paths::database_path(temp.path(), ID_A);
        let conn =
            Database::connect(crate::db::sqlite_url(&database.to_string_lossy()).expect("url"))
                .expect("connect");
        conn.execute_raw(Statement::from_string(
            DbBackend::Sqlite,
            "UPDATE document SET updated_at = 0 WHERE id = 1".to_owned(),
        ))
        .expect("zero the update time");
        drop(conn);

        let entries = list(temp.path()).expect("first list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, ID_A);
        assert!(!is_fallback(&entries[0]));
        assert_eq!(catalog(&temp)["entries"][0]["fallback"], false);

        let entries = list(temp.path()).expect("cached list");
        assert!(
            !is_fallback(&entries[0]),
            "the stored flag is not re-inferred"
        );
    }

    #[test]
    fn a_version_1_catalog_is_rebuilt_once() {
        let temp = TempRoot::new("v1-catalog");
        let id = package(&temp, "Real");
        foreign(&temp, ID_B);
        // Version 1 had no stamp, so it cannot be trusted; it is discarded
        // and rebuilt from the directories rather than read with defaults.
        fs::write(
            paths::catalog_path(temp.path()),
            format!(
                "{{\"version\":1,\"entries\":[{{\"path\":\"{id}\",\"project_id\":\"{id}\",\"title\":\"Stale\",\"updated_at\":1,\"last_opened_at\":null}},{{\"path\":\"{ID_B}\",\"project_id\":\"{ID_B}\",\"title\":\"{ID_B}\",\"updated_at\":0,\"last_opened_at\":null}}]}}"
            ),
        )
        .expect("v1 catalog");

        let entries = list(temp.path()).expect("list");
        let readable = entries
            .iter()
            .find(|entry| entry.path == id)
            .expect("readable row");
        assert_eq!(readable.title, "Real", "the package is read again");
        assert!(!is_fallback(readable));
        assert!(readable.stamp.is_some(), "the rebuilt row carries a stamp");
        let fallback = entries
            .iter()
            .find(|entry| entry.path == ID_B)
            .expect("fallback row");
        assert!(is_fallback(fallback));
        let stored = catalog(&temp);
        assert_eq!(stored["version"], VERSION, "the rebuilt file is version 2");
    }

    #[test]
    fn a_rewrite_carries_only_a_matching_concurrent_open_time() {
        let temp = TempRoot::new("merge-open");
        let first = package(&temp, "First");
        let second = package(&temp, "Second");
        // The rewrite's snapshot predates another window marking the first
        // project opened; only that row's open time may be carried.
        write(
            temp.path(),
            &[
                stored_entry(&temp, &first, "First", 1, Some(9)),
                stored_entry(&temp, &second, "Second", 2, Some(8)),
            ],
        )
        .expect("disk catalog");
        let mut entries = vec![
            Entry {
                project_id: ID_B.to_owned(),
                ..stored_entry(&temp, &second, "Second", 2, None)
            },
            stored_entry(&temp, &first, "First", 1, None),
        ];

        merge_open_times(temp.path(), &mut entries);
        assert_eq!(
            entries[0].last_opened_at,
            Some(9),
            "the merged open time outranks recency"
        );
        assert_eq!(
            entries[0].title, "First",
            "the merge restores recency order"
        );
        assert_eq!(
            entries[1].last_opened_at, None,
            "an identity mismatch does not carry another package's open time"
        );
    }

    #[test]
    fn a_stable_fallback_is_not_rewritten_on_every_list() {
        let temp = TempRoot::new("fallback-stable");
        foreign(&temp, ID_A);
        write(
            temp.path(),
            &[Entry {
                path: ID_A.to_owned(),
                project_id: ID_A.to_owned(),
                title: ID_A.to_owned(),
                updated_at: 0,
                last_opened_at: Some(77),
                fallback: true,
                stamp: None,
            }],
        )
        .expect("write catalog");
        // Age the catalog: a rewrite through the temp file and rename would
        // give it a fresh modification time.
        let aged = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(paths::catalog_path(temp.path()))
            .expect("open catalog")
            .set_modified(aged)
            .expect("age the catalog");

        let entries = list(temp.path()).expect("first list");
        assert!(is_fallback(&entries[0]));
        assert_eq!(entries[0].last_opened_at, Some(77));
        assert_eq!(
            fs::metadata(paths::catalog_path(temp.path()))
                .expect("metadata")
                .modified()
                .expect("mtime"),
            aged,
            "a stable fallback row is not rewritten"
        );
        let entries = list(temp.path()).expect("second list");
        assert_eq!(entries[0].last_opened_at, Some(77));
    }

    #[test]
    fn list_rereads_a_cached_row_when_only_its_wal_changed() {
        let temp = TempRoot::new("wal-stamp");
        let id = package(&temp, "Before");
        let database = paths::database_path(temp.path(), &id);
        let conn =
            Database::connect(crate::db::sqlite_url(&database.to_string_lossy()).expect("url"))
                .expect("connect");
        crate::db::configure(&conn, &database.to_string_lossy()).expect("wal mode");
        let entries = list(temp.path()).expect("first list");
        let before = entries[0].stamp.clone().expect("stamp");

        // With the connection open, the update lives in the WAL: the database
        // file's length and modification time stay as they were.
        conn.execute_raw(Statement::from_string(
            DbBackend::Sqlite,
            "UPDATE document SET title = 'After', updated_at = 9 WHERE id = 1".to_owned(),
        ))
        .expect("rename in the wal");

        let entries = list(temp.path()).expect("second list");
        assert_eq!(entries[0].title, "After", "the WAL change is re-read");
        let after = entries[0].stamp.clone().expect("stamp");
        assert_eq!(
            after.database, before.database,
            "the database file itself did not change"
        );
        assert_ne!(after.wal, before.wal, "the WAL sidecar changed");
        drop(conn);
    }

    #[test]
    fn refresh_preserves_open_order_only_for_a_matching_identity() {
        let temp = TempRoot::new("refresh");
        let first = package(&temp, "First");
        let second = package(&temp, "Second");
        write(
            temp.path(),
            &[
                Entry {
                    path: first.clone(),
                    project_id: first.clone(),
                    title: "First".to_owned(),
                    updated_at: 1,
                    last_opened_at: Some(50),
                    fallback: false,
                    stamp: None,
                },
                Entry {
                    path: second.clone(),
                    project_id: ID_B.to_owned(),
                    title: "Second".to_owned(),
                    updated_at: 2,
                    last_opened_at: Some(60),
                    fallback: false,
                    stamp: None,
                },
            ],
        )
        .expect("write catalog");

        let entries = refresh(temp.path()).expect("refresh");
        let first_entry = entries
            .iter()
            .find(|entry| entry.path == first)
            .expect("first");
        assert_eq!(first_entry.last_opened_at, Some(50));
        let second_entry = entries
            .iter()
            .find(|entry| entry.path == second)
            .expect("second");
        assert_eq!(
            second_entry.project_id, second,
            "identity read from package"
        );
        assert_eq!(
            second_entry.last_opened_at, None,
            "a mismatched identity loses the old open time"
        );
        assert_eq!(second_entry.title, "Second");
    }

    #[test]
    fn a_corrupt_catalog_loses_open_order() {
        let temp = TempRoot::new("corrupt-order");
        let id = package(&temp, "Ordered");
        write(
            temp.path(),
            &[Entry {
                path: id.clone(),
                project_id: id.clone(),
                title: "Ordered".to_owned(),
                updated_at: 1,
                last_opened_at: Some(99),
                fallback: false,
                stamp: None,
            }],
        )
        .expect("write catalog");
        fs::write(paths::catalog_path(temp.path()), b"garbage").expect("corrupt");

        let entries = list(temp.path()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].last_opened_at, None);
        assert_eq!(entries[0].title, "Ordered");
    }

    #[test]
    fn mark_opened_updates_and_sorts_entries() {
        let temp = TempRoot::new("mark-opened");
        let first = package(&temp, "First");
        let second = package(&temp, "Second");
        list(temp.path()).expect("list");
        mark_opened(temp.path(), &first, 10).expect("mark first");
        mark_opened(temp.path(), &second, 20).expect("mark second");
        let entries = list(temp.path()).expect("list");
        assert_eq!(entries[0].path, second, "newest opened first");
        assert_eq!(entries[1].last_opened_at, Some(10));
    }

    fn cand(path: &str, title: &str) -> Entry {
        Entry {
            path: path.to_owned(),
            project_id: path.to_owned(),
            title: title.to_owned(),
            updated_at: 5,
            last_opened_at: None,
            fallback: false,
            stamp: None,
        }
    }

    #[test]
    fn sorting_is_total_and_case_insensitive() {
        // Byte order puts "Banana" first; case-insensitive order puts
        // "apple" first. Equal recency and updated time reach the title.
        let mut entries = vec![cand(ID_A, "Banana"), cand(ID_B, "apple")];
        sort_entries(&mut entries);
        assert_eq!(entries[0].title, "apple");

        // Equal title: the path is the final, deterministic tie-break.
        let mut entries = vec![cand(ID_B, "same"), cand(ID_A, "same")];
        sort_entries(&mut entries);
        assert_eq!(entries[0].path, ID_A);

        // An opened project outranks a newer unopened one.
        let mut entries = vec![cand(ID_A, "never"), cand(ID_B, "opened")];
        entries[1].last_opened_at = Some(1);
        entries[0].updated_at = 99;
        sort_entries(&mut entries);
        assert_eq!(entries[0].title, "opened");
    }

    #[test]
    fn a_failed_write_removes_the_temp_and_leaves_the_target_in_place() {
        let temp = TempRoot::new("write-failure");
        let id = package(&temp, "Stable");
        write(
            temp.path(),
            &[Entry {
                path: id.clone(),
                project_id: id.clone(),
                title: "Stable".to_owned(),
                updated_at: 1,
                last_opened_at: None,
                fallback: false,
                stamp: None,
            }],
        )
        .expect("write catalog");
        let before = fs::read(paths::catalog_path(temp.path())).expect("read before");
        // Occupy the rename target with a non-empty directory: the rename
        // must fail on every platform and the temp file must not survive.
        let target = paths::catalog_path(temp.path());
        fs::remove_file(&target).expect("remove catalog");
        fs::create_dir(&target).expect("blocking dir");
        fs::write(target.join("keep"), b"x").expect("blocking file");

        let error = write(temp.path(), &[]).expect_err("write must fail");
        assert!(error.starts_with("the project list could not be saved:"));
        assert!(target.join("keep").is_file());
        let temps: Vec<_> = fs::read_dir(temp.path())
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".catalog.json.tmp-"))
            .collect();
        assert!(temps.is_empty(), "temp catalog files must be removed");
        fs::remove_dir_all(&target).expect("cleanup target");
        fs::write(&target, before).expect("restore catalog");
    }
}
