//! The one commit path for a temp package.
//!
//! Create, duplicate and import all build a complete package under a
//! dot-named temp directory at the root, flush it, and make it visible with
//! one directory rename. Sharing the sequence keeps their durability and
//! cleanup behaviour identical; a failure anywhere before the rename leaves
//! the temp directory to `Drop`, and a failure after it leaves residue the
//! root sweep removes after a day.

use std::path::Path;

use crate::fsutil;
use crate::project::catalog;
use crate::project::paths;

/// A temp package that removes itself unless [`TempPackage::commit`] renames
/// it into place.
pub(crate) struct TempPackage {
    path: std::path::PathBuf,
}

impl TempPackage {
    pub(crate) fn create(root: &Path, kind: &str) -> Result<Self, String> {
        Ok(Self {
            path: paths::create_temp_dir(root, kind)?,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Flushes the database file, then renames the package to its final name.
    /// The caller must have dropped its database connection first: Windows
    /// cannot rename a directory while a handle inside it is open.
    ///
    /// Directory flushes are best effort: SMB refuses `FlushFileBuffers` on a
    /// directory with `ERROR_INVALID_FUNCTION`, and a network projects root
    /// must still commit. Every file was already flushed individually.
    pub(crate) fn commit(self, root: &Path, entry: &catalog::Entry) -> Result<(), String> {
        let database = self.path.join(paths::DATABASE_FILE);
        fsutil::sync_file(&database)?;
        fsutil::sync_dir_best_effort(&self.path.join(paths::ASSETS_DIR));
        fsutil::sync_dir_best_effort(&self.path);

        let target = paths::package_dir(root, &entry.path);
        if target.exists() {
            return Err(format!(
                "the project package already exists: {}",
                target.display()
            ));
        }
        fsutil::rename(&self.path, &target).map_err(|error| {
            format!("the project package could not be moved into place: {error}")
        })?;
        fsutil::sync_dir_best_effort(root);

        // The catalog is derived; list reconciliation adds the entry if this
        // best-effort write fails or a crash happens before it.
        let _ = catalog::upsert(root, entry.clone());
        Ok(())
    }
}

impl Drop for TempPackage {
    fn drop(&mut self) {
        let _ = fsutil::remove_dir_all(&self.path);
    }
}
