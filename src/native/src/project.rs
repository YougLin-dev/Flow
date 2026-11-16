//! The managed projects root and the package session lease.
//!
//! `ProjectStore` owns `<root>`: it lists, creates, renames, deletes,
//! duplicates and imports self-contained packages, and it hands out one
//! `ProjectLease` at a time. The lease owns the cross-process lock of a
//! package and the absolute database path the workspace opens with
//! `Document.openPackage`; the workspace releases it only after the document
//! worker has closed, so two connections never overlap on one package.
//!
//! This module is the FFI half: it clones state, runs the cohesive work on
//! NSH's blocking pool, and converts catalog entries into the list DTO. No
//! SQL lives in `project/`; ordinary rows go through SeaORM, and the few
//! package-wide statements live in `schema::package`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use nsh_core::prelude::*;

mod catalog;
mod commit;
mod create;
mod lock;
mod ops;
mod package;
mod paths;
mod stamp;
#[cfg(test)]
pub(crate) mod test_support;

use crate::clock;
use crate::types::{ProjectEntry, SeedDocumentInput};

/// The active package in this window. The token lets `ProjectLease::release`
/// clear only the slot it created.
struct ActiveProject {
    token: u64,
    project_id: String,
}

/// State shared by the store and its lease.
pub(crate) struct StoreState {
    root: PathBuf,
    /// Serializes catalog read-modify-write cycles and keeps lock ordering
    /// (catalog, then active slot, then package lock) acyclic.
    catalog: Mutex<()>,
    active: Mutex<Option<ActiveProject>>,
}

static LEASE_TOKEN: AtomicU64 = AtomicU64::new(0);

/// The projects root: a directory of self-contained project packages.
#[class]
pub struct ProjectStore {
    state: Arc<StoreState>,
}

/// An exclusive claim on one package for this window. It carries the
/// database path for `Document.openPackage`; release it only after the
/// document closed.
#[class]
pub struct ProjectLease {
    state: Arc<StoreState>,
    token: u64,
    project_id: String,
    database_path: String,
    lock: Option<lock::PackageLock>,
}

#[class]
impl ProjectStore {
    /// Opens a managed projects root, creating it when missing.
    pub async fn open(root: String) -> Result<ProjectStore, String> {
        let state = crate::off_thread(move || open_state(root)).await?;
        Ok(ProjectStore {
            state: Arc::new(state),
        })
    }

    /// Lists the projects, newest-opened first. A missing or corrupt catalog
    /// is rebuilt from the packages on disk; packages that cannot be read
    /// are still listed with a fallback row so they are not silently lost.
    pub async fn list_projects(this: Instance<Self>) -> Result<Vec<ProjectEntry>, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let entries = catalog::list(&state.root)?;
            Ok(entries
                .into_iter()
                .map(|entry| entry_view(&state, entry))
                .collect())
        })
        .await
    }

    /// Re-reads every package and rewrites the catalog. Unlike `list`, this
    /// opens known packages too, so it reflects out-of-band edits.
    pub async fn refresh_catalog(this: Instance<Self>) -> Result<Vec<ProjectEntry>, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            paths::sweep_residue(&state.root);
            let entries = catalog::refresh(&state.root)?;
            Ok(entries
                .into_iter()
                .map(|entry| entry_view(&state, entry))
                .collect())
        })
        .await
    }

    /// Creates a project package. Without a seed the project stays empty but
    /// records that the initial-content decision was made; with a seed the
    /// content is written before the package becomes visible.
    pub async fn create_project(
        this: Instance<Self>,
        title: String,
        seed: Option<SeedDocumentInput>,
    ) -> Result<ProjectEntry, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let entry = create::create_project(&state.root, &title, seed)?;
            Ok(entry_view(&state, entry))
        })
        .await
    }

    /// Claims a project for this window: takes its cross-process lock and
    /// returns the database path to open. Only one project can be open per
    /// store; releasing the lease or dropping the process frees it.
    pub async fn open_project(
        this: Instance<Self>,
        project_id: String,
    ) -> Result<ProjectLease, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || open_lease(state, project_id)).await
    }

    /// Renames a closed package without moving its directory or touching
    /// its content revision.
    pub async fn rename_project(
        this: Instance<Self>,
        project_id: String,
        title: String,
    ) -> Result<ProjectEntry, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let active = active_project(&state);
            let entry = ops::rename_project(&state.root, active.as_deref(), &project_id, &title)?;
            Ok(entry_view(&state, entry))
        })
        .await
    }

    /// Deletes a closed package. The directory disappears in one rename; a
    /// failed purge only leaves swept residue.
    pub async fn delete_project(this: Instance<Self>, project_id: String) -> Result<(), String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let active = active_project(&state);
            ops::delete_project(&state.root, active.as_deref(), &project_id)
        })
        .await
    }

    /// Duplicates a closed package under a new identity and title.
    pub async fn duplicate_project(
        this: Instance<Self>,
        project_id: String,
        title: String,
    ) -> Result<ProjectEntry, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let active = active_project(&state);
            let entry =
                ops::duplicate_project(&state.root, active.as_deref(), &project_id, &title)?;
            Ok(entry_view(&state, entry))
        })
        .await
    }

    /// Imports an unpacked package directory from outside the root. The
    /// source is read only; the copy gets a fresh identity when the source's
    /// identity is already taken.
    pub async fn import_project(
        this: Instance<Self>,
        source: String,
    ) -> Result<ProjectEntry, String> {
        let state = this.with(|store| Arc::clone(&store.state));
        crate::off_thread(move || {
            let _catalog = lock_catalog(&state)?;
            let entry = ops::import_project(&state.root, &source)?;
            Ok(entry_view(&state, entry))
        })
        .await
    }
}

