//! Test fixtures for the project layer: real directories under the OS temp
//! directory, removed with Windows-safe retries. Tests exercise real files,
//! OS locks and file-backed SQLite; `:memory:` cannot model a package.

use std::fs;
use std::path::{Path, PathBuf};

use crate::fsutil;
use crate::project::paths;

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
