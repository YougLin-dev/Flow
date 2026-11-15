//! Managed package operations: rename, delete, duplicate and import.
//!
//! Every operation that touches a package holds its out-of-package lock
//! first. Rename, duplicate and import verify that the document identity
//! matches the directory; delete deliberately does not, so fallback rows for
//! unreadable packages stay removable. Delete, duplicate and import commit
//! with a single directory rename after the package is durable under a temp
//! or trash name, so a crash can leave residue but never a half-written
//! visible package. The source of an import
//! is only ever read (`VACUUM INTO` is consistent and read-only with respect
//! to the source).

use std::fs;
use std::path::Path;

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ActiveValue::Unchanged, Database, DatabaseConnection,
};

use crate::clock;
use crate::db;
use crate::document;
use crate::entity::document as document_row;
use crate::fsutil;
use crate::project::commit::TempPackage;
use crate::project::lock::PackageLock;
use crate::project::paths;
use crate::project::{catalog, package};
use crate::schema::v1;

/// Mutating a package that this window has open is refused; the workspace
/// closes a project before renaming or deleting it.
pub(crate) const OPEN_HERE: &str = "the project is open in this window";

/// Renames a closed package. Only the title and `updated_at` change: the
/// revision, counts, camera and undo-independent content stay as they are,
/// and the directory never moves.
pub(crate) fn rename_project(
    root: &Path,
    active: Option<&str>,
    project_id: &str,
    title: &str,
) -> Result<catalog::Entry, String> {
    refuse_active(active, project_id)?;
    v1::validate_title(title)?;
    let (_lock, _identity) = lock_and_identity(root, project_id)?;
    let database = paths::database_path(root, project_id);
    let now = clock::now_ms();
    {
        let conn = connect(&database)?;
        db::configure(&conn, &database.to_string_lossy())?;
        document_row::ActiveModel {
            id: Unchanged(document::ROW_ID),
            title: Set(title.to_owned()),
            updated_at: Set(now),
            ..Default::default()
        }
        .update(&conn)
        .map_err(|error| error.to_string())?;
        // The title is committed. A concurrent reader can make the
        // checkpoint busy; the package is valid with unmerged WAL frames, so
        // report the rename it actually applied and let a later close (or the
        // next list) merge them.
        let _ = crate::schema::package::checkpoint_truncate(&conn);
    }
    fsutil::sync_file(&database)?;

    let last_opened_at = catalog::load_valid(root)
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry.path == project_id)
        .and_then(|entry| entry.last_opened_at);
    let entry = catalog::Entry {
        path: project_id.to_owned(),
        project_id: project_id.to_owned(),
        title: title.to_owned(),
        updated_at: now,
        last_opened_at,
    };
    let _ = catalog::upsert(root, entry.clone());
    Ok(entry)
}

/// Deletes a package directory. The rename to a trash name is the commit; the
/// trash itself is purged afterwards and swept after a day if a handle keeps
/// it alive.
///
/// Unlike rename and duplicate, delete does not read the document identity:
/// unreadable and mismatched packages are listed as fallback rows and must
/// stay removable. The directory to move is chosen by the id and locked; no
/// content is opened.
pub(crate) fn delete_project(
    root: &Path,
    active: Option<&str>,
    project_id: &str,
) -> Result<(), String> {
    refuse_active(active, project_id)?;
    paths::validate_id(project_id)?;
    let lock = PackageLock::acquire(root, project_id)?;
    let dir = paths::package_dir(root, project_id);
    let database = paths::database_path(root, project_id);
    // The same package definition the catalog scan uses: a real directory
    // with a regular database. A missing or symlinked database is refused,
    // so the checkpoint below cannot follow a link outside the package.
    if !paths::is_real_dir(&dir) || !paths::is_regular_file(&database) {
        return Err(package::missing_database(&database));
    }
    if let Ok(conn) = connect(&database)
        && db::configure(&conn, &database.to_string_lossy()).is_ok()
    {
        let _ = crate::schema::package::checkpoint_truncate(&conn);
    }
    let trash = paths::trash_dir(root, project_id);
    fsutil::rename(&paths::package_dir(root, project_id), &trash)
        .map_err(|error| format!("the project package could not be deleted: {error}"))?;
    let _ = catalog::remove(root, project_id);
    drop(lock);
    let _ = fsutil::remove_dir_all(&trash);
    fsutil::sync_dir_best_effort(root);
    Ok(())
}

