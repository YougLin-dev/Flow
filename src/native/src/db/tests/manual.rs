//! Manual text and upload commands; stale-entry guards live in history.rs.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn a_manual_text_edit_is_one_undoable_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("text", "Text", "Before", &[], 0.0, 0.0)])
        .expect("insert");
    let changes = db
        .set_manual_text(
            "text".to_owned(),
            "After".to_owned(),
            ResultBatchInput {
                id: "batch-manual".to_owned(),
                node_id: "text".to_owned(),
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
                text: "After".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        )
        .expect("manual edit");
    assert_eq!(changes.changes.changed[0].body, "After");
    let detail = db
        .node_detail("text".to_owned())
        .expect("detail")
        .expect("text detail");
    assert_eq!(
        detail.batch.as_ref().map(|batch| batch.id.as_str()),
        Some("batch-manual")
    );
    assert_eq!(
        detail.batch.as_ref().map(|batch| batch.items.len()),
        Some(1)
    );

    db.undo().expect("undo manual edit");
    let restored = db
        .node_detail("text".to_owned())
        .expect("detail")
        .expect("text detail");
    assert_eq!(restored.node.body, "Before");
    assert_eq!(restored.node.output_batch_id, None);
    // The batch itself is immutable and stays for any downstream snapshot.
    assert_eq!(
        db.node_detail("text".to_owned())
            .expect("detail")
            .expect("detail")
            .batch
            .map(|batch| batch.id),
        None
    );
}

#[test]
fn an_upload_writes_its_ports_and_output_in_one_undoable_step() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
    db.insert_nodes(vec![upload]).expect("insert");
    test_asset(&db, "asset-cat");

    let changes = db
        .set_manual_upload(
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
                meta_json: Some(r#"{"width":2,"height":1}"#.to_owned()),
            }],
            Some(NodeBounds {
                id: "upload".to_owned(),
                x: -10.0,
                y: 30.0,
                width: 320.0,
                height: 160.0,
            }),
        )
        .expect("upload");
    let changed = &changes.changes.changed[0];
    assert_eq!(changed.settings_json, r#"{"version":1,"media":["image"]}"#);
    assert_eq!(changed.body, "cat.png");
    assert_eq!(changed.status, "done");
    assert_eq!((changed.width, changed.height), (320.0, 160.0));

    let detail = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    let batch = detail.batch.expect("batch");
    assert_eq!(batch.id, "batch-upload");
    assert_eq!(batch.items[0].port_id, "image");
    assert_eq!(batch.items[0].asset_id.as_deref(), Some("asset-cat"));
    assert_eq!(
        db.search("cat".to_owned(), SearchFilters::default(), 20)
            .expect("search")
            .len(),
        1
    );

    db.undo().expect("undo upload");
    let restored = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    assert_eq!(restored.node.settings_json, r#"{"version":1,"media":[]}"#);
    assert_eq!(restored.node.body, "");
    assert_eq!(restored.node.output_batch_id, None);
    // The same undo also restores the rectangle the upload fitted.
    assert_eq!(
        (
            restored.node.x,
            restored.node.y,
            restored.node.width,
            restored.node.height
        ),
        (0.0, 0.0, 200.0, 84.0)
    );

    db.redo().expect("redo upload");
    let again = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    assert_eq!(
        again.node.settings_json,
        r#"{"version":1,"media":["image"]}"#
    );
    assert_eq!(again.node.output_batch_id.as_deref(), Some("batch-upload"));
}

#[test]
fn an_intervening_settings_edit_does_not_block_an_upload_undo() {
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
    db.set_node_settings(
        "upload".to_owned(),
        r#"{"version":1,"media":["image"],"edited":true}"#.to_owned(),
        Some(vec!["image".to_owned()]),
    )
    .expect("settings");
    // Undoing the settings edit restores settings but leaves the stale
    // marker; the upload's batch and body are unchanged, so its undo must
    // still apply as one whole entry.
    db.undo().expect("undo settings");
    db.undo().expect("undo upload");

    let detail = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    assert_eq!(detail.node.settings_json, "{}");
    assert_eq!(detail.node.body, "");
    assert_eq!(detail.node.output_batch_id, None);
    assert_eq!(detail.node.status, "idle");
    assert_eq!(
        (
            detail.node.x,
            detail.node.y,
            detail.node.width,
            detail.node.height
        ),
        (0.0, 0.0, 200.0, 84.0)
    );
}

#[test]
fn a_second_upload_replaces_and_undoes_the_first_output() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
    db.insert_nodes(vec![upload]).expect("insert");
    test_asset(&db, "asset-cat");
    test_asset(&db, "asset-dog");

    let upload = |batch_id: &str,
                  item_id: &str,
                  asset_id: &str,
                  settings: &str,
                  body: &str,
                  x: f64,
                  width: f64| {
        db.set_manual_upload(
            "upload".to_owned(),
            settings.to_owned(),
            body.to_owned(),
            ResultBatchInput {
                id: batch_id.to_owned(),
                node_id: "upload".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: item_id.to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some(asset_id.to_owned()),
                meta_json: None,
            }],
            Some(NodeBounds {
                id: "upload".to_owned(),
                x,
                y: 0.0,
                width,
                height: 160.0,
            }),
        )
        .expect("upload")
    };

    upload(
        "batch-1",
        "item-1",
        "asset-cat",
        r#"{"version":1,"media":["image"]}"#,
        "cat.png",
        0.0,
        320.0,
    );
    upload(
        "batch-2",
        "item-2",
        "asset-dog",
        r#"{"version":1,"media":["image","video"]}"#,
        "dog.png",
        40.0,
        400.0,
    );

    db.undo().expect("undo the second upload");
    let first = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    assert_eq!(
        first.node.settings_json,
        r#"{"version":1,"media":["image"]}"#
    );
    assert_eq!(first.node.body, "cat.png");
    assert_eq!(first.node.output_batch_id.as_deref(), Some("batch-1"));
    assert_eq!(first.node.status, "done");
    assert_eq!((first.node.x, first.node.width), (0.0, 320.0));

    db.redo().expect("redo the second upload");
    let second = db
        .node_detail("upload".to_owned())
        .expect("detail")
        .expect("upload detail");
    assert_eq!(
        second.node.settings_json,
        r#"{"version":1,"media":["image","video"]}"#
    );
    assert_eq!(second.node.body, "dog.png");
    assert_eq!(second.node.output_batch_id.as_deref(), Some("batch-2"));
    assert_eq!(second.node.status, "done");
    assert_eq!((second.node.x, second.node.width), (40.0, 400.0));
}

