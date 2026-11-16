//! Node settings and port-schema commands.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn a_settings_edit_undoes_and_redoes() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_settings("n".to_owned(), "{\"a\":1}".to_owned(), Some(Vec::new()))
        .expect("settings");

    db.undo().expect("undo settings");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.settings_json, "{}");
    assert_eq!(detail.node.status, "idle");

    db.redo().expect("redo settings");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.settings_json, "{\"a\":1}");
}

#[test]
fn removing_an_output_port_removes_its_edge_and_undo_restores_both() {
    let db = Database::open(":memory:").expect("open");
    upload_with_edge_to_target(&db);
    assert_eq!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .len(),
        1
    );
    db.clear_history().expect("clear setup history");

    let changes = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"media":[]}"#.to_owned(),
            Some(Vec::new()),
        )
        .expect("remove the output port");
    assert_eq!(
        changes.changes.edges_removed,
        vec!["edge-source".to_owned()]
    );
    assert!(scene_edge_ids(&db).is_empty());
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty()
    );

    db.undo().expect("undo the settings edit");
    let restored = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        restored.node.settings_json,
        r#"{"version":1,"media":["image"]}"#
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

    db.redo().expect("redo the settings edit");
    assert!(scene_edge_ids(&db).is_empty());
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty()
    );
}

#[test]
fn removing_an_input_port_removes_the_incoming_edge_and_undo_restores_it() {
    let db = Database::open(":memory:").expect("open");
    text_target_with_incoming_edge(&db);
    db.clear_history().expect("clear setup history");

    let changes = db
        .set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec!["references".to_owned(), "text".to_owned()]),
        )
        .expect("remove the input port");
    assert_eq!(
        changes.changes.edges_removed,
        vec!["edge-target".to_owned()]
    );
    assert!(scene_edge_ids(&db).is_empty());
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty()
    );

    db.undo().expect("undo the settings edit");
    assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
    let restored = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(restored.node.settings_json, "{}");
    assert_eq!(restored.inputs.len(), 1);
    let input = &restored.inputs[0];
    assert_eq!(input.edge_id.as_deref(), Some("edge-target"));
    assert_eq!(input.item_id.as_deref(), Some("item-source"));
    assert_eq!(input.asset_id, None);
    assert_eq!(input.text, "hello");
    assert_eq!(input.port_id, "prompt");

    db.redo().expect("redo the settings edit");
    assert!(scene_edge_ids(&db).is_empty());
}

#[test]
fn a_settings_change_that_keeps_its_ports_keeps_the_edges() {
    let db = Database::open(":memory:").expect("open");
    text_target_with_incoming_edge(&db);
    db.clear_history().expect("clear setup history");
    let before = current_rev(&db);

    let changes = db
        .set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec![
                "prompt".to_owned(),
                "references".to_owned(),
                "text".to_owned(),
            ]),
        )
        .expect("valid settings change");
    assert_eq!(
        changes.changes.changed[0].settings_json,
        r#"{"version":1,"prompt":"changed"}"#
    );
    assert!(changes.forward.iter().any(|op| matches!(
        op,
        HistoryOp::NodeSettings {
            id,
            mark_stale: true,
            ..
        } if id == "target"
    )));
    assert_eq!(current_rev(&db), before + 1);
    assert!(changes.changes.edges_removed.is_empty());
    assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
    assert_eq!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .len(),
        1
    );

    db.undo().expect("undo the valid change");
    assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
}

#[test]
fn a_no_op_settings_change_keeps_edges_even_with_no_valid_ports() {
    let db = Database::open(":memory:").expect("open");
    text_target_with_incoming_edge(&db);
    db.set_node_settings(
        "target".to_owned(),
        r#"{"version":1,"prompt":"changed"}"#.to_owned(),
        Some(vec![
            "prompt".to_owned(),
            "references".to_owned(),
            "text".to_owned(),
        ]),
    )
    .expect("settings");
    db.clear_history().expect("clear setup history");
    let before = current_rev(&db);

    let no_op = db
        .set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(Vec::new()),
        )
        .expect("no-op settings");
    assert!(no_op.forward.is_empty());
    assert_eq!(no_op.changes.rev, before as f64);
    assert_eq!(current_rev(&db), before);
    assert_eq!(scene_edge_ids(&db), vec!["edge-target".to_owned()]);
}

#[test]
fn a_settings_change_without_a_port_schema_keeps_every_edge() {
    let db = Database::open(":memory:").expect("open");
    upload_with_edge_to_target(&db);
    db.clear_history().expect("clear setup history");
    let before = current_rev(&db);

    // A newer document's kind: this build cannot tell which ports it
    // has, so the settings write must land but must not delete edges.
    let changes = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"media":[]}"#.to_owned(),
            None,
        )
        .expect("settings without a port schema");
    assert_eq!(current_rev(&db), before + 1);
    assert_eq!(
        changes.changes.changed[0].settings_json,
        r#"{"version":1,"media":[]}"#
    );
    assert!(changes.forward.iter().any(|op| matches!(
        op,
        HistoryOp::NodeSettings {
            id,
            mark_stale: true,
            ..
        } if id == "source"
    )));
    let persisted = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(persisted.node.settings_json, r#"{"version":1,"media":[]}"#);
    assert!(changes.changes.edges_removed.is_empty());
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    assert_eq!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .len(),
        1
    );
}

