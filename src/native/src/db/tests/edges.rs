//! Edge insert, connect, reconnect and delete commands.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn rejects_self_and_duplicate_connections() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "Source", "", &["text"], 0.0, 0.0),
        node("b", "Target", "", &["image"], 300.0, 0.0),
    ])
    .expect("insert nodes");
    let edge = |id: &str, from: &str, to: &str| EdgeInput {
        id: id.to_owned(),
        from_id: from.to_owned(),
        to_id: to.to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    };

    db.connect_edge(edge("a-b", "a", "b")).expect("connect");
    let duplicate = match db.connect_edge(edge("a-b-again", "a", "b")) {
        Ok(_) => panic!("a duplicate edge was accepted"),
        Err(error) => error,
    };
    assert!(duplicate.contains("already connected"), "{duplicate}");
    let own = match db.connect_edge(edge("a-a", "a", "a")) {
        Ok(_) => panic!("a self edge was accepted"),
        Err(error) => error,
    };
    assert!(own.contains("cannot connect to itself"), "{own}");
    assert_eq!(db.edge_count().expect("edge count"), 1);
}

#[test]
fn connects_several_sources_in_one_history_step() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 0.0, 200.0),
        node("c", "C", "", &[], 400.0, 100.0),
    ])
    .expect("insert nodes");

    // One output item per source exercises the snapshot path for each.
    for (source, item) in [("a", "item-a"), ("b", "item-b")] {
        db.save_run(
            ResultBatchInput {
                id: format!("batch-{source}"),
                node_id: source.to_owned(),
                trigger: "manual".to_owned(),
                provider: "manual".to_owned(),
                model: String::new(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: item.to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: item.to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save run");
    }

    let edge = |id: &str, from: &str| EdgeInput {
        id: id.to_owned(),
        from_id: from.to_owned(),
        to_id: "c".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    };
    let mutation = db
        .connect_edges(vec![edge("a-c", "a"), edge("b-c", "b")])
        .expect("connect many");
    assert_eq!(mutation.changes.edges_changed.len(), 2);
    // Both edges touch one target: its summary appears once.
    assert_eq!(mutation.changes.changed.len(), 1);
    assert_eq!(db.edge_count().expect("edges"), 2);
    assert_eq!(
        db.node_detail("c".to_owned())
            .expect("detail")
            .expect("c detail")
            .inputs
            .len(),
        2
    );

    // One undo removes both edges and their snapshotted inputs.
    let undone = db.undo().expect("undo");
    assert_eq!(undone.edges_removed.len(), 2);
    assert_eq!(db.edge_count().expect("edges after undo"), 0);
    assert_eq!(
        db.node_detail("c".to_owned())
            .expect("detail")
            .expect("c detail")
            .inputs
            .len(),
        0
    );

    // One redo restores both edges.
    let redone = db.redo().expect("redo");
    assert_eq!(redone.edges_changed.len(), 2);
    assert_eq!(db.edge_count().expect("edges after redo"), 2);
}

#[test]
fn deleting_a_connected_edge_removes_and_restores_its_snapshot() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-a".to_owned(),
            node_id: "a".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-a".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "hello".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("save run");
    connect(&db, "e1", "a", "t");
    assert_eq!(
        db.node_detail("t".to_owned())
            .expect("detail")
            .expect("t detail")
            .inputs
            .len(),
        1,
        "connect snapshots the source batch"
    );
    // Undo below must target the delete, not the connect that made the rows.
    db.clear_history().expect("clear connect history");
    // With the FK on, deleting the edge cascades the snapshot rows and hides
    // a regression where delete_edges stops deleting them explicitly.
    direct_write(&db, "PRAGMA foreign_keys = OFF");

    let removed = db.delete_edges(vec!["e1".to_owned()]).expect("delete e1");
    assert_eq!(removed.changes.edges_removed, vec!["e1".to_owned()]);
    assert_eq!(
        db.node_detail("t".to_owned())
            .expect("detail")
            .expect("t detail")
            .inputs
            .len(),
        0,
        "delete removes the edge's snapshot rows"
    );

    db.undo().expect("undo the delete");
    let restored = db
        .node_detail("t".to_owned())
        .expect("detail")
        .expect("t detail");
    assert_eq!(restored.inputs.len(), 1);
    assert_eq!(restored.inputs[0].id, "input-e1-item-a");
    assert_eq!(restored.inputs[0].text, "hello");
    assert_eq!(restored.inputs[0].position, 0.0);
    assert_eq!(restored.inputs[0].edge_id.as_deref(), Some("e1"));
    assert_eq!(restored.inputs[0].item_id.as_deref(), Some("item-a"));

    db.redo().expect("redo the delete");
    assert_eq!(
        db.node_detail("t".to_owned())
            .expect("detail")
            .expect("t detail")
            .inputs
            .len(),
        0
    );
    direct_write(&db, "PRAGMA foreign_keys = ON");
}

#[test]
fn snapshots_edges_into_ordered_inputs_and_undoes_their_removal() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("text", "Text", "A lake", &[], 0.0, 0.0),
        node("image", "Image", "", &[], 400.0, 0.0),
    ])
    .expect("insert nodes");

    db.save_run(
        ResultBatchInput {
            id: "batch-text".to_owned(),
            node_id: "text".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![
            ResultItemInput {
                id: "item-a".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "A lake".to_owned(),
                asset_id: None,
                meta_json: None,
            },
            ResultItemInput {
                id: "item-b".to_owned(),
                position: 1.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "At dawn".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        ],
    )
    .expect("save source batch");

    db.connect_edge(EdgeInput {
        id: "edge-text-image".to_owned(),
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

    let detail = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(detail.inputs.len(), 2);
    assert_eq!(detail.inputs[0].item_id.as_deref(), Some("item-a"));
    assert_eq!(detail.inputs[1].item_id.as_deref(), Some("item-b"));
    assert_eq!(detail.inputs[0].origin, "edge");

    let removed = db
        .remove_input(detail.inputs[0].id.clone())
        .expect("remove first input");
    assert_eq!(removed.changes.changed.len(), 1);
    assert_eq!(removed.changes.changed[0].id, "image");
    assert_eq!(removed.changes.changed[0].status, "idle");
    let after = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(after.inputs.len(), 1);
    assert_eq!(after.inputs[0].item_id.as_deref(), Some("item-b"));

    db.undo().expect("undo input removal");
    let restored = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(restored.inputs.len(), 2);
    assert_eq!(restored.inputs[0].item_id.as_deref(), Some("item-a"));

    db.redo().expect("redo input removal");
    let after_redo = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(after_redo.inputs.len(), 1);

    // A run's input sync clears removals and recreates the snapshots; it
    // is not history, so it invalidates the pending removal entry.
    db.sync_inputs("image".to_owned()).expect("sync after run");
    let undone = db.undo().expect("undo after sync");
    assert!(
        undone.changed.is_empty(),
        "sync invalidates the input removal entry"
    );
    let restored = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(restored.inputs.len(), 2);
}

#[test]
fn snapshots_only_the_connected_output_port_and_reports_incoming_edges() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("image", "Image", "", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert nodes");
    test_asset(&db, "asset-image");

    // One batch, two output ports: only the connected port's items may
    // snapshot into the target.
    db.save_run(
        ResultBatchInput {
            id: "batch-image".to_owned(),
            node_id: "image".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
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
                id: "item-text".to_owned(),
                position: 1.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "sidecar".to_owned(),
                asset_id: None,
                meta_json: None,
            },
        ],
    )
    .expect("save source batch");

    db.connect_edge(EdgeInput {
        id: "edge-image".to_owned(),
        from_id: "image".to_owned(),
        to_id: "target".to_owned(),
        from_port: "image".to_owned(),
        to_port: "references".to_owned(),
        port_kind: "image".to_owned(),
        from_offset: 28.0,
        to_offset: 56.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    let detail = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(detail.inputs.len(), 1, "only the image port snapshots");
    assert_eq!(detail.inputs[0].item_id.as_deref(), Some("item-image"));
    assert_eq!(detail.inputs[0].port_id, "references");
    assert_eq!(detail.inputs[0].edge_id.as_deref(), Some("edge-image"));
    assert_eq!(detail.incoming.len(), 1);
    assert_eq!(detail.incoming[0].port_id, "references");
    assert_eq!(detail.incoming[0].edges, 1.0);

    // A source whose new batch has nothing on the connected port leaves
    // no rows, but the connector still occupies the port's slot: capacity
    // counts edges, not rows.
    db.save_run(
        ResultBatchInput {
            id: "batch-empty".to_owned(),
            node_id: "image".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-image".to_owned(),
            model: "mock-image".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-other".to_owned(),
            position: 0.0,
            port_id: "text".to_owned(),
            kind: "text".to_owned(),
            text: "sidecar".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("batch without the connected port");
    db.sync_inputs("target".to_owned()).expect("sync");
    let after = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(after.inputs.len(), 0);
    assert_eq!(after.incoming.len(), 1);
    assert_eq!(after.incoming[0].edges, 1.0);
}

#[test]
fn a_colliding_edge_restore_is_stale_instead_of_wedging_undo() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.clear_history().expect("clear insert history");
    connect(&db, "e1", "a", "t");
    db.delete_edges(vec!["e1".to_owned()]).expect("delete e1");
    connect(&db, "e2", "a", "t");

    // Simulate invalidation removing the entry that created e2 while the
    // edge itself survives; restoring e1 would collide on its port pair.
    let removed = db
        .history
        .lock()
        .expect("history")
        .take_undo()
        .expect("e2 connect entry");
    assert!(matches!(
        removed.forward.first(),
        Some(HistoryOp::InsertEdge(_))
    ));

    let undone = db.undo().expect("a colliding restore is stale");
    assert!(undone.changed.is_empty());
    assert_eq!(db.edge_count().expect("edge count"), 1);
}

#[test]
fn a_same_pair_reconnect_undoes_and_redoes() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "e1", "a", "t");
    db.update_edge(EdgeInput {
        id: "e1".to_owned(),
        from_id: "a".to_owned(),
        to_id: "t".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 50.0,
        to_offset: 50.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("reconnect the same pair");
    let offset = || {
        db.run(|conn| {
            edge_rows::Entity::find()
                .filter(edge_rows::Column::Id.eq("e1"))
                .one(conn)
                .map_err(|error| error.to_string())
        })
        .expect("read edge")
        .expect("edge exists")
        .from_offset
    };
    assert_eq!(offset(), 50.0);

    db.undo().expect("undo the same-pair reconnect");
    assert_eq!(offset(), 42.0);
    db.redo().expect("redo the same-pair reconnect");
    assert_eq!(offset(), 50.0);
}

#[test]
fn a_colliding_reconnect_restore_is_stale() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("t", "T", "", &[], 400.0, 0.0),
        node("t2", "T2", "", &[], 800.0, 0.0),
    ])
    .expect("insert");
    db.clear_history().expect("clear insert history");
    connect(&db, "e1", "a", "t");
    db.update_edge(EdgeInput {
        id: "e1".to_owned(),
        from_id: "a".to_owned(),
        to_id: "t2".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("reconnect to t2");
    connect(&db, "e3", "a", "t");

    // Simulate invalidation dropping the e3 connect entry while e3
    // survives; restoring e1's old pair would collide with e3.
    let removed = db
        .history
        .lock()
        .expect("history")
        .take_undo()
        .expect("e3 connect entry");
    assert!(matches!(
        removed.forward.first(),
        Some(HistoryOp::InsertEdge(_))
    ));

    let undone = db.undo().expect("a colliding reconnect restore is stale");
    assert!(undone.changed.is_empty());
    let edge = db
        .run(|conn| {
            edge_rows::Entity::find()
                .filter(edge_rows::Column::Id.eq("e1"))
                .one(conn)
                .map_err(|error| error.to_string())
        })
        .expect("read e1")
        .expect("e1 exists");
    assert_eq!(edge.to_id, "t2");
    assert_eq!(db.edge_count().expect("edge count"), 2);
}

#[test]
fn removing_an_edge_marks_a_downstream_target_stale_once() {
    let db = Database::open(":memory:").expect("open");
    upload_with_edge_to_target(&db);
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
    let before = db
        .get_node("target".to_owned())
        .expect("get target")
        .expect("target");

    let changes = db
        .set_node_settings(
            "source".to_owned(),
            r#"{"version":1,"media":[]}"#.to_owned(),
            Some(Vec::new()),
        )
        .expect("remove the output port");
    let touched: Vec<_> = changes
        .changes
        .changed
        .iter()
        .filter(|node| node.id == "target")
        .collect();
    assert_eq!(touched.len(), 1, "the target is refreshed exactly once");
    assert_eq!(touched[0].status, "stale");
    assert_eq!(touched[0].rev, before.rev + 1.0);

    db.undo().expect("undo the settings edit");
    assert_eq!(scene_edge_ids(&db), vec!["edge-source".to_owned()]);
    let restored = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(restored.inputs.len(), 1);
    assert_eq!(restored.inputs[0].edge_id.as_deref(), Some("edge-source"));
}

#[test]
fn reconnecting_an_edge_moves_its_input_snapshot_and_undoes_it() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
        node("old", "Old target", "", &[], 400.0, 0.0),
        node("new", "New target", "", &[], 800.0, 0.0),
    ])
    .expect("insert nodes");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "A lake".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("batch");
    db.connect_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "source".to_owned(),
        to_id: "old".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    db.update_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "source".to_owned(),
        to_id: "new".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("reconnect");

    let old = db
        .node_detail("old".to_owned())
        .expect("detail")
        .expect("old detail");
    let new = db
        .node_detail("new".to_owned())
        .expect("detail")
        .expect("new detail");
    assert_eq!(old.inputs.len(), 0);
    assert_eq!(new.inputs.len(), 1);
    assert_eq!(new.inputs[0].edge_id.as_deref(), Some("edge"));

    db.undo().expect("undo reconnect");
    let old = db
        .node_detail("old".to_owned())
        .expect("detail")
        .expect("old detail");
    let new = db
        .node_detail("new".to_owned())
        .expect("detail")
        .expect("new detail");
    assert_eq!(old.inputs.len(), 1);
    assert_eq!(new.inputs.len(), 0);

    db.redo().expect("redo reconnect");
    let old = db
        .node_detail("old".to_owned())
        .expect("detail")
        .expect("old detail");
    let new = db
        .node_detail("new".to_owned())
        .expect("detail")
        .expect("new detail");
    assert_eq!(old.inputs.len(), 0);
    assert_eq!(new.inputs.len(), 1);
    assert_eq!(new.inputs[0].edge_id.as_deref(), Some("edge"));
}
