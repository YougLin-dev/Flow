//! Names and layout of a managed projects root.
//!
//! One root holds the self-contained packages (`<root>/<project_id>/`), the
//! rebuildable catalog and the ephemeral cross-process locks. A lock lives
//! outside its package: Windows refuses to rename a directory while any
//! handle inside it is open, so delete/duplicate/import could not move the
//! package while holding an in-package lock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::schema::v1;

/// The package database's file name inside a project directory.
pub(crate) const DATABASE_FILE: &str = "project.db";
/// The content-addressed asset files of a package.
pub(crate) const ASSETS_DIR: &str = "assets";
/// The derived project list. It is never the source of truth.
pub(crate) const CATALOG_FILE: &str = "catalog.json";
/// Ephemeral OS locks; never copied into a package and never deleted.
pub(crate) const LOCKS_DIR: &str = ".locks";

/// Temp and trash directories at the root are swept once this old.
const RESIDUE_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Resolves and prepares the projects root. A root that does not exist is
/// created; one that exists must be a directory and readable. The returned
/// path is absolute so catalog paths and lock names never depend on the
/// process's working directory.
pub(crate) fn prepare_root(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("the projects directory is empty".to_owned());
    }
    let absolute = std::path::absolute(root)
        .map_err(|error| format!("the projects directory could not be created: {error}"))?;
    match fs::metadata(&absolute) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(not_a_directory(&absolute)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&absolute)
                .map_err(|error| format!("the projects directory could not be created: {error}"))?;
        }
        Err(error) => {
            return Err(format!("the projects directory could not be read: {error}"));
        }
    }
    fs::read_dir(&absolute)
        .map_err(|error| format!("the projects directory could not be read: {error}"))?;
    Ok(absolute)
}

fn not_a_directory(path: &Path) -> String {
    format!(
        "the projects directory is not a directory: {}",
        path.display()
    )
}

/// A project id must be exactly 32 lowercase hex characters, so it can never
/// escape the root when joined to it.
pub(crate) fn validate_id(project_id: &str) -> Result<(), String> {
    if v1::is_project_id(project_id) {
        Ok(())
    } else {
        Err("the project id is invalid".to_owned())
    }
}

pub(crate) fn package_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join(project_id)
}

pub(crate) fn database_path(root: &Path, project_id: &str) -> PathBuf {
    package_dir(root, project_id).join(DATABASE_FILE)
}

pub(crate) fn assets_dir(root: &Path, project_id: &str) -> PathBuf {
    package_dir(root, project_id).join(ASSETS_DIR)
}

pub(crate) fn catalog_path(root: &Path) -> PathBuf {
    root.join(CATALOG_FILE)
}

pub(crate) fn lock_path(root: &Path, project_id: &str) -> PathBuf {
    root.join(LOCKS_DIR).join(format!("{project_id}.lock"))
}

/// Whether a directory name is a project package candidate. Dot-directories
/// (`.locks`, temp and trash residue) never qualify.
pub(crate) fn is_package_name(name: &str) -> bool {
    v1::is_project_id(name)
}

/// A fresh suffix for temp and trash names: process, wall clock, counter.
/// It only has to keep this process's names distinct.
pub(crate) fn unique_suffix() -> String {
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{count}", std::process::id(), crate::clock::now_ms())
}

pub(crate) fn create_temp_dir(root: &Path, kind: &str) -> Result<PathBuf, String> {
    let path = root.join(format!(".{kind}-{}", unique_suffix()));
    fs::create_dir(&path)
        .map_err(|error| format!("the project package could not be created: {error}"))?;
    Ok(path)
}

pub(crate) fn trash_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join(format!(".trash-{project_id}-{}", unique_suffix()))
}

/// A parked pre-restore package: the old directory kept while the restored
/// one replaces it, named so a crash between the two renames is recoverable.
const RESTORE_OLD_PREFIX: &str = ".restore-old-";

pub(crate) fn restore_parked_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join(format!(
        "{RESTORE_OLD_PREFIX}{project_id}-{}",
        unique_suffix()
    ))
}

fn restore_old_project(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(RESTORE_OLD_PREFIX)?;
    // `get` refuses a boundary in the middle of a multi-byte character, so a
    // user-created folder with such a name is ignored rather than panicking
    // the store open.
    let project_id = rest.get(..32)?;
    if !rest.get(32..)?.starts_with('-') || !v1::is_project_id(project_id) {
        return None;
    }
    Some(project_id)
}

