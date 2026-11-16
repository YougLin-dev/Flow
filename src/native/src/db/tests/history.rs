//! Undo/redo invalidation, stale entries and no-op rules.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows the production `crate::history`;
//! tests that need it spell the full path.

use super::*;

#[test]
fn a_no_op_move_settings_and_reorder_do_not_touch_history_or_the_rev() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    for (id, text) in [("one", "One"), ("two", "Two")] {
        test_asset(&db, &format!("asset-{id}"));
        db.add_input(InputItemInput {
            id: id.to_owned(),
            node_id: "n".to_owned(),
            port_id: "out".to_owned(),
            kind: "image".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: Some(format!("asset-{id}")),
            text: text.to_owned(),
            meta_json: None,
        })
        .expect("add input");
    }
    db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
        .expect("settings");
    let setup_ids: Vec<String> = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail")
        .inputs
        .iter()
        .map(|input| input.id.clone())
        .collect();
    db.reorder_inputs("n".to_owned(), setup_ids)
        .expect("normalise input positions");
    db.clear_history().expect("clear setup history");
    let before = current_rev(&db);

    let moved = db
        .move_nodes(vec!["n".to_owned()], 0.0, 0.0)
        .expect("no-op move");
    assert!(moved.forward.is_empty());
    assert!(moved.changes.changed.is_empty());
    assert_eq!(moved.changes.rev, before as f64);
    assert_eq!(current_rev(&db), before);
    assert!(db.undo().expect("undo no-op move").changed.is_empty());
    assert_eq!(current_rev(&db), before);

    let current = db
        .get_node("n".to_owned())
        .expect("get node")
        .expect("node");
    let bounds = db
        .set_node_bounds(vec![NodeBounds {
            id: "n".to_owned(),
            x: current.x,
            y: current.y,
            width: current.width,
            height: current.height,
        }])
        .expect("no-op bounds");
    assert!(bounds.forward.is_empty());
    assert_eq!(bounds.changes.rev, before as f64);
    assert_eq!(current_rev(&db), before);

    let settings = db
        .set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
        .expect("no-op settings");
    assert!(settings.forward.is_empty());
    assert_eq!(settings.changes.rev, before as f64);
    assert_eq!(current_rev(&db), before);

    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    let ids: Vec<String> = detail.inputs.iter().map(|input| input.id.clone()).collect();
    let reordered = db
        .reorder_inputs("n".to_owned(), ids)
        .expect("no-op reorder");
    assert!(reordered.forward.is_empty());
    assert_eq!(reordered.changes.rev, before as f64);
    assert_eq!(current_rev(&db), before);

    for mutation in [
        db.set_node_text("n".to_owned(), "N".to_owned(), Vec::new())
            .expect("no-op text"),
        db.insert_nodes(Vec::new()).expect("no-op insert nodes"),
        db.insert_edges(Vec::new()).expect("no-op insert edges"),
        db.connect_edges(Vec::new()).expect("no-op connect edges"),
        db.delete_nodes(Vec::new()).expect("no-op delete nodes"),
        db.delete_edges(Vec::new()).expect("no-op delete edges"),
    ] {
        assert!(mutation.forward.is_empty());
        assert_eq!(mutation.changes.rev, before as f64);
        assert_eq!(current_rev(&db), before);
    }

    assert!(db.undo().expect("nothing left to undo").changed.is_empty());
    assert_eq!(current_rev(&db), before);
}

#[test]
fn a_batch_change_skips_a_manual_text_entry() {
    let db = manual_text_db();
    // A writer that bypasses history replaces the output pointer. The
    // guarded entry must be dropped, not restore the manual snapshot.
    direct_write(
        &db,
        "UPDATE nodes SET output_batch_id = NULL, status = 'idle' WHERE id = 'n'",
    );
    let before = current_rev(&db);

    let undone = db.undo().expect("undo the stale entry");
    assert!(undone.changed.is_empty());
    assert_eq!(undone.rev, before as f64);
    assert_eq!(current_rev(&db), before);
    assert!(
        db.history.lock().expect("history").take_redo().is_none(),
        "a stale entry is dropped, not left on the redo stack"
    );
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "after");
    assert_eq!(detail.node.output_batch_id, None);
}

#[test]
fn a_body_change_skips_a_manual_text_entry() {
    let db = manual_text_db();
    direct_write(&db, "UPDATE nodes SET body = 'other' WHERE id = 'n'");
    let before = current_rev(&db);

    let undone = db.undo().expect("undo the stale entry");
    assert!(undone.changed.is_empty());
    assert_eq!(undone.rev, before as f64);
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "other");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-manual"));
}

#[test]
fn a_status_only_change_does_not_skip_a_manual_text_entry() {
    let db = manual_text_db();
    // Undoable input/settings edits mark a node stale without replacing
    // its output; that alone must not block an older output undo.
    direct_write(&db, "UPDATE nodes SET status = 'stale' WHERE id = 'n'");

    let undone = db.undo().expect("undo the manual entry");
    assert_eq!(undone.changed.len(), 1);
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "before");
    assert_eq!(detail.node.output_batch_id, None);
    assert_eq!(detail.node.status, "idle");
}