#[class]
impl ProjectLease {
    /// The absolute path of the package database to open.
    #[getter]
    pub fn database_path(&self) -> String {
        self.database_path.clone()
    }

    /// The identity the opened document must carry.
    #[getter]
    pub fn project_id(&self) -> String {
        self.project_id.clone()
    }

    /// Releases the window slot and the OS lock. Idempotent and never
    /// throws; a leaked lease is released by process exit.
    pub fn release(&mut self) {
        let Some(lock) = self.lock.take() else {
            return;
        };
        // Hold the slot until the OS lock is gone. A concurrent list that
        // reads the empty slot after the guard drops must not find this
        // window's own lock and label its just-closed project as open
        // elsewhere. Keeping the guard across the drop also means an opener
        // waiting on this slot cannot see "free" while our lock is held.
        let mut slot = self.state.active.lock().ok();
        if let Some(active) = slot.as_mut()
            && active
                .as_ref()
                .is_some_and(|project| project.token == self.token)
        {
            **active = None;
        }
        drop(lock);
        drop(slot);
    }
}

impl Drop for ProjectLease {
    fn drop(&mut self) {
        // A lease dropped without `release()` (JS disposal or collection)
        // must still free the window slot and the OS lock, or the store
        // would refuse every later open for the lifetime of the process.
        self.release();
    }
}

fn open_state(root: String) -> Result<StoreState, String> {
    let root = paths::prepare_root(&root)?;
    paths::sweep_residue(&root);
    Ok(StoreState {
        root,
        catalog: Mutex::new(()),
        active: Mutex::new(None),
    })
}

fn open_lease(state: Arc<StoreState>, project_id: String) -> Result<ProjectLease, String> {
    paths::validate_id(&project_id)?;
    let lock;
    let database;
    let token;
    {
        let _catalog = lock_catalog(&state)?;
        let mut active = state
            .active
            .lock()
            .map_err(|_| "the project session lock is poisoned".to_owned())?;
        if let Some(opened) = active.as_ref() {
            return Err(if opened.project_id == project_id {
                ops::OPEN_HERE.to_owned()
            } else {
                ACTIVE_SLOT_ERROR.to_owned()
            });
        }
        lock = lock::PackageLock::acquire(&state.root, &project_id)?;
        database = paths::database_path(&state.root, &project_id);
        // Stat before reading identity: if an out-of-band writer changes the
        // package in between, the stored stamp stays older than the files
        // and the next list re-reads instead of trusting a mixed row.
        let stamp = stamp::package_stamp(&paths::package_dir(&state.root, &project_id));
        let identity = package::read_identity(&database)?;
        if identity.project_id != project_id {
            return Err(package::identity_mismatch(&state.root, &project_id));
        }
        token = LEASE_TOKEN.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        *active = Some(ActiveProject {
            token,
            project_id: project_id.clone(),
        });
        drop(active);
        // The identity was just read, so a fallback row for this package is
        // replaced with the real title even if no refresh ran.
        let _ = catalog::upsert(
            &state.root,
            catalog::Entry {
                path: project_id.clone(),
                project_id: project_id.clone(),
                title: identity.title,
                updated_at: identity.updated_at,
                last_opened_at: None,
                fallback: false,
                stamp,
            },
        );
        let _ = catalog::mark_opened(&state.root, &project_id, clock::now_ms());
    }
    Ok(ProjectLease {
        state,
        token,
        project_id,
        database_path: database.to_string_lossy().into_owned(),
        lock: Some(lock),
    })
}

