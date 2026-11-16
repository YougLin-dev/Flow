//! Package garbage collection.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows the production `crate::gc`; tests
//! that need it spell the full path.

use super::*;

#[test]
fn gc_refuses_while_the_undo_history_holds_an_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let error = db.gc().expect_err("an undoable edit blocks collection");
    assert!(error.contains("undo history"), "{error}");

    db.clear_history().expect("clear history");
    let report = db.gc().expect("collect an idle package");
    assert_eq!(report.batches, 0.0);
    assert_eq!(report.assets, 0.0);
}

#[test]
fn gc_keeps_outputs_inputs_and_the_newest_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("s", "S", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        result_batch("b1", "s", "done"),
        vec![result_text_item("i1", "one")],
    )
    .expect("first run");
    db.connect_edge(edge("s-t", "s", "t"))
        .expect("snapshot b1 into the target");
    db.save_run(
        result_batch("b2", "s", "done"),
        vec![result_text_item("i2", "two")],
    )
    .expect("second run");
    db.save_run(result_batch("b3", "s", "failed"), Vec::new())
        .expect("failed run");
    db.save_run(
        result_batch("b4", "s", "done"),
        vec![result_text_item("i4", "four")],
    )
    .expect("third run");
    // A later failure keeps b4 as the output but becomes the newest batch,
    // which carries the composer's error line.
    db.save_run(result_batch("b5", "s", "failed"), Vec::new())
        .expect("failed run after the output");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 2.0, "b2 and the failed b3 are unreachable");
    assert_eq!(report.items, 1.0, "only b2 had an item");
    assert!(batch_exists(&db, "b1"), "the input snapshot keeps b1");
    assert!(!batch_exists(&db, "b2"));
    assert!(!batch_exists(&db, "b3"));
    assert!(batch_exists(&db, "b4"), "the output batch stays");
    assert!(batch_exists(&db, "b5"), "the newest batch stays");
    let detail = db
        .node_detail("t".to_owned())
        .expect("detail")
        .expect("target node");
    assert_eq!(detail.inputs[0].item_id.as_deref(), Some("i1"));
    assert!(detail.inputs[0].item.is_some());
    let source = db
        .node_detail("s".to_owned())
        .expect("detail")
        .expect("source node");
    assert_eq!(
        source.batch.as_ref().map(|batch| batch.id.as_str()),
        Some("b4")
    );
    assert_eq!(
        source.latest_batch.as_ref().map(|batch| batch.id.as_str()),
        Some("b5")
    );
}

#[test]
fn gc_collects_a_deleted_incarnations_batches() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("x", "X", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        result_batch("old", "x", "done"),
        vec![result_text_item("old-item", "old")],
    )
    .expect("old run");
    db.delete_nodes(vec!["x".to_owned()])
        .expect("delete the node");
    db.insert_nodes(vec![node("x", "X", "", &[], 0.0, 0.0)])
        .expect("recreate the same id");
    db.save_run(
        result_batch("new", "x", "done"),
        vec![result_text_item("new-item", "new")],
    )
    .expect("new run");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 1.0);
    assert!(
        !batch_exists(&db, "old"),
        "the dead incarnation's batch is not the newest of a live node"
    );
    assert!(batch_exists(&db, "new"));
}

#[test]
fn gc_never_collects_a_running_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(result_batch("run-1", "a", "running"))
        .expect("first running batch");
    db.begin_run(result_batch("run-2", "a", "running"))
        .expect("second running batch");
    db.clear_history().expect("clear history");

    // run-1 is neither the output nor the newest batch; only its running
    // status keeps it, and the delete trigger would abort the collection.
    let report = db.gc().expect("running batches are not collectable");
    assert_eq!(report.batches, 0.0);
    assert!(batch_exists(&db, "run-1"));
    assert!(batch_exists(&db, "run-2"));
}

#[test]
fn gc_collects_unreferenced_assets_and_orphan_files() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("kept", "Kept", "", &[], 0.0, 0.0),
        node("gone", "Gone", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    let kept_asset = test_asset(&db, "kept-asset");
    let input_asset = test_asset(&db, "input-asset");
    let dead_asset = test_asset(&db, "dead-asset");
    let orphan_asset = test_asset(&db, "orphan-asset");
    // A text item has a NULL asset_id; the asset NOT IN subqueries must
    // filter those out or every asset becomes "possibly referenced".
    let mut kept_text = result_text_item("kept-text", "note");
    kept_text.port_id = "text".to_owned();
    db.save_run(
        result_batch("kept-batch", "kept", "done"),
        vec![result_image_item("kept-item", &kept_asset), kept_text],
    )
    .expect("kept run");
    db.insert_nodes(vec![node("src", "Src", "", &[], 0.0, 300.0)])
        .expect("source node");
    db.save_run(
        result_batch("src-batch", "src", "done"),
        vec![result_text_item("src-item", "upstream")],
    )
    .expect("source run");
    db.connect_edge(edge("src-kept", "src", "kept"))
        .expect("text edge input with a NULL asset");
    db.save_run(
        result_batch("dead-batch", "gone", "done"),
        vec![result_image_item("dead-item", &dead_asset)],
    )
    .expect("run of the node that is deleted");
    db.add_input(InputItemInput {
        id: "local-input".to_owned(),
        node_id: "kept".to_owned(),
        port_id: "references".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some(input_asset.clone()),
        text: String::new(),
        meta_json: None,
    })
    .expect("local input");
    db.delete_nodes(vec!["gone".to_owned()])
        .expect("delete the node, leaving its batch");
    let orphan_hash = "ab".repeat(32);
    fs::write(db.assets_dir.join(&orphan_hash), b"orphan file").expect("write the orphan");
    let orphan_temp = format!(".{orphan_hash}.tmp-1234");
    fs::write(db.assets_dir.join(&orphan_temp), b"partial").expect("write the orphan temp");
    let kept_temp = format!(".{}.tmp-5678", asset_hash(&db, &kept_asset));
    fs::write(db.assets_dir.join(&kept_temp), b"partial").expect("write the kept temp");
    fs::write(db.assets_dir.join("notes.txt"), b"keep me").expect("write the unknown file");
    db.clear_history().expect("clear history");

    let report = db.gc().expect("collect");
    assert_eq!(report.batches, 1.0);
    assert_eq!(report.items, 1.0);
    assert_eq!(report.assets, 2.0, "the dead and orphan rows are gone");
    assert_eq!(
        report.files, 4.0,
        "two asset files, the orphan hash and its temp file"
    );
    assert!(db.asset_bytes(kept_asset).is_ok());
    assert!(db.asset_bytes(input_asset).is_ok());
    assert!(db.asset_bytes(dead_asset).is_err());
    assert!(db.asset_bytes(orphan_asset).is_err());
    assert!(db.assets_dir.join("notes.txt").exists());
    assert!(!db.assets_dir.join(&orphan_hash).exists());
    assert!(!db.assets_dir.join(&orphan_temp).exists());
    assert!(
        db.assets_dir.join(&kept_temp).exists(),
        "a temp file whose hash still has a row is not an orphan"
    );
}
