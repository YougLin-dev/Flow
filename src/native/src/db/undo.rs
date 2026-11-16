//! Undo/redo and the in-memory history helpers.

use std::sync::{Arc, Mutex};

use sea_orm::DatabaseConnection;

use crate::document;
#[cfg(test)]
use crate::history::HistoryOp;
use crate::history::{History, HistoryRefs};
use crate::mutation;
use crate::types::ChangeSet;

use super::Database;

impl Database {
    #[cfg(test)]
    pub fn apply_ops(&self, ops: &[HistoryOp]) -> Result<ChangeSet, String> {
        let ops = ops.to_vec();
        self.run(move |conn| match mutation::apply_ops(conn, &ops)? {
            mutation::ApplyOutcome::Applied(changes) => Ok(changes),
            mutation::ApplyOutcome::Stale => empty_change(conn),
        })
    }

    /// Reverts the last command. The history entry is taken and returned in
    /// the same worker job as the database writes.
    pub fn undo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let entry = {
                let mut history = lock_history(&history)?;
                history.take_undo()
            };
            let Some(entry) = entry else {
                return empty_change(conn);
            };
            let mut ops = entry.inverse.clone();
            ops.reverse();
            match mutation::apply_ops(conn, &ops) {
                Ok(mutation::ApplyOutcome::Applied(changes)) => {
                    // The undo is committed. A poisoned lock loses the redo
                    // entry rather than reporting a failure and inviting a
                    // duplicate retry.
                    if let Ok(mut history) = history.lock() {
                        history.push_redo(entry);
                    }
                    Ok(changes)
                }
                Ok(mutation::ApplyOutcome::Stale) => {
                    // The entry can never apply again; drop it rather than
                    // leaving it on the redo stack.
                    empty_change(conn)
                }
                Err(error) => {
                    if let Ok(mut history) = history.lock() {
                        history.restore_undo(entry);
                    }
                    Err(error)
                }
            }
        })
    }

    /// Reapplies the last undone command, on the same worker job.
    pub fn redo(&self) -> Result<ChangeSet, String> {
        let history = Arc::clone(&self.history);
        self.run(move |conn| {
            let entry = {
                let mut history = lock_history(&history)?;
                history.take_redo()
            };
            let Some(entry) = entry else {
                return empty_change(conn);
            };
            let ops = entry.forward.clone();
            match mutation::apply_ops(conn, &ops) {
                Ok(mutation::ApplyOutcome::Applied(changes)) => {
                    if let Ok(mut history) = history.lock() {
                        history.push_undo_after_redo(entry);
                    }
                    Ok(changes)
                }
                Ok(mutation::ApplyOutcome::Stale) => empty_change(conn),
                Err(error) => {
                    if let Ok(mut history) = history.lock() {
                        history.push_redo(entry);
                    }
                    Err(error)
                }
            }
        })
    }

    /// Drops the undo and redo stacks; used after seeding demo data.
    ///
    /// Queued on the worker so it cannot overtake a preceding command and
    /// leave that command's entry behind. Do not call it from inside a job:
    /// the worker is busy executing that job.
    pub fn clear_history(&self) -> Result<(), String> {
        let history = Arc::clone(&self.history);
        self.run(move |_| {
            lock_history(&history)?.clear();
            Ok(())
        })
    }
}

fn empty_change(conn: &DatabaseConnection) -> Result<ChangeSet, String> {
    Ok(ChangeSet {
        rev: document::current_rev(conn).map_err(|error| error.to_string())? as f64,
        changed: Vec::new(),
        removed: Vec::new(),
        edges_changed: Vec::new(),
        edges_removed: Vec::new(),
    })
}

pub(super) fn lock_history(
    history: &Arc<Mutex<History>>,
) -> Result<std::sync::MutexGuard<'_, History>, String> {
    history
        .lock()
        .map_err(|_| "the undo history lock is poisoned".to_owned())
}

pub(super) fn ensure_history(history: &Arc<Mutex<History>>) -> Result<(), String> {
    lock_history(history).map(drop)
}

/// A non-history write has committed; drop the entries it made stale. A
/// poisoned lock is ignored here because the write already happened and an
/// error would invite a duplicate retry.
pub(super) fn invalidate_history(history: &Arc<Mutex<History>>, refs: &HistoryRefs) {
    // A late or repeated write that touched no row must not clear the redo
    // entry a user could still apply.
    if refs.is_empty() {
        return;
    }
    if let Ok(mut history) = history.lock() {
        history.invalidate(refs);
    }
}