const ACTIVE_SLOT_ERROR: &str = "another project is already open in this window";

fn lock_catalog(state: &StoreState) -> Result<MutexGuard<'_, ()>, String> {
    state
        .catalog
        .lock()
        .map_err(|_| "the project catalog lock is poisoned".to_owned())
}

fn active_project(state: &StoreState) -> Option<String> {
    state
        .active
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(|project| project.project_id.clone()))
}

fn entry_view(state: &StoreState, entry: catalog::Entry) -> ProjectEntry {
    let active = active_project(state);
    let open_here = active.as_deref() == Some(entry.path.as_str());
    let open_elsewhere = !open_here && lock::is_open_elsewhere(&state.root, &entry.path);
    let unreadable = catalog::is_fallback(&entry);
    ProjectEntry {
        project_id: entry.project_id,
        title: entry.title,
        path: paths::database_path(&state.root, &entry.path)
            .to_string_lossy()
            .into_owned(),
        updated_at: entry.updated_at as f64,
        last_opened_at: entry.last_opened_at.map(|at| at as f64),
        open_here,
        open_elsewhere,
        unreadable,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn open_error_strings_are_stable() {
        assert_eq!(
            lock::OPEN_ELSEWHERE,
            "the project is open in another window"
        );
        assert_eq!(ops::OPEN_HERE, "the project is open in this window");
        assert_eq!(
            ACTIVE_SLOT_ERROR,
            "another project is already open in this window"
        );
    }

    #[test]
    fn a_second_lease_is_refused_and_release_is_idempotent() {
        let root = std::env::temp_dir().join(format!("flow-store-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let root_text = root.to_string_lossy().into_owned();
        let state = Arc::new(open_state(root_text).expect("open state"));
        let first = create::create_project(&state.root, "First", None).expect("first");
        let second = create::create_project(&state.root, "Second", None).expect("second");

        let mut lease = open_lease(Arc::clone(&state), first.project_id.clone()).expect("lease");
        assert_eq!(lease.project_id(), first.project_id);
        assert_eq!(
            lease.database_path(),
            paths::database_path(&state.root, &first.project_id)
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            open_lease(Arc::clone(&state), first.project_id.clone()).err(),
            Some(ops::OPEN_HERE.to_owned()),
            "reopening the active project says so"
        );
        assert_eq!(
            open_lease(Arc::clone(&state), second.project_id.clone()).err(),
            Some(ACTIVE_SLOT_ERROR.to_owned())
        );
        lease.release();
        lease.release();
        let mut next = open_lease(Arc::clone(&state), second.project_id.clone()).expect("next");
        next.release();
        let _ = fs::remove_dir_all(&state.root);
    }

    #[test]
    fn opening_a_lease_stores_the_packages_stamp() {
        let root =
            std::env::temp_dir().join(format!("flow-store-stamp-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open state"));
        let created = create::create_project(&state.root, "Stamped", None).expect("create");
        let expected = stamp::package_stamp(&paths::package_dir(&state.root, &created.path))
            .expect("package stamp");

        let mut lease = open_lease(Arc::clone(&state), created.project_id.clone()).expect("lease");
        let stored = catalog::load_valid(&state.root)
            .expect("catalog")
            .into_iter()
            .find(|entry| entry.path == created.path)
            .expect("stored row");
        assert_eq!(stored.stamp, Some(expected));
        lease.release();
        let _ = fs::remove_dir_all(&state.root);
    }

    #[test]
    fn open_refuses_a_package_whose_identity_does_not_match_its_directory() {
        let root = std::env::temp_dir().join(format!("flow-store-id-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open state"));
        let created = create::create_project(&state.root, "Real", None).expect("create");
        let forged = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        fs::rename(
            paths::package_dir(&state.root, &created.path),
            paths::package_dir(&state.root, forged),
        )
        .expect("forge directory");

        assert_eq!(
            open_lease(Arc::clone(&state), forged.to_owned()).err(),
            Some(package::identity_mismatch(&state.root, forged))
        );
        assert!(
            state.active.lock().expect("session lock").is_none(),
            "a refused open leaves no active slot"
        );
        fs::rename(
            paths::package_dir(&state.root, forged),
            paths::package_dir(&state.root, &created.path),
        )
        .expect("restore directory");
        let mut lease =
            open_lease(Arc::clone(&state), created.project_id.clone()).expect("open after restore");
        lease.release();
        let _ = fs::remove_dir_all(&state.root);
    }

    /// A fresh directory on this machine's local admin share, addressed by
    /// UNC so the path really goes through SMB. `None` when the machine
    /// exposes no such share.
    #[cfg(windows)]
    fn unc_temp_root(label: &str) -> Option<PathBuf> {
        let local = std::env::temp_dir();
        let text = local.to_string_lossy();
        let (drive, rest) = text.split_once(':')?;
        if drive.len() != 1 || !drive.chars().all(|ch| ch.is_ascii_alphabetic()) {
            return None;
        }
        let rest = rest.trim_matches(['\\', '/']);
        let root = PathBuf::from(format!(
            "\\\\127.0.0.1\\{drive}$\\{rest}\\{label}-{}",
            paths::unique_suffix()
        ));
        fs::create_dir_all(&root).ok()?;
        Some(root)
    }

    /// SMB refuses `FlushFileBuffers` on a directory, so the commit and the
    /// managed SQLite open must not depend on it.
    #[cfg(windows)]
    #[test]
    fn a_network_root_commits_lists_and_opens() {
        let Some(root) = unc_temp_root("flow-store-unc") else {
            eprintln!("no local admin share on this machine; the SMB test did not run");
            return;
        };
        let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open state"));
        let created =
            create::create_project(&state.root, "Network", None).expect("create over SMB");
        assert_eq!(created.title, "Network");
        let listed = catalog::list(&state.root).expect("list over SMB");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Network");
        let mut lease =
            open_lease(Arc::clone(&state), created.project_id.clone()).expect("open over SMB");
        assert_eq!(lease.project_id(), created.project_id);
        lease.release();
        let _ = crate::fsutil::remove_dir_all(&state.root);
    }

    #[test]
    fn only_a_fallback_row_lists_as_unreadable() {
        let root =
            std::env::temp_dir().join(format!("flow-store-unreadable-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open state"));
        let created = create::create_project(&state.root, "Real", None).expect("create");
        let forged = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        fs::rename(
            paths::package_dir(&state.root, &created.path),
            paths::package_dir(&state.root, forged),
        )
        .expect("forge directory");

        let entries = catalog::list(&state.root).expect("list");
        let view = entry_view(&state, entries[0].clone());
        assert!(view.unreadable, "a mismatched package is unavailable");
        assert_eq!(view.title, forged, "the row is keyed by its directory");

        fs::rename(
            paths::package_dir(&state.root, forged),
            paths::package_dir(&state.root, &created.path),
        )
        .expect("restore directory");
        let entries = catalog::list(&state.root).expect("list after restore");
        let view = entry_view(&state, entries[0].clone());
        assert!(!view.unreadable, "a readable package stays available");
        assert_eq!(view.title, "Real");
        let _ = fs::remove_dir_all(&state.root);
    }

    #[test]
    fn a_dropped_lease_frees_the_window_slot() {
        let root = std::env::temp_dir().join(format!("flow-store-drop-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("root");
        let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open state"));
        let first = create::create_project(&state.root, "First", None).expect("first");
        let second = create::create_project(&state.root, "Second", None).expect("second");
        {
            let _lease = open_lease(Arc::clone(&state), first.project_id.clone()).expect("lease");
        }
        let mut next =
            open_lease(Arc::clone(&state), second.project_id.clone()).expect("slot freed on drop");
        next.release();
        let _ = fs::remove_dir_all(&state.root);
    }
}