#[test]
fn a_missing_subject_drops_a_stale_entry_instead_of_wedging_undo() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert n");
    db.insert_nodes(vec![node("x", "X", "", &[], 400.0, 0.0)])
        .expect("insert x");
    connect(&db, "n-x", "n", "x");
    db.delete_nodes(vec!["n".to_owned()]).expect("delete n");
    db.save_run(
        ResultBatchInput {
            id: "batch-x".to_owned(),
            node_id: "x".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-x".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "x".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run x");

    // The run invalidated the delete and connect entries; only the older
    // insert-n entry remains, and its subject is gone. It must be dropped
    // instead of failing and blocking every later undo.
    let undone = db.undo().expect("undo the stale insert");
    assert!(undone.changed.is_empty());
    assert_eq!(db.count().expect("count"), 1);
    let again = db.undo().expect("undo after the drop");
    assert!(again.changed.is_empty());
    assert_eq!(db.count().expect("count after the second undo"), 1);
}

#[test]
fn undoing_a_source_output_marks_downstream_stale() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-source".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-source".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "source output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("source batch");
    connect(&db, "source-target", "source", "target");
    db.save_run(
        ResultBatchInput {
            id: "batch-target".to_owned(),
            node_id: "target".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-target".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "target output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("target batch");
    db.set_manual_text(
        "source".to_owned(),
        "manual source".to_owned(),
        ResultBatchInput {
            id: "batch-manual".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        ResultItemInput {
            id: "item-manual".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "manual source".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual source");
    // Rerun the target after the manual edit so it is done again; the
    // manual entry is on the source, so the target run leaves it pending.
    db.save_run(
        ResultBatchInput {
            id: "batch-target-two".to_owned(),
            node_id: "target".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-target-two".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "target again".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("target rerun");

    let undone = db.undo().expect("undo the manual source output");
    assert!(
        undone
            .changed
            .iter()
            .any(|row| row.id == "target" && row.status == "stale"),
        "the change set carries the downstream stale row"
    );
    let source = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(source.node.output_batch_id.as_deref(), Some("batch-source"));
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(
        target.node.status, "stale",
        "reverting the source output invalidates the target snapshot"
    );
    assert_eq!(
        target.node.output_batch_id.as_deref(),
        Some("batch-target-two")
    );
}

#[test]
fn a_redo_of_settings_marks_an_existing_output_stale() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "before", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_manual_text(
        "n".to_owned(),
        "manual".to_owned(),
        ResultBatchInput {
            id: "batch-manual".to_owned(),
            node_id: "n".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        ResultItemInput {
            id: "item-manual".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "manual".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual edit");
    db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
        .expect("settings");

    db.undo().expect("undo settings");
    db.undo().expect("undo manual output");
    db.redo().expect("redo manual output");
    db.redo().expect("redo settings");

    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.settings_json, "{\"a\":1}");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-manual"));
    assert_eq!(
        detail.node.status, "stale",
        "a redone settings change invalidates an existing output"
    );
}

#[test]
fn a_redo_after_a_body_change_is_skipped() {
    let db = manual_text_db();
    db.undo().expect("undo the manual entry");
    direct_write(&db, "UPDATE nodes SET body = 'other' WHERE id = 'n'");
    let before = current_rev(&db);

    let redone = db.redo().expect("redo the stale entry");
    assert!(redone.changed.is_empty());
    assert_eq!(redone.rev, before as f64);
    assert_eq!(current_rev(&db), before);
    let top = db
        .history
        .lock()
        .expect("history")
        .take_undo()
        .expect("the insert entry remains");
    assert!(
        matches!(top.forward.as_slice(), [HistoryOp::Insert(_)]),
        "a stale redo entry is dropped, not returned to undo"
    );
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "other");
    assert_eq!(detail.node.output_batch_id, None);
}

#[test]
fn a_stale_upload_entry_applies_nothing() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some("{}".to_owned());
    db.insert_nodes(vec![upload]).expect("insert");
    test_asset(&db, "asset-cat");
    db.set_manual_upload(
        "upload".to_owned(),
        r#"{"version":1,"media":["image"]}"#.to_owned(),
        "cat.png".to_owned(),
        ResultBatchInput {
            id: "batch-upload".to_owned(),
            node_id: "upload".to_owned(),
            trigger: "upload".to_owned(),
            provider: "local".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-upload".to_owned(),
            position: 0.0,
            port_id: "image".to_owned(),
            kind: "image".to_owned(),
            text: String::new(),
            asset_id: Some("asset-cat".to_owned()),
            meta_json: None,
        }],
        Some(NodeBounds {
            id: "upload".to_owned(),
            x: 40.0,
            y: 10.0,
            width: 320.0,
            height: 160.0,
        }),
    )
    .expect("upload");
    direct_write(
        &db,
        "UPDATE nodes SET output_batch_id = NULL, status = 'idle' WHERE id = 'upload'",
    );
    let before = current_rev(&db);

    let undone = db.undo().expect("undo the stale upload");
    assert!(undone.changed.is_empty());
    assert_eq!(undone.rev, before as f64);
    assert_eq!(current_rev(&db), before);
    assert!(db.history.lock().expect("history").take_redo().is_none());
    let detail = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    // No settings or geometry half-apply: the whole entry was skipped.
    assert_eq!(
        detail.node.settings_json,
        r#"{"version":1,"media":["image"]}"#
    );
    assert_eq!(
        (
            detail.node.x,
            detail.node.y,
            detail.node.width,
            detail.node.height
        ),
        (40.0, 10.0, 320.0, 160.0)
    );
    assert_eq!(detail.node.body, "cat.png");
}
