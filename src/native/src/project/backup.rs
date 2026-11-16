//! Backing up and restoring a closed project package.
//!
//! A backup is a complete package folder: a consistent `project.db` (a
//! `VACUUM INTO` snapshot includes committed WAL frames) and the `assets/`
//! bytes, verified as the same project and with SQLite's quick check. A
//! restore builds a new package in a temp directory, verifies it, then swaps
//! the closed package's directory with it. The old directory is parked under
//! a recoverable name until the swap succeeds, and the store recovers a crash
//! between the two renames on its next open.

use std::fs;
use std::path::{Path, PathBuf};

use sea_orm::{DatabaseConnection, EntityTrait};

use crate::db;
use crate::document;
use crate::fsutil;
use crate::schema;

use super::catalog;
use super::commit::TempPackage;
use super::lock::PackageLock;
use super::ops::{self, PreparedImport};
use super::package;
use super::paths;
use super::stamp;

/// The copy of the package being built before it becomes a backup folder.
/// Dropped on failure; `keep` disarms it after the final rename.
struct Staging {
    path: PathBuf,
    armed: bool,
}

impl Staging {
    fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if self.armed {
            let _ = fsutil::remove_dir_all(&self.path);
        }
    }
}

/// Copies a closed project package to a new folder outside the managed root.
/// The package lock is held for the whole copy, so no window can open it
/// while the snapshot is taken.
pub(crate) fn backup_project(
    root: &Path,
    active: Option<&str>,
    project_id: &str,
    destination: &str,
) -> Result<(), String> {
    paths::validate_id(project_id)?;
    ops::refuse_active(active, project_id)?;
    let (parent, destination) = backup_destination(root, destination)?;
    let source = paths::package_dir(root, project_id);
    let database = source.join(paths::DATABASE_FILE);

    let _lock = PackageLock::acquire(root, project_id)?;
    let identity = package::verify_identity(&database)?;
    if identity.project_id != project_id {
        return Err(package::identity_mismatch(root, project_id));
    }

    let staging = staging(&parent)?;
    {
        let source_conn = ops::connect_read_only(&database)?;
        schema::package::export_snapshot(&source_conn, &staging.path.join(paths::DATABASE_FILE))?;
    }
    ops::copy_assets(
        &source.join(paths::ASSETS_DIR),
        &staging.path.join(paths::ASSETS_DIR),
    )?;
    finish_package(&staging.path, project_id, false)?;
    sync_package(&staging.path)?;
    fsutil::rename(&staging.path, &destination)
        .map_err(|error| format!("the backup could not be moved into place: {error}"))?;
    staging.keep();
    fsutil::sync_dir_best_effort(&parent);
    Ok(())
}

/// The result of building a restored package: complete and verified, waiting
/// for the catalog-lock commit that swaps it into place.
#[derive(Debug)]
pub(crate) struct PendingRestore {
    temp: TempPackage,
    project_id: String,
    title: String,
    updated_at: i64,
    stamp: Option<stamp::PackageStamp>,
}

