//! Opening the document handle and the managed package guard.

use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use crate::asset;
use crate::history::History;

use super::worker::{self, Job, OpenMode};
use super::{AssetsDir, Database};

impl Database {
    /// Opens `path`, creating the file and its schema when missing. This is
    /// the legacy/dev path (`FLOW_DB_PATH`, tests and the 100k smoke).
    pub fn open(path: &str) -> Result<Self, String> {
        Self::open_with(path, OpenMode::Create)
    }

    /// Opens an existing package and requires its document identity. A
    /// missing or empty file is refused without creating it or its parent
    /// directory, and the package is only marked dirty after the identity
    /// matches.
    pub(crate) fn open_package(path: &str, project_id: String) -> Result<Self, String> {
        Self::open_with(path, OpenMode::Existing { project_id })
    }

    fn open_with(path: &str, mode: OpenMode) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let path = path.to_owned();
        let assets_dir = Arc::new(AssetsDir {
            path: asset::assets_dir_for(&path),
            temporary: path == ":memory:",
        });

        std::thread::Builder::new()
            .name("flow-db".to_owned())
            .spawn(move || worker::worker(&path, mode, ready_tx, job_rx))
            .map_err(|error| error.to_string())?;

        let opened_clean = ready_rx
            .recv()
            .map_err(|_| "the database worker stopped during startup".to_owned())??;

        Ok(Self {
            tx: Arc::new(Mutex::new(job_tx)),
            history: Arc::new(Mutex::new(History::default())),
            assets_dir,
            bounds_cache: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
            closing: Arc::new(AtomicBool::new(false)),
            recovery_pending: Arc::new(AtomicBool::new(!opened_clean)),
            opened_clean,
        })
    }
}