/// Moves every parked pre-restore copy of a project to trash and removes it.
/// Delete uses this before removing the package, so a leftover parked copy
/// can never be recovered after the user deleted the project; a copy that
/// cannot be retired fails the delete instead of leaving that path.
pub(crate) fn retire_restores(root: &Path, project_id: &str) -> Result<(), String> {
    // A delete that cannot even enumerate the root must fail: continuing
    // would remove the package while a parked copy stays recoverable.
    let entries = fs::read_dir(root)
        .map_err(|error| format!("the project's restore residue could not be read: {error}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("the project's restore residue could not be read: {error}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if restore_old_project(name) != Some(project_id) {
            continue;
        }
        let path = entry.path();
        if !is_real_dir(&path) {
            continue;
        }
        let trash = trash_dir(root, project_id);
        match crate::fsutil::rename(&path, &trash) {
            Ok(()) => {
                let _ = crate::fsutil::remove_dir_all(&trash);
            }
            // An unlocked sweep in another window may have removed it between
            // the listing and the rename; the postcondition already holds.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(rename_error) => match crate::fsutil::remove_dir_all(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(remove_error) => {
                    return Err(format!(
                        "the project's restore residue could not be removed: {remove_error} ({rename_error})"
                    ));
                }
            },
        }
    }
    Ok(())
}

/// Restores a package that a crash left parked under its pre-restore name.
/// Only a missing package directory is recovered; when the package exists the
/// parked copy is ordinary residue. The newest copy wins.
pub(crate) fn recover_restores(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut parked: Vec<(i64, String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(project_id) = restore_old_project(name) else {
            continue;
        };
        let path = entry.path();
        if !is_real_dir(&path) || package_dir(root, project_id).exists() {
            continue;
        }
        let modified = fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|modified| modified.as_millis() as i64)
            .unwrap_or(0);
        parked.push((modified, project_id.to_owned(), path));
    }
    parked.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut recovered = std::collections::HashSet::new();
    for (_, project_id, path) in parked {
        if !recovered.insert(project_id.clone()) {
            continue;
        }
        // Another window may be mid-restore or deleting this package; its
        // package lock is the interlock. Skip it rather than undo the swap.
        let Ok(_lock) = super::lock::PackageLock::acquire(root, &project_id) else {
            continue;
        };
        let _ = crate::fsutil::rename(&path, &package_dir(root, &project_id));
    }
}

/// Whether a directory entry is a real directory, not a symlink. Symlinked
/// project dirs are ignored by scans rather than followed out of the root.
pub(crate) fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// Whether a path is a regular file, not a symlink or a directory.
pub(crate) fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// Removes temp and trash residue older than a day. A crash can leave a
/// complete-but-invisible package under a temp name or an inert trash
/// directory; neither is ever listed. Best effort: a locked or vanished
/// entry is left for the next sweep.
pub(crate) fn sweep_residue(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = crate::clock::now_ms();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_residue(name) {
            continue;
        }
        // A recoverable parked pre-restore copy is the only copy while its
        // package is missing; keep it for the next recovery attempt. A file or
        // symlink with the same shape is never recovered, so it stays residue.
        let path = entry.path();
        if let Some(project_id) = restore_old_project(name)
            && !package_dir(root, project_id).exists()
            && is_real_dir(&path)
        {
            continue;
        }
        let old = fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|modified| now - modified.as_millis() as i64 > RESIDUE_MAX_AGE_MS)
            .unwrap_or(false);
        if old {
            let _ = fs::remove_dir_all(&path);
            let _ = fs::remove_file(&path);
        }
    }
}

