//! Document counts, emptiness and the bounds cache.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows `crate::db::metadata` after the
//! production split; tests that need it spell the full path.

use super::*;
use crate::db::metadata::{has_edges, has_nodes};
use crate::db::worker::{OpenMode, open_connection};

#[test]
fn empty_document_has_no_nodes_or_edges() {
    fn is_empty(conn: &DatabaseConnection) -> Result<bool, String> {
        Ok(!has_nodes(conn)? && !has_edges(conn)?)
    }

    let conn = open_connection(":memory:", OpenMode::Create)
        .expect("open memory database")
        .conn;
    assert!(is_empty(&conn).expect("empty predicate"));

    mutation::insert_nodes(
        &conn,
        vec![
            node("a", "A", "", &[], 0.0, 0.0),
            node("b", "B", "", &[], 300.0, 0.0),
        ],
    )
    .expect("insert nodes");
    assert!(!is_empty(&conn).expect("node-only predicate"));
}

#[test]
fn empty_document_bounds_are_zero() {
    let db = Database::open(":memory:").expect("open");
    let bounds = db.bounds().expect("bounds");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (0.0, 0.0, 0.0, 0.0)
    );
    let overview = db.overview().expect("overview");
    assert_eq!(
        (
            overview.bounds.x,
            overview.bounds.y,
            overview.bounds.width,
            overview.bounds.height
        ),
        (0.0, 0.0, 0.0, 0.0)
    );
    assert!(overview.cards.is_empty());
}

#[test]
fn bounds_cache_follows_a_move() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let first = db.bounds().expect("bounds");
    assert_eq!((first.x, first.y), (0.0, 0.0));
    // A second read at the same revision reuses the cached entry.
    assert_eq!(db.bounds().expect("cached bounds"), first);

    db.move_nodes(vec!["a".to_owned()], 50.0, 25.0)
        .expect("move");
    // The v1 trigger envelope covers the old and the new rect until
    // compaction; Fit therefore never clips a card that just moved.
    let moved = db.bounds().expect("bounds after move");
    assert_eq!(
        (moved.x, moved.y, moved.width, moved.height),
        (0.0, 0.0, 250.0, 109.0)
    );
    db.compact_bounds().expect("compact bounds");
    let exact = db.bounds().expect("bounds after compaction");
    assert_eq!(
        (exact.x, exact.y, exact.width, exact.height),
        (50.0, 25.0, 200.0, 84.0)
    );
}