#[test]
fn copies_an_upload_in_one_undoable_step() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("copy", "Upload", "cat.png", &["upload"], 24.0, 24.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":["image"]}"#.to_owned());
    test_asset(&db, "asset-cat");
    db.insert_upload_node(
        upload,
        ResultBatchInput {
            id: "batch-copy".to_owned(),
            node_id: "copy".to_owned(),
            trigger: "upload".to_owned(),
            provider: "local".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-copy".to_owned(),
            position: 0.0,
            port_id: "image".to_owned(),
            kind: "image".to_owned(),
            text: String::new(),
            asset_id: Some("asset-cat".to_owned()),
            meta_json: Some(r#"{"width":2,"height":1}"#.to_owned()),
        }],
    )
    .expect("copy");

    let copy = db
        .node_detail("copy".to_owned())
        .expect("detail")
        .expect("copy detail");
    assert_eq!(copy.node.status, "done");
    assert_eq!(copy.node.output_batch_id.as_deref(), Some("batch-copy"));
    assert_eq!(copy.batch.expect("batch").items.len(), 1);

    // One undo removes the whole copy, output included.
    db.undo().expect("undo copy");
    assert_eq!(db.get_node("copy".to_owned()).expect("get"), None);

    // Redo puts the card back with its output, not empty.
    db.redo().expect("redo copy");
    let again = db
        .node_detail("copy".to_owned())
        .expect("detail")
        .expect("copy detail");
    assert_eq!(again.node.output_batch_id.as_deref(), Some("batch-copy"));
    assert_eq!(again.batch.expect("batch").items.len(), 1);
}

