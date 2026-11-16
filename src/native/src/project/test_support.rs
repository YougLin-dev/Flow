//! Test fixtures for the project layer: real directories under the OS temp
//! directory, removed with Windows-safe retries. Tests exercise real files,
//! OS locks and file-backed SQLite; `:memory:` cannot model a package.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::fsutil;
use crate::project::{ProjectLease, create, open_lease, open_state, paths};

pub(crate) struct TempRoot {
    root: PathBuf,
}

impl TempRoot {
    pub(crate) fn new(label: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("flow-project-{label}-{}", paths::unique_suffix()));
        fs::create_dir_all(&root).expect("test root");
        Self { root }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fsutil::remove_dir_all(&self.root);
    }
}

/// Creates a package under `root` and leases it. The returned state lets a
/// test lease the same package again after a release, proving the window
/// slot was freed; release the lease after the document closes.
pub(crate) fn create_and_lease(root: &Path, title: &str) -> (Arc<super::StoreState>, ProjectLease) {
    let state = Arc::new(open_state(root.to_string_lossy().into_owned()).expect("open store"));
    let entry = create::create_project(&state.root, title, None).expect("create project");
    let lease =
        open_lease(Arc::clone(&state), entry.project_id).expect("lease the created project");
    (state, lease)
}

/// Leases an existing package from a store state already held by a test.
pub(crate) fn lease_from(state: &Arc<super::StoreState>, project_id: &str) -> ProjectLease {
    open_lease(Arc::clone(state), project_id.to_owned()).expect("lease the project")
}