#[test]
fn a_settings_change_removes_every_edge_on_a_gone_port() {
    let db = Database::open(":memory:").expect("open");
    let mut upload = node("source", "Source", "", &[], 0.0, 0.0);
    upload.kind = "upload".to_owned();
    upload.settings_json = Some(r#"{"version":1,"media":["image"]}"#.to_owned());
    db.insert_nodes(vec![
        upload,
        node("target-a", "A", "", &[], 400.0, 0.0),
        node("target-b", "B", "", &[], 800.0, 0.0),
    ])
    .expect("insert");
    test_asset(&db, "asset-cat");
    db.set_manual_upload(
        "source".to_owned(),
        r#"{"version":1,"media":["image"]}"#.to_owned(),
        "cat.png".to_owned(),
        ResultBatchInput {
            id: "batch-first".to_owned(),
            node_id: "source".to_owned(),
            trigger: "upload".to_owned(),
            provider: "local".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-first".to_owned(),
            position: 0.0,
            port_id: "image".to_owned(),
            kind: "image".to_owned(),
            text: String::new(),
            asset_id: Some("asset-cat".to_owned()),
            meta_json: None,
        }],
        None,
    )
    .expect("upload");
    connect_ports(
        &db,
        "edge-a",
        "source",
        "image",
        "target-a",
        "references",
        "image",
    );
    connect_ports(
        &db,
        "edge-b",
        "source",
        "image",
        "target-b",
        "references",
        "image",
    );
    db.clear_history().expect("clear setup history");

    let changes = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"media":[]}"#.to_owned(),
            Some(Vec::new()),
        )
        .expect("remove the output port");
    assert_eq!(
        changes.changes.edges_removed,
        vec!["edge-a".to_owned(), "edge-b".to_owned()]
    );
    assert!(scene_edge_ids(&db).is_empty());
    for target in ["target-a", "target-b"] {
        assert!(
            db.node_detail(target.to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );
    }

    db.undo().expect("undo the settings edit");
    assert_eq!(
        scene_edge_ids(&db),
        vec!["edge-a".to_owned(), "edge-b".to_owned()]
    );
    for target in ["target-a", "target-b"] {
        let restored = db
            .node_detail(target.to_owned())
            .expect("detail")
            .expect("target detail");
        assert_eq!(restored.inputs.len(), 1);
        assert_eq!(restored.inputs[0].item_id.as_deref(), Some("item-first"));
        assert_eq!(restored.inputs[0].asset_id.as_deref(), Some("asset-cat"));
    }

    db.redo().expect("redo the settings edit");
    assert!(scene_edge_ids(&db).is_empty());
    for target in ["target-a", "target-b"] {
        assert!(
            db.node_detail(target.to_owned())
                .expect("detail")
                .expect("target detail")
                .inputs
                .is_empty()
        );
    }
}

#[test]
fn successive_settings_changes_undo_and_redo_in_order() {
    let db = Database::open(":memory:").expect("open");
    let mut source = node("source", "Source", "", &[], 0.0, 0.0);
    source.kind = "future".to_owned();
    source.settings_json = Some(r#"{"version":1,"ports":["image","video"]}"#.to_owned());
    db.insert_nodes(vec![
        source,
        node("target-a", "A", "", &[], 400.0, 0.0),
        node("target-b", "B", "", &[], 800.0, 0.0),
    ])
    .expect("insert");
    test_asset(&db, "asset-image");
    test_asset(&db, "asset-video");
    db.save_run(
        ResultBatchInput {
            id: "batch-source".to_owned(),
            node_id: "source".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-image".to_owned(),
            model: "mock-image".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![
            ResultItemInput {
                id: "item-image".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-image".to_owned()),
                meta_json: None,
            },
            ResultItemInput {
                id: "item-video".to_owned(),
                position: 1.0,
                port_id: "video".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-video".to_owned()),
                meta_json: None,
            },
        ],
    )
    .expect("run");
    connect_ports(
        &db,
        "edge-image",
        "source",
        "image",
        "target-a",
        "references",
        "image",
    );
    connect_ports(
        &db,
        "edge-video",
        "source",
        "video",
        "target-b",
        "references",
        "image",
    );
    db.clear_history().expect("clear setup history");

    let first = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"ports":["image"]}"#.to_owned(),
            Some(vec!["image".to_owned()]),
        )
        .expect("first settings edit");
    assert_eq!(first.changes.edges_removed, vec!["edge-video".to_owned()]);
    assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);

    let second = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"ports":[]}"#.to_owned(),
            Some(Vec::new()),
        )
        .expect("second settings edit");
    assert_eq!(second.changes.edges_removed, vec!["edge-image".to_owned()]);
    assert!(scene_edge_ids(&db).is_empty());

    db.undo().expect("undo the second edit");
    let after_first_undo = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        after_first_undo.node.settings_json,
        r#"{"version":1,"ports":["image"]}"#
    );
    assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);

    db.undo().expect("undo the first edit");
    let after_second_undo = db
        .node_detail("source".to_owned())
        .expect("detail")
        .expect("source detail");
    assert_eq!(
        after_second_undo.node.settings_json,
        r#"{"version":1,"ports":["image","video"]}"#
    );
    assert_eq!(
        scene_edge_ids(&db),
        vec!["edge-image".to_owned(), "edge-video".to_owned()]
    );
    let target_b = db
        .node_detail("target-b".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(target_b.inputs[0].item_id.as_deref(), Some("item-video"));

    db.redo().expect("redo the first edit");
    assert_eq!(scene_edge_ids(&db), vec!["edge-image".to_owned()]);
    db.redo().expect("redo the second edit");
    assert!(scene_edge_ids(&db).is_empty());
}
