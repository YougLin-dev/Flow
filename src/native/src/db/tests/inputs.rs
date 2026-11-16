//! Input add, remove, reorder and sync commands.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn input_restores_tolerate_a_missing_or_existing_row() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    test_asset(&db, "asset-input");
    let row = crate::history::InputRow {
        id: "input-1".to_owned(),
        node_id: "n".to_owned(),
        position: 0,
        port_id: "out".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some("asset-input".to_owned()),
        text: "one".to_owned(),
        meta_json: "{}".to_owned(),
        created_at: 0,
    };

    db.apply_ops(&[HistoryOp::InsertInput(row.clone())])
        .expect("insert the input");
    db.apply_ops(&[HistoryOp::InsertInput(row.clone())])
        .expect("an existing input is tolerated");
    let inputs = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail")
        .inputs;
    assert_eq!(inputs.len(), 1);

    db.apply_ops(&[HistoryOp::DeleteInput {
        id: "missing".to_owned(),
    }])
    .expect("a missing input is tolerated");
    db.apply_ops(&[HistoryOp::DeleteInput { id: row.id }])
        .expect("delete the input");
    assert!(
        db.node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail")
            .inputs
            .is_empty()
    );
}

#[test]
fn sync_rebuilds_edge_inputs_and_keeps_local_items() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("text", "Text", "A lake", &[], 0.0, 0.0),
        node("image", "Image", "", &[], 400.0, 0.0),
    ])
    .expect("insert nodes");
    db.save_run(
        ResultBatchInput {
            id: "batch-old".to_owned(),
            node_id: "text".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-old".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "Old".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("old batch");
    db.connect_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "text".to_owned(),
        to_id: "image".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");
    test_asset(&db, "asset-local");
    db.add_input(InputItemInput {
        id: "local".to_owned(),
        node_id: "image".to_owned(),
        port_id: "in".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some("asset-local".to_owned()),
        text: "Local".to_owned(),
        meta_json: None,
    })
    .expect("local input");

    db.save_run(
        ResultBatchInput {
            id: "batch-new".to_owned(),
            node_id: "text".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-new".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "New".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("new batch");

    let inputs = db.sync_inputs("image".to_owned()).expect("sync");
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs[0].text, "Local");
    assert_eq!(inputs[1].item_id.as_deref(), Some("item-new"));
}

#[test]
fn a_downstream_sync_keeps_an_upstream_move_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
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
            text: "A lake".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("source batch");
    connect(&db, "source-target", "source", "target");

    db.move_nodes(vec!["source".to_owned()], 10.0, 0.0)
        .expect("move source");
    db.sync_inputs("target".to_owned()).expect("sync target");

    let undone = db.undo().expect("undo the source move");
    assert_eq!(undone.changed.len(), 1);
    let source = db
        .get_node("source".to_owned())
        .expect("get source")
        .expect("source");
    assert_eq!(source.x, 0.0, "the upstream move survives a target sync");
}

#[test]
fn add_input_appends_to_its_port_without_a_caller_position() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    for (id, port, text) in [
        ("a", "references", "A"),
        ("b", "references", "B"),
        ("c", "prompt", "C"),
    ] {
        test_asset(&db, &format!("asset-{id}"));
        db.add_input(InputItemInput {
            id: id.to_owned(),
            node_id: "n".to_owned(),
            port_id: port.to_owned(),
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

    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    let references = port_inputs(&detail, "references");
    assert_eq!(
        references
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("a", 0.0), ("b", 1.0)]
    );
    let prompt = port_inputs(&detail, "prompt");
    assert_eq!(
        prompt
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("c", 0.0)]
    );
}

#[test]
fn reordering_inputs_renumbers_per_port_and_undoes() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    for (id, port, text) in [
        ("a", "references", "A"),
        ("b", "references", "B"),
        ("c", "prompt", "C"),
    ] {
        test_asset(&db, &format!("asset-{id}"));
        db.add_input(InputItemInput {
            id: id.to_owned(),
            node_id: "n".to_owned(),
            port_id: port.to_owned(),
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

    db.reorder_inputs(
        "n".to_owned(),
        vec!["b".to_owned(), "a".to_owned(), "c".to_owned()],
    )
    .expect("reorder");
    let reordered = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    let references = port_inputs(&reordered, "references");
    assert_eq!(
        references
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("b", 0.0), ("a", 1.0)]
    );
    let prompt = port_inputs(&reordered, "prompt");
    assert_eq!(
        prompt
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("c", 0.0)]
    );

    db.undo().expect("undo reorder");
    let restored = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&restored, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("a", 0.0), ("b", 1.0)]
    );

    db.redo().expect("redo reorder");
    let redone = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&redone, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("b", 0.0), ("a", 1.0)]
    );
}