/// Copies a closed package under a new identity. `VACUUM INTO` snapshots the
/// database consistently (committed WAL frames included); assets are copied
/// by content hash and verified before the package is renamed into place.
pub(crate) fn duplicate_project(
    root: &Path,
    active: Option<&str>,
    project_id: &str,
    title: &str,
) -> Result<catalog::Entry, String> {
    refuse_active(active, project_id)?;
    v1::validate_title(title)?;
    let (_lock, _identity) = lock_and_identity(root, project_id)?;

    let temp = TempPackage::create(root, "copy")?;
    let source_database = paths::database_path(root, project_id);
    {
        let source = connect(&source_database)?;
        crate::schema::package::export_snapshot(&source, &temp.path().join(paths::DATABASE_FILE))?;
    }
    copy_assets(
        &paths::assets_dir(root, project_id),
        &temp.path().join(paths::ASSETS_DIR),
    )?;

    let database = temp.path().join(paths::DATABASE_FILE);
    let now = clock::now_ms();
    let entry = {
        let conn = connect(&database)?;
        db::configure(&conn, &database.to_string_lossy())?;
        let new_id = v1::mint_project_id(&conn)?;
        crate::schema::package::remint_project_id(&conn, &new_id, title, now, now)?;
        package::verify_assets(&conn, temp.path())?;
        let row = document::current(&conn).map_err(|error| error.to_string())?;
        crate::schema::package::checkpoint_truncate(&conn)?;
        catalog::Entry {
            path: new_id.clone(),
            project_id: new_id,
            title: title.to_owned(),
            updated_at: row.updated_at,
            last_opened_at: None,
        }
    };
    temp.commit(root, &entry)?;
    Ok(entry)
}

/// Imports an unpacked package directory from outside the managed root.
/// The source is never locked or written: it may be a backup or another
/// application's copy. The identity is kept when its directory is free,
/// otherwise the copy is rekeyed; either way the first managed open verifies
/// the imported package.
pub(crate) fn import_project(root: &Path, source: &str) -> Result<catalog::Entry, String> {
    let source_dir =
        fs::canonicalize(source).map_err(|_| package::missing_database(Path::new(source)))?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if source_dir == canonical_root || source_dir.starts_with(&canonical_root) {
        return Err("the project is already managed; duplicate it instead".to_owned());
    }
    let source_database = source_dir.join(paths::DATABASE_FILE);
    if !paths::is_real_dir(&source_dir) || !paths::is_regular_file(&source_database) {
        return Err(package::missing_database(&source_database));
    }
    // Fail a foreign source before building anything. The snapshot below is
    // re-read for the decisions, because the source is not locked and may
    // change between these two reads.
    package::read_identity(&source_database)?;

    let temp = TempPackage::create(root, "import")?;
    {
        let source_conn = connect_read_only(&source_database)?;
        crate::schema::package::export_snapshot(
            &source_conn,
            &temp.path().join(paths::DATABASE_FILE),
        )?;
    }
    copy_assets(
        &source_dir.join(paths::ASSETS_DIR),
        &temp.path().join(paths::ASSETS_DIR),
    )?;

    let database = temp.path().join(paths::DATABASE_FILE);
    let conn = connect(&database)?;
    db::configure(&conn, &database.to_string_lossy())?;
    let snapshot_id =
        match v1::inspect(&conn).map_err(|error| package::not_a_package(&database, &error))? {
            v1::FileState::Current(info) => info.project_id,
            v1::FileState::New => return Err(package::missing_database(&database)),
        };
    let recorded = catalog::load_valid(root)
        .unwrap_or_default()
        .into_iter()
        .any(|entry| entry.path == snapshot_id || entry.project_id == snapshot_id);
    let keep_id = !recorded && !paths::package_dir(root, &snapshot_id).exists();
    let final_id = if keep_id {
        snapshot_id
    } else {
        let copy_title = document::current(&conn)
            .map_err(|error| error.to_string())?
            .title;
        let now = clock::now_ms();
        let new_id = v1::mint_project_id(&conn)?;
        crate::schema::package::remint_project_id(&conn, &new_id, &copy_title, now, now)?;
        new_id
    };
    crate::schema::package::mark_dirty(&conn)?;
    package::verify_assets(&conn, temp.path())?;
    let row = document::current(&conn).map_err(|error| error.to_string())?;
    crate::schema::package::checkpoint_truncate(&conn)?;
    drop(conn);
    let entry = catalog::Entry {
        path: final_id.clone(),
        project_id: final_id,
        title: row.title,
        updated_at: row.updated_at,
        last_opened_at: None,
    };
    temp.commit(root, &entry)?;
    Ok(entry)
}