fn is_residue(name: &str) -> bool {
    [
        ".create-",
        ".copy-",
        ".import-",
        ".trash-",
        ".restore-",
        ".catalog.json.tmp-",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_root_creates_and_returns_an_absolute_directory() {
        let base = std::env::temp_dir().join(format!("flow-paths-{}", unique_suffix()));
        let root = base.join("nested").join("projects");
        let prepared = prepare_root(&root.to_string_lossy()).expect("prepare root");
        assert!(prepared.is_absolute());
        assert!(prepared.is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prepare_root_refuses_empty_and_file_roots() {
        assert_eq!(
            prepare_root("   "),
            Err("the projects directory is empty".to_owned())
        );
        let base = std::env::temp_dir().join(format!("flow-paths-file-{}", unique_suffix()));
        fs::write(&base, b"not a directory").expect("write file root");
        let error = prepare_root(&base.to_string_lossy()).expect_err("file root");
        assert!(error.starts_with("the projects directory is not a directory:"));
        let _ = fs::remove_file(&base);
    }

    #[test]
    fn ids_are_validated_and_layout_names_are_stable() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(validate_id(id), Ok(()));
        for invalid in ["", "0123", "../../etc", "0123456789ABCDEF0123456789ABCDEF"] {
            assert_eq!(
                validate_id(invalid),
                Err("the project id is invalid".to_owned())
            );
            assert!(!is_package_name(invalid));
        }
        let root = Path::new("/projects");
        assert_eq!(database_path(root, id), root.join(id).join("project.db"));
        assert_eq!(assets_dir(root, id), root.join(id).join("assets"));
        assert_eq!(
            lock_path(root, id),
            root.join(".locks").join(format!("{id}.lock"))
        );
        assert_eq!(catalog_path(root), root.join("catalog.json"));
    }

    fn backdate(path: &Path) {
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            fs::OpenOptions::new()
                .write(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
        };
        #[cfg(not(windows))]
        let file = fs::File::open(path);
        file.expect("open residue")
            .set_modified(old)
            .expect("backdate residue");
    }

    #[test]
    fn residue_sweep_removes_only_old_temp_trash_and_catalog_temps() {
        let root = std::env::temp_dir().join(format!("flow-paths-residue-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        for name in [
            ".create-young",
            ".copy-young",
            ".import-young",
            ".restore-new-young",
            ".trash-0123456789abcdef0123456789abcdef-young",
        ] {
            fs::create_dir(root.join(name)).expect("young residue dir");
        }
        let old_trash = ".trash-0123456789abcdef0123456789abcdef-old";
        for name in [
            ".create-old",
            ".copy-old",
            ".import-old",
            ".restore-new-old",
            old_trash,
        ] {
            let path = root.join(name);
            fs::create_dir(&path).expect("old residue dir");
            backdate(&path);
        }
        let old_catalog_temp = root.join(".catalog.json.tmp-old");
        fs::write(&old_catalog_temp, b"{}").expect("old catalog temp");
        backdate(&old_catalog_temp);
        fs::create_dir(root.join("keep-me")).expect("plain dir");

        sweep_residue(&root);

        for name in [
            ".create-young",
            ".copy-young",
            ".import-young",
            ".restore-new-young",
            ".trash-0123456789abcdef0123456789abcdef-young",
            "keep-me",
        ] {
            assert!(
                root.join(name).exists(),
                "young/non-residue {name} must stay"
            );
        }
        for name in [
            ".create-old",
            ".copy-old",
            ".import-old",
            ".restore-new-old",
            old_trash,
        ] {
            assert!(
                !root.join(name).exists(),
                "old residue {name} must be swept"
            );
        }
        assert!(!old_catalog_temp.exists(), "old catalog temp must be swept");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_parked_pre_restore_package_is_recovered_when_the_package_is_missing() {
        let root = std::env::temp_dir().join(format!("flow-paths-restore-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let id = "0123456789abcdef0123456789abcdef";
        let package = package_dir(&root, id);
        fs::create_dir_all(&package).expect("package");
        fs::write(package.join(DATABASE_FILE), b"old").expect("database");
        let parked = restore_parked_dir(&root, id);
        fs::rename(&package, &parked).expect("park");

        recover_restores(&root);

        assert!(package.join(DATABASE_FILE).is_file(), "the package is back");
        assert!(!parked.exists(), "the parked copy was renamed back");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_residue_name_that_splits_a_character_is_ignored() {
        let root = std::env::temp_dir().join(format!("flow-paths-utf8-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let name = format!(".restore-old-a{}", "é".repeat(20));
        let parked = root.join(&name);
        fs::create_dir(&parked).expect("parked");

        recover_restores(&root);

        assert!(parked.exists(), "an unrecognized name is left alone");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_sweep_keeps_a_parked_copy_that_is_the_only_one() {
        let root = std::env::temp_dir().join(format!("flow-paths-keep-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let id = "0123456789abcdef0123456789abcdef";
        let parked = restore_parked_dir(&root, id);
        fs::create_dir_all(&parked).expect("parked");
        backdate(&parked);

        sweep_residue(&root);
        assert!(
            parked.exists(),
            "the only copy stays after a failed recovery"
        );

        fs::create_dir_all(package_dir(&root, id)).expect("restored package");
        sweep_residue(&root);
        assert!(
            !parked.exists(),
            "the copy is residue once the package exists"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_held_package_is_not_recovered() {
        let root = std::env::temp_dir().join(format!("flow-paths-held-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let id = "0123456789abcdef0123456789abcdef";
        let parked = restore_parked_dir(&root, id);
        fs::create_dir_all(&parked).expect("parked");
        let lock =
            super::super::lock::PackageLock::acquire(&root, id).expect("hold the package lock");

        recover_restores(&root);

        assert!(parked.exists(), "a held package is not recovered");
        assert!(!package_dir(&root, id).exists());

        drop(lock);
        recover_restores(&root);
        assert!(
            package_dir(&root, id).is_dir(),
            "the copy is recovered once free"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn retiring_from_an_unreadable_root_fails() {
        let root = std::env::temp_dir().join(format!("flow-paths-missing-{}", unique_suffix()));
        assert!(
            retire_restores(&root, "0123456789abcdef0123456789abcdef").is_err(),
            "a delete must not proceed while it cannot look for parked copies"
        );
    }

    #[test]
    fn the_sweep_removes_a_parked_name_that_is_not_a_directory() {
        let root = std::env::temp_dir().join(format!("flow-paths-keep-file-{}", unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let id = "0123456789abcdef0123456789abcdef";
        let parked = restore_parked_dir(&root, id);
        fs::write(&parked, b"not a directory").expect("parked file");
        backdate(&parked);

        sweep_residue(&root);

        assert!(
            !parked.exists(),
            "a parked name that is not a recoverable directory is residue"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