/// Builds and verifies the replacement package from a folder or a prepared
/// archive. Runs outside the catalog lock; the target is not touched.
pub(crate) fn prepare_restore(
    root: &Path,
    project_id: &str,
    prepared: PreparedImport,
) -> Result<PendingRestore, String> {
    paths::validate_id(project_id)?;
    // Keep the user's path for errors: the extraction directory and the temp
    // package are both gone by the time the dialog shows a message.
    let source_label = match &prepared {
        PreparedImport::Directory(path) => path.clone(),
        PreparedImport::Archive { source, .. } => source.clone(),
    };
    let label = source_label.display().to_string();
    let raw_source = match &prepared {
        PreparedImport::Directory(path) => path.clone(),
        PreparedImport::Archive { extracted, .. } => extracted.path().to_owned(),
    };
    // The canonicalize failure is mapped too: for an archive, raw_source is
    // the extraction directory, which must not reach the dialog.
    let source = fs::canonicalize(&raw_source).map_err(|_| {
        package::missing_database(&raw_source.join(paths::DATABASE_FILE))
            .replace(&raw_source.display().to_string(), &label)
    })?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if source == canonical_root || source.starts_with(&canonical_root) {
        return Err("the backup must be outside the projects folder".to_owned());
    }

    let temp = TempPackage::create(root, "restore-new")?;
    let temp_path = temp.path().to_owned();
    let built = (|| {
        verify_source(&source, project_id)?;
        let (title, updated_at) = build_restore(&source, project_id, &temp_path)?;
        sync_package(&temp_path)?;
        Ok((title, updated_at, stamp::package_stamp(&temp_path)))
    })();
    // Most specific first: the temp package sits below the root, so a source
    // folder that is an ancestor of the root can otherwise rewrite the temp
    // path before its own replacement runs. The canonical source carries a
    // `\\?\` prefix on Windows, so it is replaced before its raw substring.
    let (title, updated_at, stamp) = built.map_err(|error: String| {
        error
            .replace(&temp_path.display().to_string(), &label)
            .replace(&source.display().to_string(), &label)
            .replace(&raw_source.display().to_string(), &label)
    })?;
    Ok(PendingRestore {
        temp,
        project_id: project_id.to_owned(),
        title,
        updated_at,
        stamp,
    })
}

/// Copies and verifies the replacement package into `temp`.
fn build_restore(source: &Path, project_id: &str, temp: &Path) -> Result<(String, i64), String> {
    let database = temp.join(paths::DATABASE_FILE);
    {
        let source_conn = ops::connect_read_only(&source.join(paths::DATABASE_FILE))?;
        schema::package::export_snapshot(&source_conn, &database)?;
    }
    ops::copy_assets(
        &source.join(paths::ASSETS_DIR),
        &temp.join(paths::ASSETS_DIR),
    )?;
    // The restored package must be verified on its first managed open: the
    // backup may predate the current binary or a repair.
    finish_package(temp, project_id, true)
}

/// Replaces the closed package with the prepared one. The previous directory
/// is parked under a recoverable name; a crash between the two renames leaves
/// it for [`super::paths::recover_restores`], and a failed second rename
/// rolls it back immediately.
pub(crate) fn commit_restore(
    root: &Path,
    active: Option<&str>,
    pending: PendingRestore,
) -> Result<catalog::Entry, String> {
    let project_id = pending.project_id.as_str();
    ops::refuse_active(active, project_id)?;
    let target = paths::package_dir(root, project_id);
    let _lock = PackageLock::acquire(root, project_id)?;
    if !paths::is_real_dir(&target) {
        return Err(package::missing_database(
            &target.join(paths::DATABASE_FILE),
        ));
    }
    let last_opened_at = catalog::load_valid(root)
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry.path == project_id)
        .and_then(|entry| entry.last_opened_at);

    let parked = paths::restore_parked_dir(root, project_id);
    fsutil::rename(&target, &parked)
        .map_err(|error| format!("the project package could not be replaced: {error}"))?;
    if let Err(error) = fsutil::rename(pending.temp.path(), &target) {
        let rollback = fsutil::rename(&parked, &target);
        return Err(match rollback {
            Ok(()) => format!("the project could not be restored: {error}"),
            Err(rollback) => format!(
                "the project could not be restored ({error}); its previous files are at {} and could not be moved back ({rollback})",
                parked.display()
            ),
        });
    }
    // Make the new package durable before retiring the only rollback copy,
    // then move the parked directory out of the recoverable namespace. A
    // failure here leaves ordinary residue the store's next delete retires.
    fsutil::sync_dir_best_effort(root);
    let _ = paths::retire_restores(root, project_id);
    fsutil::sync_dir_best_effort(root);

    let entry = catalog::Entry {
        path: project_id.to_owned(),
        project_id: project_id.to_owned(),
        title: pending.title,
        updated_at: pending.updated_at,
        last_opened_at,
        fallback: false,
        stamp: pending.stamp,
    };
    // The catalog is derived; the next list re-reads the package by stamp if
    // this best-effort write fails.
    let _ = catalog::upsert(root, entry.clone());
    Ok(entry)
}

