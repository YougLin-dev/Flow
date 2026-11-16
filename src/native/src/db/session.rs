//! Close, recovery state and the saved view.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

use sea_orm::{ActiveValue::Set, ActiveValue::Unchanged, EntityTrait};

use crate::document;
use crate::entity::document as document_row;
use crate::schema;
use crate::types::ProjectInfo;

use super::Database;
use super::worker::Job;

/// Prefix of a close failure that ran to completion: the worker acknowledged
/// the job (and dropped its connection) but could not make the package
/// clean. The workspace releases the lease; the dirty package verifies on
/// the next open. A failure without this prefix may have left the worker
/// holding the connection.
pub(super) const CLOSE_FAILED_AFTER_STOP: &str = "the document closed with a recovery warning: ";

impl Database {
    /// The package identity, title, camera and derived counts.
    pub fn project_info(&self) -> Result<ProjectInfo, String> {
        let opened_clean = self.opened_clean;
        self.run_read(move |conn| {
            let document = document::current(conn).map_err(|error| error.to_string())?;
            Ok(ProjectInfo {
                project_id: document.project_id,
                title: document.title,
                camera_x: document.camera_x,
                camera_y: document.camera_y,
                camera_zoom: document.camera_zoom,
                node_count: document.node_count as f64,
                edge_count: document.edge_count as f64,
                demo_seeded: document.demo_seeded != 0,
                opened_clean,
            })
        })
    }

    /// Persists the camera without bumping the undo-independent revision.
    pub fn save_view(&self, x: f64, y: f64, zoom: f64) -> Result<(), String> {
        if !schema::v1::is_valid_camera(x, y, zoom) {
            return Err("the camera is outside the supported range".to_owned());
        }
        self.run(move |conn| {
            document_row::Entity::update(document_row::ActiveModel {
                id: Unchanged(document::ROW_ID),
                camera_x: Set(x),
                camera_y: Set(y),
                camera_zoom: Set(zoom),
                ..Default::default()
            })
            .exec(conn)
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    /// Marks the package cleanly closed and stops the worker. Idempotent: a
    /// second call (or a call after the worker stopped) does nothing. A
    /// failed `verify` keeps the package due for recovery: the checkpoint
    /// still runs, but `clean_shutdown` stays 0.
    pub fn close(&self) -> Result<(), String> {
        self.close_with_camera(None)
    }

    /// Saves the camera, then closes like `close`. Folding both into one
    /// worker job lets a quit reach the checkpoint without a second round
    /// trip and without a chained await that a short quit budget can cut.
    pub fn close_with_view(&self, x: f64, y: f64, zoom: f64) -> Result<(), String> {
        if !schema::v1::is_valid_camera(x, y, zoom) {
            return Err("the camera is outside the supported range".to_owned());
        }
        self.close_with_camera(Some((x, y, zoom)))
    }

    fn close_with_camera(&self, camera: Option<(f64, f64, f64)>) -> Result<(), String> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.closing.store(true, Ordering::SeqCst);
        let (result_tx, result_rx) = mpsc::channel();
        let sent = self
            .tx
            .lock()
            .map_err(|_| "the database worker lock is poisoned".to_owned())?
            .send(Job::Close {
                ack: result_tx,
                camera,
                recovery_pending: Arc::clone(&self.recovery_pending),
            });
        if sent.is_err() {
            return Ok(());
        }
        let acked = result_rx
            .recv()
            .map_err(|_| "the database worker stopped during close".to_owned())?;
        // An error from the acknowledged job means the worker already dropped
        // its connection and stopped; the package is merely dirty and will
        // verify on its next open. The marker lets the workspace release the
        // package lease in that case while keeping it when no job ran.
        acked.map_err(|error| format!("{CLOSE_FAILED_AFTER_STOP}{error}"))
    }
}
