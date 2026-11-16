//! The recovery check and bounds repair.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::{
    ActiveValue::Set, ActiveValue::Unchanged, ConnectionTrait, DatabaseConnection, EntityTrait,
    FromQueryResult, QuerySelect,
};

use crate::document;
use crate::edge_index;
use crate::entity::{document as document_row, nodes};
use crate::schema;

use super::Database;

/// The reason an in-flight recovery check stops early: the package is being
/// closed, and the next open re-runs the check.
const VERIFY_CLOSING: &str = "the database is closing";

impl Database {
    /// The recovery check for a package that was not closed cleanly: SQLite's
    /// integrity and foreign-key checks, then the FTS/RTree parity repairs, a
    /// dirty-connector flush and exact bounds in one transaction. Kept off
    /// the open path: the 100k fixture makes a full check expensive.
    ///
    /// The outcome is stored from inside the worker job, so a close queued
    /// after it always sees the result. A close requested while the check
    /// runs aborts it between phases and leaves the package due for recovery.
    pub fn verify(&self) -> Result<(), String> {
        let recovery_pending = Arc::clone(&self.recovery_pending);
        let closing = Arc::clone(&self.closing);
        let result = self.run_job(
            move |conn| {
                let outcome = verify_connection(conn, || closing.load(Ordering::SeqCst));
                recovery_pending.store(outcome.is_err(), Ordering::SeqCst);
                outcome
            },
            true,
        );
        if result.is_ok() {
            self.clear_bounds_cache();
        }
        result
    }

    /// Tightens the conservative document bounds after deletes, and records
    /// that they are exact. Maintenance only: it does not bump the revision.
    pub fn compact_bounds(&self) -> Result<(), String> {
        let result = self.run(|conn| {
            conn.transaction::<_, _, sea_orm::DbErr>(compact_bounds_tx)
                .map_err(|error| error.to_string())
        });
        if result.is_ok() {
            self.clear_bounds_cache();
        }
        result
    }
}

/// The recovery body. The stop decision is sampled between phases, so a quit
/// aborts the check as soon as the current statement returns. `quick_check`
/// itself cannot be interrupted, so it still bounds the wait on a large
/// package; a package left dirty by that abort verifies on the next open.
/// The decision is a callback so tests can flip it at a chosen phase.
pub(super) fn verify_connection(
    conn: &DatabaseConnection,
    stop: impl Fn() -> bool,
) -> Result<(), String> {
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    check_quick_check(conn)?;
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    check_foreign_keys(conn)?;
    if stop() {
        return Err(VERIFY_CLOSING.to_owned());
    }
    conn.transaction::<_, _, sea_orm::DbErr>(|txn| {
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        schema::maintenance::repair_fts(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        edge_index::flush_geometry_tx(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        schema::maintenance::repair_rtrees(txn)?;
        if stop() {
            return Err(sea_orm::DbErr::Custom(VERIFY_CLOSING.to_owned()));
        }
        compact_bounds_tx(txn)
    })
    .map_err(|error| format!("the document repair failed: {error}"))
}

pub(crate) fn check_quick_check(conn: &DatabaseConnection) -> Result<(), String> {
    let integrity = conn
        .query_one_raw(sea_orm::Statement::from_string(
            conn.get_database_backend(),
            "PRAGMA quick_check".to_owned(),
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "quick_check returned no row".to_owned())?
        .try_get_by_index::<String>(0)
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!(
            "the database failed its integrity check: {integrity}"
        ));
    }
    Ok(())
}

fn check_foreign_keys(conn: &DatabaseConnection) -> Result<(), String> {
    let violations = conn
        .query_all_raw(sea_orm::Statement::from_string(
            conn.get_database_backend(),
            "PRAGMA foreign_key_check".to_owned(),
        ))
        .map_err(|error| error.to_string())?;
    if !violations.is_empty() {
        return Err(format!(
            "the database has {} foreign-key violation(s)",
            violations.len()
        ));
    }
    Ok(())
}

/// Recomputes the exact content bounds in the caller's transaction. Shared by
/// `compact_bounds` and `verify`, so a repair does not enqueue a second worker
/// job behind its own.
fn compact_bounds_tx(conn: &impl ConnectionTrait) -> Result<(), sea_orm::DbErr> {
    #[derive(FromQueryResult)]
    struct Bounds {
        min_x: Option<f64>,
        max_x: Option<f64>,
        min_y: Option<f64>,
        max_y: Option<f64>,
    }
    let bounds = nodes::Entity::find()
        .select_only()
        .expr_as(Expr::col(nodes::Column::X).min(), "min_x")
        .expr_as(
            Expr::col(nodes::Column::X)
                .add(Expr::col(nodes::Column::Width))
                .max(),
            "max_x",
        )
        .expr_as(Expr::col(nodes::Column::Y).min(), "min_y")
        .expr_as(
            Expr::col(nodes::Column::Y)
                .add(Expr::col(nodes::Column::Height))
                .max(),
            "max_y",
        )
        .into_model::<Bounds>()
        .one(conn)?
        .unwrap_or(Bounds {
            min_x: None,
            max_x: None,
            min_y: None,
            max_y: None,
        });
    document_row::Entity::update(document_row::ActiveModel {
        id: Unchanged(document::ROW_ID),
        bounds_exact: Set(1),
        min_x: Set(bounds.min_x),
        max_x: Set(bounds.max_x),
        min_y: Set(bounds.min_y),
        max_y: Set(bounds.max_y),
        ..Default::default()
    })
    .exec(conn)?;
    Ok(())
}
