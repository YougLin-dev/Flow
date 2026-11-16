//! Counts, bounds cache and emptiness.

use std::sync::{Arc, Mutex};

use sea_orm::DatabaseConnection;

use crate::document;
use crate::scene;
use crate::types::{Overview, Viewport};

use super::Database;

impl Database {
    pub fn bounds(&self) -> Result<Viewport, String> {
        let cache = self.bounds_cache.clone();
        self.run_read(move |conn| cached_bounds(conn, &cache))
    }

    pub fn overview(&self) -> Result<Overview, String> {
        let cache = self.bounds_cache.clone();
        self.run_read(move |conn| {
            let bounds = cached_bounds(conn, &cache)?;
            scene::overview(conn, bounds)
        })
    }

    pub fn count(&self) -> Result<u32, String> {
        self.run_read(count)
    }

    pub fn edge_count(&self) -> Result<u32, String> {
        self.run_read(edge_count)
    }

    /// Whether the open document has neither nodes nor edges. One worker job
    /// answers startup's seed question with two existence reads, not counts.
    pub fn is_empty(&self) -> Result<bool, String> {
        self.run_read(|conn| Ok(!has_nodes(conn)? && !has_edges(conn)?))
    }

    pub(super) fn clear_bounds_cache(&self) {
        if let Ok(mut cache) = self.bounds_cache.lock() {
            *cache = None;
        }
    }
}

/// The document bounds at the current revision, reusing the last read.
///
/// Every command bumps the document revision, so an entry from another
/// revision is never reused: a change that moves, adds or removes a node
/// invalidates the cache by construction. Fit and the minimap's overview ask
/// at the same revision at startup, and repeated Fit presses reuse the entry.
fn cached_bounds(
    conn: &DatabaseConnection,
    cache: &Arc<Mutex<Option<(i64, Viewport)>>>,
) -> Result<Viewport, String> {
    let rev = document::current_rev(conn).map_err(|error| error.to_string())?;
    {
        let cached = cache
            .lock()
            .map_err(|_| "the bounds cache lock is poisoned".to_owned())?;
        if let Some((cached_rev, bounds)) = cached.as_ref()
            && *cached_rev == rev
        {
            return Ok(bounds.clone());
        }
    }
    let bounds = scene::bounds(conn)?;
    *cache
        .lock()
        .map_err(|_| "the bounds cache lock is poisoned".to_owned())? = Some((rev, bounds.clone()));
    Ok(bounds)
}

fn count(conn: &DatabaseConnection) -> Result<u32, String> {
    let document = document::current(conn).map_err(|error| error.to_string())?;
    Ok(std::cmp::Ord::max(document.node_count, 0) as u32)
}

fn edge_count(conn: &DatabaseConnection) -> Result<u32, String> {
    let document = document::current(conn).map_err(|error| error.to_string())?;
    Ok(std::cmp::Ord::max(document.edge_count, 0) as u32)
}

/// Whether any node exists, read from the trigger-maintained document
/// counters in one primary-key row.
pub(super) fn has_nodes(conn: &DatabaseConnection) -> Result<bool, String> {
    Ok(count(conn)? > 0)
}

/// Whether any edge exists, read from the trigger-maintained document
/// counters in one primary-key row.
pub(super) fn has_edges(conn: &DatabaseConnection) -> Result<bool, String> {
    Ok(edge_count(conn)? > 0)
}