/// Validates the backup folder and checks every asset before the copy.
fn verify_source(directory: &Path, project_id: &str) -> Result<(), String> {
    let database = directory.join(paths::DATABASE_FILE);
    let identity = package::verify_identity(&database)?;
    if identity.project_id != project_id {
        return Err(foreign_backup());
    }
    let conn = ops::connect_read_only(&database)?;
    package::verify_assets(&conn, directory)?;
    Ok(())
}

/// Verifies the built package and removes its WAL. `mark_dirty` makes the
/// next managed open run the recovery check and bounds compaction.
fn finish_package(
    directory: &Path,
    project_id: &str,
    mark_dirty: bool,
) -> Result<(String, i64), String> {
    let database = directory.join(paths::DATABASE_FILE);
    let identity = package::verify_identity(&database)?;
    if identity.project_id != project_id {
        return Err(foreign_backup());
    }
    let conn = ops::connect(&database)?;
    db::configure(&conn, &database.to_string_lossy())?;
    package::verify_assets(&conn, directory)?;
    remove_unreferenced_assets(&conn, directory)?;
    if mark_dirty {
        schema::package::mark_dirty(&conn)?;
    }
    let row = document::current(&conn).map_err(|error| error.to_string())?;
    schema::package::checkpoint_truncate(&conn)?;
    Ok((row.title, row.updated_at))
}

/// Drops hash-named files the snapshot does not reference. `copy_assets`
/// takes every content-addressed name from an untrusted folder, so this keeps
/// the restored package's invariant that an asset file is referenced and
/// verified rather than merely named like one.
fn remove_unreferenced_assets(conn: &DatabaseConnection, directory: &Path) -> Result<(), String> {
    use std::collections::HashSet;

    let rows = crate::entity::assets::Entity::find()
        .all(conn)
        .map_err(|error| error.to_string())?;
    let referenced: HashSet<String> = rows.into_iter().map(|row| row.hash).collect();
    let assets = directory.join(paths::ASSETS_DIR);
    // `build_restore` and the backup staging always create this directory; a
    // listing failure means the package cannot be verified as clean.
    let entries = fs::read_dir(&assets)
        .map_err(|error| format!("the package assets could not be read: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("the package assets could not be read: {error}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !crate::asset::is_sha256_hex(name) || referenced.contains(name) {
            continue;
        }
        let path = entry.path();
        if paths::is_regular_file(&path) {
            fs::remove_file(&path).map_err(|error| {
                format!("the package asset {name} could not be removed: {error}")
            })?;
        }
    }
    Ok(())
}

fn foreign_backup() -> String {
    "the backup belongs to another project; import it instead".to_owned()
}

fn sync_package(directory: &Path) -> Result<(), String> {
    fsutil::sync_file(&directory.join(paths::DATABASE_FILE))?;
    fsutil::sync_dir_best_effort(&directory.join(paths::ASSETS_DIR));
    fsutil::sync_dir_best_effort(directory);
    Ok(())
}

/// The destination folder and its canonical parent. The folder must not
/// exist yet, and it must be outside the managed root so its contents cannot
/// be mistaken for a project package.
fn backup_destination(root: &Path, raw: &str) -> Result<(PathBuf, PathBuf), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("the backup destination is empty".to_owned());
    }
    let requested = Path::new(raw);
    if fs::symlink_metadata(requested).is_ok() {
        return Err("the backup destination already exists".to_owned());
    }
    let Some(file_name) = requested.file_name() else {
        return Err("the backup destination has no folder name".to_owned());
    };
    let parent = requested
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|_| format!("the backup folder does not exist: {}", parent.display()))?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if parent == canonical_root || parent.starts_with(&canonical_root) {
        return Err("choose a backup folder outside the projects folder".to_owned());
    }
    Ok((parent.clone(), parent.join(file_name)))
}