fn refuse_active(active: Option<&str>, project_id: &str) -> Result<(), String> {
    if active == Some(project_id) {
        Err(OPEN_HERE.to_owned())
    } else {
        Ok(())
    }
}

/// Takes the package lock and verifies the document identity matches the
/// directory. Every managed mutation starts here.
fn lock_and_identity(
    root: &Path,
    project_id: &str,
) -> Result<(PackageLock, package::Identity), String> {
    paths::validate_id(project_id)?;
    let lock = PackageLock::acquire(root, project_id)?;
    let database = paths::database_path(root, project_id);
    let identity = package::read_identity(&database)?;
    if identity.project_id != project_id {
        return Err(package::identity_mismatch(root, project_id));
    }
    Ok((lock, identity))
}

fn connect(database: &Path) -> Result<DatabaseConnection, String> {
    let url = db::sqlite_url(&database.to_string_lossy())?;
    Database::connect(url).map_err(|error| error.to_string())
}

fn connect_read_only(database: &Path) -> Result<DatabaseConnection, String> {
    let url = db::sqlite_url_ro(&database.to_string_lossy())?;
    Database::connect(url).map_err(|error| error.to_string())
}

fn copy_assets(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(copy_error)?;
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(copy_error(error)),
    };
    for entry in entries {
        let entry = entry.map_err(copy_error)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !crate::asset::is_sha256_hex(name) {
            continue;
        }
        let path = entry.path();
        if !paths::is_regular_file(&path) {
            continue;
        }
        let destination = to.join(name);
        fs::copy(&path, &destination).map_err(copy_error)?;
        // The copied package must be durable before its commit rename.
        crate::fsutil::sync_file(&destination)
            .map_err(|error| format!("the project package could not be copied: {error}"))?;
    }
    Ok(())
}