#[test]
fn sync_inputs_renumbers_each_port_under_unique_positions() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![
        node("source", "Source", "", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    test_asset(&db, "asset-one");
    test_asset(&db, "asset-two");
    test_asset(&db, "asset-a");
    test_asset(&db, "asset-b");
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
                id: "item-one".to_owned(),
                position: 0.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-one".to_owned()),
                meta_json: None,
            },
            ResultItemInput {
                id: "item-two".to_owned(),
                position: 1.0,
                port_id: "image".to_owned(),
                kind: "image".to_owned(),
                text: String::new(),
                asset_id: Some("asset-two".to_owned()),
                meta_json: None,
            },
        ],
    )
    .expect("source run");
    for (id, asset) in [("local-a", "asset-a"), ("local-b", "asset-b")] {
        db.add_input(InputItemInput {
            id: id.to_owned(),
            node_id: "target".to_owned(),
            port_id: "references".to_owned(),
            kind: "image".to_owned(),
            origin: "local".to_owned(),
            edge_id: None,
            item_id: None,
            asset_id: Some(asset.to_owned()),
            text: String::new(),
            meta_json: None,
        })
        .expect("local input");
    }
    connect_ports(
        &db,
        "edge-source",
        "source",
        "image",
        "target",
        "references",
        "image",
    );

    db.sync_inputs("target".to_owned()).expect("sync");
    let detail = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    let references = port_inputs(&detail, "references");
    let ids: Vec<&str> = references.iter().map(|input| input.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "local-a",
            "local-b",
            "input-edge-source-item-one",
            "input-edge-source-item-two"
        ]
    );
    let positions: Vec<f64> = references.iter().map(|input| input.position).collect();
    assert_eq!(positions, vec![0.0, 1.0, 2.0, 3.0]);
}

#[test]
fn restoring_a_removed_snapshot_shifts_an_occupied_position() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![
        node("source", "Source", "", &[], 0.0, 0.0),
        node("source-2", "Source 2", "", &[], 200.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-old".to_owned(),
            node_id: "source".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-old".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "old".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("old run");
    connect_ports(
        &db, "edge-old", "source", "text", "target", "prompt", "text",
    );
    db.clear_history().expect("clear setup history");
    db.set_node_settings(
        "target".to_owned(),
        r#"{"version":1,"prompt":"changed"}"#.to_owned(),
        Some(vec!["references".to_owned(), "text".to_owned()]),
    )
    .expect("remove the prompt port");
    assert!(scene_edge_ids(&db).is_empty());

    db.save_run(
        ResultBatchInput {
            id: "batch-new".to_owned(),
            node_id: "source-2".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-new".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "new".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("new run");
    connect_ports(
        &db, "edge-new", "source-2", "text", "target", "prompt", "text",
    );
    // The run invalidates the connect entry (it references source-2) but
    // not the settings entry, whose restored edge references source and
    // target.
    db.save_run(
        ResultBatchInput {
            id: "batch-later".to_owned(),
            node_id: "source-2".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-later".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "later".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("later run");

    db.undo().expect("undo the settings edit");
    let mut edges = scene_edge_ids(&db);
    edges.sort();
    assert_eq!(edges, vec!["edge-new".to_owned(), "edge-old".to_owned()]);
    let detail = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(detail.node.settings_json, "{}");
    let prompt = port_inputs(&detail, "prompt");
    assert_eq!(
        prompt
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![
            ("input-edge-old-item-old", 0.0),
            ("input-edge-new-item-new", 1.0)
        ]
    );
}

#[test]
fn undoing_a_reorder_then_a_remove_restores_stored_positions() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    for (id, text) in [("a", "A"), ("b", "B"), ("c", "C")] {
        test_asset(&db, &format!("asset-{id}"));
        db.add_input(InputItemInput {
            id: id.to_owned(),
            node_id: "n".to_owned(),
            port_id: "references".to_owned(),
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
    db.remove_input("b".to_owned()).expect("remove b");
    db.reorder_inputs("n".to_owned(), vec!["c".to_owned(), "a".to_owned()])
        .expect("reorder");

    db.undo().expect("undo reorder");
    db.undo().expect("undo remove");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&detail, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("a", 0.0), ("b", 1.0), ("c", 2.0)]
    );

    db.redo().expect("redo remove");
    db.redo().expect("redo reorder");
    let redone = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&redone, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("c", 0.0), ("a", 1.0)]
    );
}

#[test]
fn undoing_a_sparse_reorder_clears_the_target_range() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    for (id, text) in [("a", "A"), ("b", "B"), ("c", "C"), ("d", "D"), ("e", "E")] {
        add_local_input(&db, "n", id, "references", text);
    }
    db.remove_input("b".to_owned()).expect("remove b");
    db.remove_input("d".to_owned()).expect("remove d");
    db.reorder_inputs(
        "n".to_owned(),
        vec!["e".to_owned(), "a".to_owned(), "c".to_owned()],
    )
    .expect("reorder");

    // Undo restores the sparse positions 0, 2 and 4. The lift must clear
    // the highest target as well as the current range, or assigning e=4
    // hits a at 4 before a is moved.
    db.undo().expect("undo the sparse reorder");
    let restored = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&restored, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("a", 0.0), ("c", 2.0), ("e", 4.0)]
    );

    db.redo().expect("redo the sparse reorder");
    let redone = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&redone, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("e", 0.0), ("a", 1.0), ("c", 2.0)]
    );
}