fn staging(parent: &Path) -> Result<Staging, String> {
    let path = parent.join(format!(".flow-backup-{}", paths::unique_suffix()));
    fs::create_dir(&path)
        .map_err(|error| format!("the backup folder could not be created: {error}"))?;
    Ok(Staging { path, armed: true })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use sea_orm::DatabaseConnection;

    use super::*;
    use crate::entity::assets;
    use crate::project::create::create_project;
    use crate::project::test_support::TempRoot;

    fn create_with_asset(root: &Path, title: &str) -> (String, String) {
        use sha2::{Digest, Sha256};

        let created = create_project(root, title, None).expect("create project");
        let hash = format!("{:x}", Sha256::digest(b"png"));
        let database = paths::database_path(root, &created.path);
        let conn = ops::connect(&database).expect("open database");
        db::configure(&conn, &database.to_string_lossy()).expect("configure");
        insert_asset(&conn, &hash, 3);
        write_asset(root, &created.path, &hash, b"png");
        crate::schema::package::checkpoint_truncate(&conn).expect("checkpoint");
        (created.project_id, hash)
    }

    fn insert_asset(conn: &DatabaseConnection, hash: &str, size: i64) {
        use sea_orm::{ActiveModelTrait, ActiveValue::Set};

        assets::ActiveModel {
            id: Set(format!("asset-{hash}")),
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
        let directory = paths::assets_dir(root, id);
        fs::create_dir_all(&directory).expect("assets dir");
        fs::write(directory.join(hash), bytes).expect("asset file");
    }

    fn backup_to(source: &Path, project_id: &str, destination_parent: &Path) -> PathBuf {
        let destination = destination_parent.join("Saved backup");
        backup_project(source, None, project_id, &destination.to_string_lossy())
            .expect("back up the project");
        destination
    }

    #[test]
    fn backup_copies_the_database_and_assets_and_verifies_identity() {
        let source = TempRoot::new("backup-source");
        let destination_root = TempRoot::new("backup-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Saved");
        let backup = backup_to(source.path(), &project_id, destination_root.path());

        assert!(backup.join(paths::DATABASE_FILE).is_file());
        assert!(backup.join(paths::ASSETS_DIR).join(&hash).is_file());
        let identity =
            package::read_identity(&backup.join(paths::DATABASE_FILE)).expect("backup identity");
        assert_eq!(identity.project_id, project_id);
        assert_eq!(identity.title, "Saved");
        assert!(identity.clean_shutdown, "the backup keeps the closed state");
        assert!(
            paths::database_path(source.path(), &project_id).is_file(),
            "the source stays in place"
        );
    }

    #[test]
    fn backup_refuses_an_existing_or_managed_destination() {
        let source = TempRoot::new("backup-refuse");
        let (project_id, _) = create_with_asset(source.path(), "Saved");
        let existing = source.path().join("existing");
        fs::create_dir(&existing).expect("existing folder");
        assert_eq!(
            backup_project(
                source.path(),
                None,
                &project_id,
                &existing.to_string_lossy()
            )
            .err(),
            Some("the backup destination already exists".to_owned())
        );

        let inside = source.path().join("inside");
        assert_eq!(
            backup_project(source.path(), None, &project_id, &inside.to_string_lossy()).err(),
            Some("choose a backup folder outside the projects folder".to_owned())
        );
    }

    #[test]
    fn backup_refuses_the_open_project() {
        let source = TempRoot::new("backup-open");
        let destination_root = TempRoot::new("backup-open-destination");
        let (project_id, _) = create_with_asset(source.path(), "Saved");
        let destination = destination_root.path().join("backup");
        assert_eq!(
            backup_project(
                source.path(),
                Some(&project_id),
                &project_id,
                &destination.to_string_lossy()
            )
            .err(),
            Some(ops::OPEN_HERE.to_owned())
        );
    }

    #[test]
    fn restore_replaces_the_package_and_keeps_the_identity() {
        let source = TempRoot::new("restore-source");
        let destination_root = TempRoot::new("restore-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Before");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        let live_asset = paths::assets_dir(source.path(), &project_id).join(&hash);
        fs::remove_file(&live_asset).expect("damage the live package");
        let after = crate::project::ops::rename_project(source.path(), None, &project_id, "After")
            .expect("rename");
        assert_eq!(after.title, "After");
        crate::project::catalog::mark_opened(source.path(), &project_id, 123).expect("mark opened");

        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare the backup");
        let pending =
            prepare_restore(source.path(), &project_id, prepared).expect("build the restore");
        let entry = commit_restore(source.path(), None, pending).expect("commit the restore");

        assert_eq!(entry.project_id, project_id);
        assert_eq!(entry.title, "Before");
        assert_eq!(entry.last_opened_at, Some(123));
        assert_eq!(
            entry.stamp,
            stamp::package_stamp(&paths::package_dir(source.path(), &project_id)),
            "the restored row carries the new package stamp"
        );
        let identity = package::read_identity(&paths::database_path(source.path(), &project_id))
            .expect("restored identity");
        assert_eq!(identity.title, "Before");
        assert!(
            !identity.clean_shutdown,
            "the next managed open runs the recovery check"
        );
        assert!(live_asset.is_file(), "the backup's asset was restored");
        assert!(
            backup.join(paths::DATABASE_FILE).is_file(),
            "the backup folder stays"
        );
        assert!(
            fs::read_dir(source.path())
                .expect("projects root")
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".restore-old-")),
            "the parked pre-restore copy is retired after the swap"
        );
    }

    #[test]
    fn restore_replaces_an_unreadable_target() {
        let source = TempRoot::new("restore-unreadable-source");
        let destination_root = TempRoot::new("restore-unreadable-destination");
        let (project_id, _) = create_with_asset(source.path(), "Recovered");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        let live = paths::database_path(source.path(), &project_id);
        fs::write(&live, b"not a database").expect("damage the target");

        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        let pending = prepare_restore(source.path(), &project_id, prepared).expect("build");
        let entry = commit_restore(source.path(), None, pending).expect("commit");
        assert_eq!(entry.title, "Recovered");
        let identity = package::read_identity(&live).expect("restored target");
        assert_eq!(identity.project_id, project_id);
    }

    #[test]
    fn deleting_a_project_retires_a_parked_restore_copy() {
        let root = TempRoot::new("restore-delete-residue");
        let (project_id, _) = create_with_asset(root.path(), "Doomed");
        let parked = paths::restore_parked_dir(root.path(), &project_id);
        fs::create_dir(&parked).expect("parked copy");
        fs::write(parked.join(paths::DATABASE_FILE), b"old").expect("old database");

        crate::project::ops::delete_project(root.path(), None, &project_id).expect("delete");
        paths::recover_restores(root.path());

        assert!(!paths::package_dir(root.path(), &project_id).exists());
        assert!(
            !parked.exists(),
            "the parked copy is retired with the delete"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_delete_that_cannot_retire_the_parked_copy_keeps_the_package() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = TempRoot::new("restore-delete-blocked");
        let (project_id, _) = create_with_asset(root.path(), "Kept");
        let parked = paths::restore_parked_dir(root.path(), &project_id);
        fs::create_dir(&parked).expect("parked copy");
        let database = parked.join(paths::DATABASE_FILE);
        fs::write(&database, b"old").expect("old database");
        // Windows refuses to rename or remove the directory while this handle
        // is open, so retiring the parked copy must fail.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&database)
            .expect("hold the parked database");

        let error = crate::project::ops::delete_project(root.path(), None, &project_id)
            .expect_err("a blocked retirement fails the delete");

        assert!(error.contains("restore residue"), "{error}");
        assert!(
            paths::database_path(root.path(), &project_id).is_file(),
            "the package stays while its parked copy cannot be retired"
        );
        drop(held);
    }

    #[test]
    fn restore_reports_the_zip_source_for_a_damaged_archive() {
        use std::io::Write;
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;

        let root = TempRoot::new("restore-bad-zip-root");
        let zips = TempRoot::new("restore-bad-zip-source");
        let archive = zips.path().join("foreign.zip");
        let file = fs::File::create(&archive).expect("zip file");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file(paths::DATABASE_FILE, SimpleFileOptions::default())
            .expect("database entry");
        writer.write_all(b"not a database").expect("database");
        writer.finish().expect("finish zip");

        let prepared = ops::prepare_import(&archive.to_string_lossy()).expect("prepare");
        let error = prepare_restore(root.path(), "0123456789abcdef0123456789abcdef", prepared)
            .expect_err("a foreign archive is refused");
        assert!(error.contains("foreign.zip"), "{error}");
        assert!(!error.contains("flow-import"), "{error}");
    }

    #[test]
    fn restore_reports_the_zip_source_when_the_extraction_vanishes() {
        use std::io::Write;
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;

        let root = TempRoot::new("restore-vanish-root");
        let zips = TempRoot::new("restore-vanish-source");
        let archive = zips.path().join("backup.zip");
        let file = fs::File::create(&archive).expect("zip file");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file(paths::DATABASE_FILE, SimpleFileOptions::default())
            .expect("database entry");
        writer.write_all(b"not a database").expect("database");
        writer.finish().expect("finish zip");

        let prepared = ops::prepare_import(&archive.to_string_lossy()).expect("prepare");
        if let ops::PreparedImport::Archive { extracted, .. } = &prepared {
            fs::remove_dir_all(extracted.path()).expect("drop the extraction");
        }
        let error = prepare_restore(root.path(), "0123456789abcdef0123456789abcdef", prepared)
            .expect_err("a vanished extraction is refused");
        assert!(error.contains("backup.zip"), "{error}");
        assert!(!error.contains("flow-import"), "{error}");
    }

    #[test]
    fn backup_drops_an_unreferenced_hash_named_asset() {
        let source = TempRoot::new("backup-prune-source");
        let destination_root = TempRoot::new("backup-prune-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Saved");
        let orphan = "f".repeat(64);
        write_asset(source.path(), &project_id, &orphan, b"orphan");

        let backup = backup_to(source.path(), &project_id, destination_root.path());

        assert!(backup.join(paths::ASSETS_DIR).join(&hash).is_file());
        assert!(
            !backup.join(paths::ASSETS_DIR).join(&orphan).exists(),
            "an unreferenced asset is not part of the backup"
        );
    }

    #[test]
    fn restore_drops_an_unreferenced_hash_named_asset() {
        let source = TempRoot::new("restore-prune-source");
        let destination_root = TempRoot::new("restore-prune-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Saved");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        let orphan = "e".repeat(64);
        fs::write(backup.join(paths::ASSETS_DIR).join(&orphan), b"orphan").expect("orphan");

        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        let pending =
            prepare_restore(source.path(), &project_id, prepared).expect("build the restore");
        commit_restore(source.path(), None, pending).expect("commit the restore");

        let assets = paths::assets_dir(source.path(), &project_id);
        assert!(assets.join(&hash).is_file());
        assert!(
            !assets.join(&orphan).exists(),
            "an unreferenced asset is not restored"
        );
    }

    #[test]
    fn restore_accepts_a_zip_backup() {
        use zip::ZipWriter;
        use zip::write::SimpleFileOptions;

        let source = TempRoot::new("restore-zip-source");
        let destination_root = TempRoot::new("restore-zip-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Packed");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        let archive = destination_root.path().join("backup.zip");
        let file = fs::File::create(&archive).expect("zip file");
        let mut writer = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file(paths::DATABASE_FILE, options)
            .expect("database entry");
        writer
            .write_all(&fs::read(backup.join(paths::DATABASE_FILE)).expect("database"))
            .expect("database");
        writer
            .start_file(format!("{}/{}", paths::ASSETS_DIR, hash), options)
            .expect("asset entry");
        writer
            .write_all(&fs::read(backup.join(paths::ASSETS_DIR).join(&hash)).expect("asset"))
            .expect("asset");
        writer.finish().expect("finish zip");

        let prepared = ops::prepare_import(&archive.to_string_lossy()).expect("prepare the zip");
        let pending =
            prepare_restore(source.path(), &project_id, prepared).expect("build the restore");
        let entry = commit_restore(source.path(), None, pending).expect("commit the restore");
        assert_eq!(entry.title, "Packed");
        assert!(
            paths::assets_dir(source.path(), &project_id)
                .join(&hash)
                .is_file()
        );
    }

    #[test]
    fn restore_refuses_another_projects_backup_and_keeps_the_target() {
        let source = TempRoot::new("restore-foreign-source");
        let other = TempRoot::new("restore-foreign-other");
        let destination_root = TempRoot::new("restore-foreign-destination");
        let (project_id, _) = create_with_asset(source.path(), "Mine");
        let (other_id, _) = create_with_asset(other.path(), "Other");
        let backup = backup_to(other.path(), &other_id, destination_root.path());

        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        let error = prepare_restore(source.path(), &project_id, prepared).expect_err("refused");
        assert_eq!(
            error,
            "the backup belongs to another project; import it instead"
        );
        let identity = package::read_identity(&paths::database_path(source.path(), &project_id))
            .expect("target identity");
        assert_eq!(identity.title, "Mine");
    }

    #[test]
    fn restore_refuses_a_damaged_backup() {
        let source = TempRoot::new("restore-damaged-source");
        let destination_root = TempRoot::new("restore-damaged-destination");
        let (project_id, hash) = create_with_asset(source.path(), "Saved");
        let backup = backup_to(source.path(), &project_id, destination_root.path());

        fs::remove_file(backup.join(paths::ASSETS_DIR).join(&hash)).expect("drop an asset");
        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        assert!(
            prepare_restore(source.path(), &project_id, prepared).is_err(),
            "a missing asset refuses the backup"
        );

        fs::write(backup.join(paths::DATABASE_FILE), b"not a database").expect("corrupt");
        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        assert!(
            prepare_restore(source.path(), &project_id, prepared).is_err(),
            "a damaged database refuses the backup"
        );
    }

    #[test]
    fn restore_refuses_the_open_project() {
        let source = TempRoot::new("restore-open-source");
        let destination_root = TempRoot::new("restore-open-destination");
        let (project_id, _) = create_with_asset(source.path(), "Saved");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        let pending = prepare_restore(source.path(), &project_id, prepared).expect("build");
        assert_eq!(
            commit_restore(source.path(), Some(&project_id), pending).err(),
            Some(ops::OPEN_HERE.to_owned())
        );
        let identity = package::read_identity(&paths::database_path(source.path(), &project_id))
            .expect("the target stayed");
        assert_eq!(identity.title, "Saved");
    }

    #[test]
    fn backup_refuses_a_missing_project() {
        let source = TempRoot::new("backup-missing");
        let destination_root = TempRoot::new("backup-missing-destination");
        let destination = destination_root.path().join("backup");
        assert!(
            backup_project(
                source.path(),
                None,
                "0123456789abcdef0123456789abcdef",
                &destination.to_string_lossy()
            )
            .is_err(),
            "a missing package has nothing to back up"
        );
    }

    #[test]
    fn restore_refuses_a_missing_target() {
        let source = TempRoot::new("restore-missing-target");
        let destination_root = TempRoot::new("restore-missing-destination");
        let (project_id, _) = create_with_asset(source.path(), "Saved");
        let backup = backup_to(source.path(), &project_id, destination_root.path());
        fs::remove_dir_all(paths::package_dir(source.path(), &project_id))
            .expect("remove the target package");

        let prepared = ops::prepare_import(&backup.to_string_lossy()).expect("prepare");
        let pending = prepare_restore(source.path(), &project_id, prepared).expect("build");
        assert!(
            commit_restore(source.path(), None, pending).is_err(),
            "there is no package directory to replace"
        );
    }

    #[test]
    fn restore_refuses_a_source_inside_the_projects_folder() {
        let source = TempRoot::new("restore-inside-source");
        let (project_id, _) = create_with_asset(source.path(), "Saved");
        let prepared =
            ops::prepare_import(&paths::package_dir(source.path(), &project_id).to_string_lossy())
                .expect("prepare");
        assert_eq!(
            prepare_restore(source.path(), &project_id, prepared).err(),
            Some("the backup must be outside the projects folder".to_owned())
        );
    }
}