fn copy_error(error: std::io::Error) -> String {
    format!("the project package could not be copied: {error}")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sea_orm::{ConnectionTrait, DbBackend, Statement};

    use super::*;
    use crate::entity::assets;
    use crate::project::create::create_project;
    use crate::project::lock;
    use crate::project::test_support::TempRoot;

    fn create(temp: &TempRoot, title: &str) -> catalog::Entry {
        create_project(temp.path(), title, None).expect("create")
    }

    fn entries(temp: &TempRoot) -> Vec<catalog::Entry> {
        catalog::load_valid(temp.path()).unwrap_or_default()
    }

    fn open(root: &Path, id: &str) -> DatabaseConnection {
        connect(&paths::database_path(root, id)).expect("open package")
    }

    fn insert_node(conn: &DatabaseConnection, id: &str) {
        conn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO nodes (id, kind, title, x, y, width, height, z, created_at, updated_at) \
             VALUES (?1, 'note', ?2, 0.0, 0.0, 100.0, 50.0, 0.0, 1, 1)",
            vec![id.to_owned().into(), format!("Node {id}").into()],
        ))
        .expect("insert node");
    }

    fn insert_asset(conn: &DatabaseConnection, hash: &str, size: i64) {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set};
        assets::ActiveModel {
            id: sea_orm::ActiveValue::Set(format!("asset-{hash}")),
            hash: Set(hash.to_owned()),
            kind: Set("image".to_owned()),
            name: Set("image.png".to_owned()),
            mime: Set("image/png".to_owned()),
            size: Set(size),
            meta_json: Set("{}".to_owned()),
            created_at: Set(1),
        }
        .insert(conn)
        .expect("insert asset");
    }

    fn write_asset(root: &Path, id: &str, hash: &str, bytes: &[u8]) {
        let dir = paths::assets_dir(root, id);
        fs::create_dir_all(&dir).expect("assets dir");
        fs::write(dir.join(hash), bytes).expect("asset file");
    }

    fn id_update_aborts(conn: &DatabaseConnection) -> bool {
        conn.execute_raw(Statement::from_string(
            DbBackend::Sqlite,
            "UPDATE document SET project_id = 'ffffffffffffffffffffffffffffffff' WHERE id = 1"
                .to_owned(),
        ))
        .err()
        .map(|error| error.to_string().contains("project_id is immutable"))
        .unwrap_or(false)
    }

    fn node_count(conn: &DatabaseConnection) -> i64 {
        conn.query_one_raw(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT node_count FROM document WHERE id = 1".to_owned(),
        ))
        .expect("query")
        .expect("row")
        .try_get_by_index::<i64>(0)
        .expect("count")
    }

    #[test]
    fn rename_changes_title_and_timestamp_only() {
        let temp = TempRoot::new("rename");
        let created = create(&temp, "Before");
        {
            let conn = open(temp.path(), &created.path);
            insert_node(&conn, "n1");
        }
        catalog::mark_opened(temp.path(), &created.path, 77).expect("mark opened");
        let rev_before = {
            let conn = open(temp.path(), &created.path);
            document::current(&conn).expect("document").rev
        };

        let renamed = rename_project(temp.path(), None, &created.path, "After").expect("rename");
        assert_eq!(renamed.title, "After");
        assert_eq!(renamed.path, created.path);
        assert_eq!(renamed.last_opened_at, Some(77));
        assert!(renamed.updated_at >= created.updated_at);

        let conn = open(temp.path(), &created.path);
        let row = document::current(&conn).expect("document");
        assert_eq!(row.title, "After");
        assert_eq!(row.rev, rev_before, "rename does not bump the revision");
        assert_eq!(row.node_count, 1);
        assert_eq!(
            catalog::load_valid(temp.path()).expect("catalog")[0].title,
            "After"
        );
        assert!(paths::package_dir(temp.path(), &created.path).is_dir());
    }

    #[test]
    fn rename_applies_even_when_a_reader_keeps_the_checkpoint_busy() {
        let temp = TempRoot::new("rename-busy");
        let created = create(&temp, "Before");
        let database = paths::database_path(temp.path(), &created.path);
        let reader = rusqlite::Connection::open(&database).expect("reader");
        reader
            .execute_batch("BEGIN; SELECT COUNT(*) FROM document;")
            .expect("pin a read snapshot before the rename");

        let renamed = rename_project(temp.path(), None, &created.path, "After").expect("rename");
        assert_eq!(renamed.title, "After");
        let wal = database.with_file_name(format!("{}-wal", paths::DATABASE_FILE));
        assert!(
            fs::metadata(&wal).expect("wal").len() > 0,
            "the reader kept the checkpoint busy and the rename still succeeded"
        );
        assert_eq!(
            catalog::load_valid(temp.path()).expect("catalog")[0].title,
            "After",
            "the derived catalog follows the committed title"
        );
        let conn = open(temp.path(), &created.path);
        assert_eq!(document::current(&conn).expect("document").title, "After");
        drop(conn);
        drop(reader);
    }

    #[test]
    fn rename_refuses_blank_titles_active_projects_and_locked_packages() {
        let temp = TempRoot::new("rename-refuse");
        let created = create(&temp, "Keep");
        assert_eq!(
            rename_project(temp.path(), None, &created.path, " "),
            Err("the project title is empty".to_owned())
        );
        assert_eq!(
            rename_project(temp.path(), None, &created.path, "a\0b"),
            Err("the project title is invalid".to_owned())
        );
        assert_eq!(
            rename_project(temp.path(), Some(&created.path), &created.path, "Nope"),
            Err(OPEN_HERE.to_owned())
        );
        let held = lock::PackageLock::acquire(temp.path(), &created.path).expect("lock");
        assert_eq!(
            rename_project(temp.path(), None, &created.path, "Nope"),
            Err(lock::OPEN_ELSEWHERE.to_owned())
        );
        drop(held);
        rename_project(temp.path(), None, &created.path, "Yes").expect("after release");
    }

    #[test]
    fn delete_removes_the_package_catalog_entry_and_refuses_locked() {
        let temp = TempRoot::new("delete");
        let first = create(&temp, "First");
        let held = lock::PackageLock::acquire(temp.path(), &first.path).expect("lock");
        assert_eq!(
            delete_project(temp.path(), None, &first.path),
            Err(lock::OPEN_ELSEWHERE.to_owned())
        );
        drop(held);
        assert!(paths::package_dir(temp.path(), &first.path).is_dir());
        assert_eq!(
            delete_project(temp.path(), Some(&first.path), &first.path),
            Err(OPEN_HERE.to_owned())
        );

        delete_project(temp.path(), None, &first.path).expect("delete");
        assert!(!paths::package_dir(temp.path(), &first.path).exists());
        assert!(entries(&temp).is_empty());
        assert!(
            paths::lock_path(temp.path(), &first.path).exists(),
            "lock files are never unlinked"
        );
        let trash: Vec<_> = fs::read_dir(temp.path())
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".trash-"))
            .collect();
        assert!(trash.is_empty(), "trash purge: {trash:?}");
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn delete_removes_unreadable_and_mismatched_packages() {
        let temp = TempRoot::new("delete-fallback");
        let empty = "dddddddddddddddddddddddddddddddd";
        fs::create_dir_all(paths::package_dir(temp.path(), empty)).expect("empty dir");
        let error = delete_project(temp.path(), None, empty).expect_err("not a package");
        assert!(error.starts_with("the project package has no Flow database:"));

        let junk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let junk_dir = paths::package_dir(temp.path(), junk);
        fs::create_dir_all(&junk_dir).expect("junk dir");
        fs::write(junk_dir.join(paths::DATABASE_FILE), b"junk").expect("junk database");
        delete_project(temp.path(), None, junk).expect("delete an unreadable package");
        assert!(!junk_dir.exists());

        let created = create(&temp, "Mismatch");
        let fake = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        fs::rename(
            paths::package_dir(temp.path(), &created.path),
            paths::package_dir(temp.path(), fake),
        )
        .expect("forge directory");
        delete_project(temp.path(), None, fake).expect("delete a mismatched package");
        assert!(!paths::package_dir(temp.path(), fake).exists());
    }

    #[test]
    fn duplicate_copies_content_assets_and_mints_a_new_identity() {
        let temp = TempRoot::new("duplicate");
        let source = create(&temp, "Source");
        let bytes = b"0123456789";
        let hash = sha256_hex(bytes);
        {
            let conn = open(temp.path(), &source.path);
            insert_node(&conn, "n1");
            insert_asset(&conn, &hash, bytes.len() as i64);
            write_asset(temp.path(), &source.path, &hash, bytes);
        }

        let copy = duplicate_project(temp.path(), None, &source.path, "Copy").expect("duplicate");
        assert_ne!(copy.path, source.path);
        assert_eq!(copy.title, "Copy");
        assert!(
            paths::assets_dir(temp.path(), &copy.path)
                .join(&hash)
                .is_file()
        );

        let conn = open(temp.path(), &copy.path);
        let row = document::current(&conn).expect("document");
        assert_eq!(row.project_id, copy.path);
        assert_eq!(row.title, "Copy");
        assert_eq!(row.node_count, 1);
        assert!(id_update_aborts(&conn), "trigger must be restored");
        assert_eq!(row.clean_shutdown, 1, "a closed source stays clean");

        let source_conn = open(temp.path(), &source.path);
        assert_eq!(
            document::current(&source_conn).expect("source").title,
            "Source"
        );
        assert_eq!(node_count(&source_conn), 1);
    }

    #[test]
    fn duplicate_refuses_a_mismatched_identity_and_a_missing_asset() {
        let temp = TempRoot::new("duplicate-refuse");
        let source = create(&temp, "Source");
        let fake = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        fs::rename(
            paths::package_dir(temp.path(), &source.path),
            paths::package_dir(temp.path(), fake),
        )
        .expect("forge directory");
        assert_eq!(
            duplicate_project(temp.path(), None, fake, "Copy"),
            Err(format!(
                "the package identity does not match its directory: {}",
                paths::package_dir(temp.path(), fake).display()
            ))
        );
        fs::rename(
            paths::package_dir(temp.path(), fake),
            paths::package_dir(temp.path(), &source.path),
        )
        .expect("restore directory");

        let hash = "b".repeat(64);
        {
            let conn = open(temp.path(), &source.path);
            insert_asset(&conn, &hash, 4);
        }
        let before: Vec<_> = fs::read_dir(temp.path())
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        assert_eq!(
            duplicate_project(temp.path(), None, &source.path, "Copy").err(),
            Some(format!("the package is missing asset {hash}"))
        );
        let after: Vec<_> = fs::read_dir(temp.path())
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        assert_eq!(before, after, "a failed duplicate leaves no residue");
    }

    #[test]
    fn import_keeps_a_free_identity_and_mints_on_collision() {
        let source_root = TempRoot::new("import-source");
        let target = TempRoot::new("import-target");
        let source = create(&source_root, "Imported");
        let source_db = paths::database_path(source_root.path(), &source.path);
        let bytes_before = fs::read(&source_db).expect("source bytes");

        let imported = import_project(
            target.path(),
            &source_root.path().join(&source.path).to_string_lossy(),
        )
        .expect("import");
        assert_eq!(imported.project_id, source.path, "a free identity is kept");
        assert_eq!(imported.title, "Imported");
        let conn = open(target.path(), &imported.path);
        assert_eq!(
            document::current(&conn).expect("document").clean_shutdown,
            0,
            "the first managed open must verify"
        );
        assert_eq!(
            fs::read(&source_db).expect("source bytes after"),
            bytes_before,
            "the source is untouched"
        );

        let again = import_project(
            target.path(),
            &source_root.path().join(&source.path).to_string_lossy(),
        )
        .expect("second import");
        assert_ne!(again.project_id, source.path, "collision mints a new id");
        assert_eq!(again.title, "Imported");
    }

    #[test]
    fn import_refuses_managed_foreign_and_incomplete_sources() {
        let temp = TempRoot::new("import-refuse");
        let managed = create(&temp, "Managed");
        let managed_path = paths::package_dir(temp.path(), &managed.path);
        assert_eq!(
            import_project(temp.path(), &managed_path.to_string_lossy()),
            Err("the project is already managed; duplicate it instead".to_owned())
        );
        assert_eq!(
            import_project(temp.path(), &temp.path().to_string_lossy()),
            Err("the project is already managed; duplicate it instead".to_owned())
        );

        let missing = temp
            .path()
            .parent()
            .expect("parent")
            .join(format!("flow-import-missing-{}", paths::unique_suffix()));
        let error = import_project(temp.path(), &missing.to_string_lossy()).expect_err("missing");
        assert!(error.starts_with("the project package has no Flow database:"));

        let foreign = temp
            .path()
            .parent()
            .expect("parent")
            .join(format!("flow-import-foreign-{}", paths::unique_suffix()));
        fs::create_dir_all(&foreign).expect("foreign dir");
        fs::write(foreign.join(paths::DATABASE_FILE), b"junk").expect("foreign db");
        let error = import_project(temp.path(), &foreign.to_string_lossy()).expect_err("foreign");
        assert!(error.starts_with("the project package is not a Flow project package:"));
        let _ = fs::remove_dir_all(&foreign);

        let empty = temp
            .path()
            .parent()
            .expect("parent")
            .join(format!("flow-import-empty-{}", paths::unique_suffix()));
        fs::create_dir_all(&empty).expect("empty source");
        fs::write(empty.join(paths::DATABASE_FILE), b"").expect("empty database");
        let error = import_project(temp.path(), &empty.to_string_lossy()).expect_err("empty");
        assert!(error.starts_with("the project package has no Flow database:"));
        let _ = fs::remove_dir_all(&empty);

        let newer_root = TempRoot::new("import-newer");
        let newer = create(&newer_root, "Newer");
        {
            let conn = connect(&paths::database_path(newer_root.path(), &newer.path))
                .expect("newer connection");
            conn.execute_unprepared("PRAGMA user_version = 2")
                .expect("newer schema");
        }
        let error = import_project(
            temp.path(),
            &newer_root.path().join(&newer.path).to_string_lossy(),
        )
        .expect_err("newer source");
        assert!(error.starts_with("the project package is not a Flow project package:"));
        assert!(error.contains("newer"), "{error}");
        assert_eq!(entries(&temp).len(), 1, "a refused import adds nothing");
    }

    #[test]
    fn import_includes_committed_wal_rows_and_refuses_missing_assets() {
        let source_root = TempRoot::new("import-wal-source");
        let target = TempRoot::new("import-wal-target");
        let source = create(&source_root, "Wal");
        let source_db = paths::database_path(source_root.path(), &source.path);
        let writer = connect(&source_db).expect("writer");
        writer
            .execute_unprepared("PRAGMA journal_mode = WAL")
            .expect("wal");
        insert_node(&writer, "wal-node");
        assert!(
            fs::metadata({
                let mut path = source_db.clone().into_os_string();
                path.push("-wal");
                PathBuf::from(path)
            })
            .expect("wal file")
            .len()
                > 0
        );
        let imported = import_project(
            target.path(),
            &source_root.path().join(&source.path).to_string_lossy(),
        )
        .expect("import with open WAL writer");
        drop(writer);
        let conn = open(target.path(), &imported.path);
        assert_eq!(node_count(&conn), 1, "committed WAL frames are included");

        let hash = "c".repeat(64);
        insert_asset(&writer_or_new(source_root.path(), &source.path), &hash, 3);
        let error = import_project(
            target.path(),
            &source_root.path().join(&source.path).to_string_lossy(),
        )
        .expect_err("missing asset");
        assert_eq!(error, format!("the package is missing asset {hash}"));
    }

    fn writer_or_new(root: &Path, id: &str) -> DatabaseConnection {
        connect(&paths::database_path(root, id)).expect("source connection")
    }
}