#[test]
fn restoring_a_deleted_node_keeps_the_captured_input_order() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    // Input ids sort differently from their positions, so an id-ordered
    // restore would permute the port.
    add_local_input(&db, "n", "local-b", "references", "B");
    add_local_input(&db, "n", "local-a", "references", "A");
    add_local_input(&db, "n", "local-c", "references", "C");
    db.delete_nodes(vec!["n".to_owned()]).expect("delete node");

    db.undo().expect("undo the node delete");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&detail, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("local-b", 0.0), ("local-a", 1.0), ("local-c", 2.0)]
    );
}

#[test]
fn restoring_an_input_does_not_move_an_earlier_upload() {
    let db = Database::open(":memory:").expect("open");
    enforce_unique_input_positions(&db);
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    add_local_input(&db, "n", "cat", "references", "cat");
    add_local_input(&db, "n", "dog", "references", "dog");
    db.remove_input("cat".to_owned()).expect("remove cat");
    add_local_input(&db, "n", "fox", "references", "fox");

    db.undo().expect("undo the fox upload");
    db.undo().expect("undo the cat removal");
    let restored = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&restored, "references")
            .iter()
            .map(|input| (input.id.as_str(), input.position))
            .collect::<Vec<_>>(),
        vec![("cat", 0.0), ("dog", 1.0)]
    );

    db.redo().expect("redo the cat removal");
    db.redo().expect("redo the fox upload");
    let redone = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(
        port_inputs(&redone, "references")
            .iter()
            .map(|input| input.id.as_str())
            .collect::<Vec<_>>(),
        vec!["dog", "fox"]
    );
}

#[test]
fn reordering_inputs_is_undoable() {
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
    let before = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node")
        .inputs;
    assert!(before.iter().any(|input| input.id == "one"));
    db.reorder_inputs("n".to_owned(), vec!["two".to_owned(), "one".to_owned()])
        .expect("reorder");
    let after = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node")
        .inputs;
    assert_eq!(after[0].id, "two");
    assert_eq!(after[1].id, "one");

    db.undo().expect("undo reorder");
    let restored = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node")
        .inputs;
    let restored_ids: Vec<&str> = restored.iter().map(|input| input.id.as_str()).collect();
    let before_ids: Vec<&str> = before.iter().map(|input| input.id.as_str()).collect();
    assert_eq!(restored_ids, before_ids);
}