#[test]
fn undoing_an_upload_restores_its_edge_anchors() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("upload", "Upload", "", &["upload"], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":[]}"#.to_owned());
    db.insert_nodes(vec![upload, node("target", "Target", "", &[], 400.0, 0.0)])
        .expect("insert");
    test_asset(&db, "asset-cat");
    db.connect_edge(EdgeInput {
        id: "edge-upload".to_owned(),
        from_id: "upload".to_owned(),
        to_id: "target".to_owned(),
        from_port: "image".to_owned(),
        to_port: "references".to_owned(),
        port_kind: "image".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("edge");

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
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 160.0,
        }),
    )
    .expect("upload");

    // 84 → 160 scales the connector anchor by 160/84.
    let grown = db
        .scene(
            Viewport {
                x: -100.0,
                y: -100.0,
                width: 1000.0,
                height: 1000.0,
            },
            0.0,
            100,
        )
        .expect("scene");
    let edge = grown
        .edges
        .iter()
        .find(|edge| edge.id == "edge-upload")
        .expect("the connector was indexed");
    assert!((edge.from_offset - 80.0).abs() < 0.001);

    db.undo().expect("undo upload");
    let restored = db
        .scene(
            Viewport {
                x: -100.0,
                y: -100.0,
                width: 1000.0,
                height: 1000.0,
            },
            0.0,
            100,
        )
        .expect("scene");
    let edge = restored
        .edges
        .iter()
        .find(|edge| edge.id == "edge-upload")
        .expect("the connector is still indexed");
    assert!((edge.from_offset - 42.0).abs() < 0.001);

    db.redo().expect("redo upload");
    let again = db
        .scene(
            Viewport {
                x: -100.0,
                y: -100.0,
                width: 1000.0,
                height: 1000.0,
            },
            0.0,
            100,
        )
        .expect("scene");
    let edge = again
        .edges
        .iter()
        .find(|edge| edge.id == "edge-upload")
        .expect("the connector is indexed after redo");
    assert!((edge.from_offset - 80.0).abs() < 0.001);
}

#[test]
fn replacing_an_upload_drops_an_edge_whose_output_port_is_gone() {
    let db = Database::open(":memory:").expect("open");
    upload_with_edge_to_target(&db);
    test_asset(&db, "asset-clip");
    db.clear_history().expect("clear setup history");

    let changes = db
        .set_manual_upload(
            "source".to_owned(),
            r#"{"version":1,"media":["video"]}"#.to_owned(),
            "clip.mp4".to_owned(),
            ResultBatchInput {
                id: "batch-second".to_owned(),
                node_id: "source".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-second".to_owned(),
                position: 0.0,
                port_id: "video".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-clip".to_owned()),
                meta_json: None,
            }],
            None,
        )
        .expect("replace the upload");
    assert_eq!(
        changes.changes.edges_removed,
        vec!["edge-source".to_owned()]
    );
    assert!(scene_edge_ids(&db).is_empty());
    let replaced = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        replaced.node.settings_json,
        r#"{"version":1,"media":["video"]}"#
    );
    assert_eq!(
        replaced.node.output_batch_id.as_deref(),
        Some("batch-second")
    );
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty()
    );

    db.undo().expect("undo the replacement");
    let restored = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        restored.node.settings_json,
        r#"{"version":1,"media":["image"]}"#
    );
    assert_eq!(
        restored.node.output_batch_id.as_deref(),
        Some("batch-first")
    );
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(target.inputs.len(), 1);
    let input = &target.inputs[0];
    assert_eq!(input.edge_id.as_deref(), Some("edge-source"));
    assert_eq!(input.item_id.as_deref(), Some("item-first"));
    assert_eq!(input.asset_id.as_deref(), Some("asset-cat"));
    assert_eq!(input.port_id, "references");

    db.redo().expect("redo the replacement");
    assert!(scene_edge_ids(&db).is_empty());
    let redone = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        redone.node.settings_json,
        r#"{"version":1,"media":["video"]}"#
    );
    assert_eq!(redone.node.output_batch_id.as_deref(), Some("batch-second"));
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty()
    );
}

#[test]
fn replacing_an_upload_keeps_an_edge_whose_port_survives() {
    let db = Database::open(":memory:").expect("open");
    upload_with_edge_to_target(&db);
    test_asset(&db, "asset-dog");
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
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "result".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("target run");
    db.clear_history().expect("clear setup history");

    let changes = db
        .set_manual_upload(
            "source".to_owned(),
            r#"{"version":1,"media":["image"]}"#.to_owned(),
            "dog.png".to_owned(),
            ResultBatchInput {
                id: "batch-second".to_owned(),
                node_id: "source".to_owned(),
                trigger: "upload".to_owned(),
                provider: "local".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-second".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-dog".to_owned()),
                meta_json: None,
            }],
            None,
        )
        .expect("replace the upload");
    assert!(changes.changes.edges_removed.is_empty());
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    let touched: Vec<_> = changes
        .changes
        .changed
        .iter()
        .filter(|node| node.id == "target")
        .collect();
    assert_eq!(touched.len(), 1, "the target is refreshed exactly once");
    assert_eq!(touched[0].status, "stale");
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(target.inputs.len(), 1);
    assert_eq!(target.inputs[0].item_id.as_deref(), Some("item-first"));

    db.undo().expect("undo the replacement");
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    db.redo().expect("redo the replacement");
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
}
