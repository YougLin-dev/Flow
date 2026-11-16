//! The development reset command.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn reset_clears_content_and_keeps_the_project_identity() {
    let db = Database::open(":memory:").expect("open");
    db.seed_document(seed_input()).expect("seed");
    db.insert_nodes(vec![node("extra", "Extra", "", &[], 0.0, 300.0)])
        .expect("extra node");
    let asset = test_asset(&db, "reset-asset");
    db.save_view(10.0, 20.0, 2.0).expect("save the view");
    let before = db.project_info().expect("info before the reset");
    let created_at = db
        .run(|conn| {
            document::current(conn)
                .map(|row| row.created_at)
                .map_err(|error| error.to_string())
        })
        .expect("read the creation time");
    assert!(before.demo_seeded);

    db.reset().expect("reset");

    let after = db.project_info().expect("info after the reset");
    assert_eq!(after.project_id, before.project_id, "identity survives");
    assert_eq!(after.title, before.title);
    assert_eq!((after.node_count, after.edge_count), (0.0, 0.0));
    assert!(!after.demo_seeded);
    assert_eq!(
        (after.camera_x, after.camera_y, after.camera_zoom),
        (0.0, 0.0, 1.0)
    );
    let created_after = db
        .run(|conn| {
            document::current(conn)
                .map(|row| row.created_at)
                .map_err(|error| error.to_string())
        })
        .expect("read the new creation time");
    assert_eq!(created_after, created_at);
    assert!(
        !db.assets_dir.exists(),
        "the parked asset directory is deleted"
    );
    assert!(db.asset_bytes(asset).is_err(), "asset rows are gone");

    // The undo history was cleared, and the recreated schema still works.
    let undo = db.undo().expect("undo after the reset");
    assert!(undo.changed.is_empty() && undo.removed.is_empty());
    db.insert_nodes(vec![node("new", "New", "", &[], 0.0, 0.0)])
        .expect("insert after the reset");
    assert_eq!(db.count().expect("count after the reset"), 1);
    db.verify().expect("verify the recreated schema");
}
