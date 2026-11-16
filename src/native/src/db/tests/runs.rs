//! Run lifecycle, stale targets and history invalidation.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn a_successful_run_marks_its_targets_stale_and_keeps_the_last_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.connect_edge(EdgeInput {
        id: "a-b".to_owned(),
        from_id: "a".to_owned(),
        to_id: "b".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    let first = db
        .save_run(
            ResultBatchInput {
                id: "batch-b".to_owned(),
                node_id: "b".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-b".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "B output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save run");
    assert_eq!(first.changed[0].status, "done");
    assert_eq!(first.changed[0].output_batch_id.as_deref(), Some("batch-b"));

    let second = db
        .save_run(
            ResultBatchInput {
                id: "batch-a".to_owned(),
                node_id: "a".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-a".to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: "A output".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("save source run");
    assert!(
        second
            .changed
            .iter()
            .any(|node| { node.id == "b" && node.status == "stale" })
    );

    let failed = db
        .save_run(
            ResultBatchInput {
                id: "batch-failed".to_owned(),
                node_id: "b".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "failed".to_owned(),
                error: Some("prompt is empty".to_owned()),
            },
            Vec::new(),
        )
        .expect("save failure");
    assert_eq!(failed.changed[0].status, "failed");
    assert_eq!(
        failed.changed[0].output_batch_id.as_deref(),
        Some("batch-b")
    );
}

#[test]
fn a_later_run_invalidates_a_settings_edit_and_keeps_the_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "Original", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_settings(
        "a".to_owned(),
        "{\"prompt\":\"one\"}".to_owned(),
        Some(vec![
            "prompt".to_owned(),
            "references".to_owned(),
            "text".to_owned(),
        ]),
    )
    .expect("settings");

    // Runs are not history: the undo below must not resurrect the body,
    // output or status this run wrote.
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "Run output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");

    // The run made the pending settings entry stale: undo must not restore
    // the old settings over the output the run wrote.
    let undone = db.undo().expect("undo after a run");
    assert!(
        undone.changed.is_empty(),
        "a non-history run invalidates the settings entry"
    );
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.settings_json, "{\"prompt\":\"one\"}");
    assert_eq!(detail.node.body, "Run output");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch"));
    assert_eq!(detail.node.status, "done");

    // Redo was cleared by the run as well.
    let redone = db.redo().expect("redo after invalidation");
    assert!(redone.changed.is_empty());
    let redone = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(redone.node.settings_json, "{\"prompt\":\"one\"}");
    assert_eq!(redone.node.body, "Run output");
    assert_eq!(redone.node.output_batch_id.as_deref(), Some("batch"));
}

#[test]
fn a_later_run_invalidates_a_manual_text_entry() {
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
    db.save_run(
        ResultBatchInput {
            id: "batch-run".to_owned(),
            node_id: "n".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-run".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "run output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");
    let before = current_rev(&db);

    let undone = db.undo().expect("undo after a run");
    assert!(undone.changed.is_empty());
    assert_eq!(undone.rev, before as f64);
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("node detail");
    assert_eq!(detail.node.body, "run output");
    assert_eq!(detail.node.output_batch_id.as_deref(), Some("batch-run"));
    assert_eq!(detail.node.status, "done");
}

#[test]
fn a_run_on_the_source_invalidates_a_removed_edge_input() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-one".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-one".to_owned(),
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
    let input_id = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs[0]
        .id
        .clone();
    db.remove_input(input_id).expect("remove snapshot");

    // A run on the source makes the removed snapshot stale; the entry
    // records the source node from its edge.
    db.save_run(
        ResultBatchInput {
            id: "batch-two".to_owned(),
            node_id: "source".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-two".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "A dawn".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("source rerun");

    let undone = db.undo().expect("undo after the source run");
    assert!(undone.changed.is_empty());
    assert!(
        db.node_detail("target".to_owned())
            .expect("detail")
            .expect("target detail")
            .inputs
            .is_empty(),
        "the run on the source invalidated the removed snapshot"
    );
}

#[test]
fn a_source_run_invalidates_an_output_entry_on_a_stale_target() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("source", "Source", "A lake", &[], 0.0, 0.0),
        node("target", "Target", "", &[], 400.0, 0.0),
    ])
    .expect("insert");
    let run = |db: &Database, batch: &str, node: &str, item: &str, text: &str| {
        db.save_run(
            ResultBatchInput {
                id: batch.to_owned(),
                node_id: node.to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: item.to_owned(),
                position: 0.0,
                port_id: "out".to_owned(),
                kind: "text".to_owned(),
                text: text.to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("run");
    };
    run(&db, "batch-source-one", "source", "item-source-one", "one");
    run(
        &db,
        "batch-target",
        "target",
        "item-target",
        "target output",
    );
    db.set_manual_text(
        "target".to_owned(),
        "manual target".to_owned(),
        ResultBatchInput {
            id: "batch-target-manual".to_owned(),
            node_id: "target".to_owned(),
            trigger: "manual".to_owned(),
            provider: "manual".to_owned(),
            model: String::new(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        ResultItemInput {
            id: "item-target-manual".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "manual target".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual target");
    // The connect marks the target stale while the manual entry is still
    // pending; the next source run must still invalidate that entry.
    connect(&db, "source-target", "source", "target");
    run(&db, "batch-source-two", "source", "item-source-two", "two");

    let undone = db.undo().expect("undo after the source run");
    assert!(undone.changed.is_empty());
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(target.node.status, "stale");
    assert_eq!(target.node.body, "manual target");
    assert_eq!(
        target.node.output_batch_id.as_deref(),
        Some("batch-target-manual")
    );
}

#[test]
fn a_status_write_invalidates_pending_history() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.move_nodes(vec!["n".to_owned()], 10.0, 0.0)
        .expect("move");
    db.set_node_status("n".to_owned(), "running".to_owned())
        .expect("status");

    let undone = db.undo().expect("undo after the status write");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.get_node("n".to_owned()).expect("get").expect("n").x,
        10.0
    );
}

#[test]
fn recovering_runs_invalidates_pending_history() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("n".to_owned(), "running".to_owned())
        .expect("status");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "n".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");
    db.move_nodes(vec!["n".to_owned()], 10.0, 0.0)
        .expect("move");
    assert_eq!(db.recover_runs().expect("recover"), 1);

    let undone = db.undo().expect("undo after recovery");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.get_node("n".to_owned()).expect("get").expect("n").x,
        10.0
    );
}

#[test]
fn a_run_invalidates_a_settings_entry_that_removed_an_edge() {
    let db = Database::open(":memory:").expect("open");
    text_target_with_incoming_edge(&db);
    db.clear_history().expect("clear setup history");
    let settings = db
        .set_node_settings(
            "target".to_owned(),
            r#"{"version":1,"prompt":"changed"}"#.to_owned(),
            Some(vec!["references".to_owned(), "text".to_owned()]),
        )
        .expect("remove the input port");
    assert!(settings.forward.iter().any(|op| matches!(
        op,
        HistoryOp::DeleteEdge { id } if id == "edge-target"
    )));
    assert!(scene_edge_ids(&db).is_empty());

    // A run is not history: it invalidates the pending settings entry,
    // which references the source through its restored edge.
    db.save_run(
        ResultBatchInput {
            id: "batch-later".to_owned(),
            node_id: "source".to_owned(),
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
    .expect("run");

    let undone = db.undo().expect("undo after a run");
    assert!(undone.changed.is_empty());
    assert!(scene_edge_ids(&db).is_empty());
    let target = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail");
    assert_eq!(
        target.node.settings_json,
        r#"{"version":1,"prompt":"changed"}"#
    );
    assert!(target.inputs.is_empty());
}

#[test]
fn a_later_run_invalidates_a_reconnect_entry() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("first", "First", "A lake", &[], 0.0, 0.0),
        node("second", "Second", "A dawn", &[], 400.0, 0.0),
        node("target", "Target", "", &[], 800.0, 0.0),
    ])
    .expect("insert nodes");
    let batch = |id: &str, node_id: &str| ResultBatchInput {
        id: id.to_owned(),
        node_id: node_id.to_owned(),
        trigger: "manual".to_owned(),
        provider: "manual".to_owned(),
        model: String::new(),
        params_json: "{}".to_owned(),
        status: "done".to_owned(),
        error: None,
    };
    let item = |id: &str, text: &str| ResultItemInput {
        id: id.to_owned(),
        position: 0.0,
        port_id: "out".to_owned(),
        kind: "text".to_owned(),
        text: text.to_owned(),
        asset_id: None,
        meta_json: None,
    };
    db.save_run(
        batch("batch-first", "first"),
        vec![item("i1", "first item")],
    )
    .expect("first batch");
    db.save_run(
        batch("batch-second", "second"),
        vec![item("j1", "second item")],
    )
    .expect("second batch");
    db.connect_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "first".to_owned(),
        to_id: "target".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    // Move the source end, then run the new source again and sync the
    // target: the snapshot rows are rebuilt under new item ids, so the
    // ids the reconnect captured are gone.
    db.update_edge(EdgeInput {
        id: "edge".to_owned(),
        from_id: "second".to_owned(),
        to_id: "target".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("reconnect");
    db.save_run(
        batch("batch-second-2", "second"),
        vec![item("j2", "second again")],
    )
    .expect("second rerun");
    db.sync_inputs("target".to_owned()).expect("sync");

    // The rerun and the input sync made the reconnect entry stale; undo
    // must not resurrect either the old or the replaced snapshot.
    let undone = db.undo().expect("undo after a run and sync");
    assert!(
        undone.changed.is_empty(),
        "the non-history writes invalidate the reconnect entry"
    );
    let inputs = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs;
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].item_id.as_deref(), Some("j2"));
    assert_eq!(inputs[0].text, "second again");

    let redone = db.redo().expect("redo after invalidation");
    assert!(redone.changed.is_empty());
    let inputs = db
        .node_detail("target".to_owned())
        .expect("detail")
        .expect("target detail")
        .inputs;
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].item_id.as_deref(), Some("j2"));
}

#[test]
fn recovering_runs_marks_running_nodes_interrupted() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("a".to_owned(), "running".to_owned())
        .expect("running");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");

    assert_eq!(db.recover_runs().expect("recover"), 1);
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("detail");
    assert_eq!(detail.node.status, "interrupted");
    assert_eq!(detail.batch, None);
}

#[test]
fn a_provider_run_is_inserted_running_then_settled() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-failed".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "failed".to_owned(),
            error: Some("prompt is empty".to_owned()),
        },
        Vec::new(),
    )
    .expect("save a failed run");
    let (status, error, item_count, finished_at) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-failed"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.error, row.item_count, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "failed");
    assert_eq!(error.as_deref(), Some("prompt is empty"));
    assert_eq!(item_count, 0);
    assert!(finished_at.is_some(), "a settled batch is finished");

    db.save_run(
        ResultBatchInput {
            id: "batch-done".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-done".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "result".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("save a successful run");
    let (status, item_count) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-done"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.item_count)))
                .map_err(|error| error.to_string())
        })
        .expect("read done batch")
        .expect("done row");
    assert_eq!((status.as_str(), item_count), ("done", 1));

    // The triggers own the state machine: a settled insert or a late item
    // write is refused rather than silently stored.
    let late_insert = db.run(|conn| {
        conn.execute_unprepared(
            "INSERT INTO result_batches \
                 (id, node_id, node_seq, trigger, status, created_at) \
                 VALUES ('batch-direct', 'a', 1, 'run', 'done', 0)",
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    });
    assert!(late_insert.is_err(), "a batch must be inserted running");
    let late_item = db.run(|conn| {
        conn.execute_unprepared(
            "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
                 VALUES ('late', 'batch-done', 1, 'out', 'text', 'late')",
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    });
    assert!(late_item.is_err(), "items only enter a running batch");
}

#[test]
fn begin_and_settle_a_provider_run() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let begun = db
        .begin_run(ResultBatchInput {
            id: "batch-run".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        })
        .expect("begin run");
    assert_eq!(begun.changed[0].status, "running");
    assert_eq!(begun.changed[0].output_batch_id, None);
    let running = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-run"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(running, ("running".to_owned(), None));

    let settled = db
        .settle_run(
            ResultBatchInput {
                id: "batch-run".to_owned(),
                node_id: "a".to_owned(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: r#"{"prompt":"p"}"#.to_owned(),
                status: "done".to_owned(),
                error: None,
            },
            vec![ResultItemInput {
                id: "item-run".to_owned(),
                position: 0.0,
                port_id: "text".to_owned(),
                kind: "text".to_owned(),
                text: "run result".to_owned(),
                asset_id: None,
                meta_json: None,
            }],
        )
        .expect("settle run");
    assert_eq!(settled.changed[0].status, "done");
    assert_eq!(
        settled.changed[0].output_batch_id.as_deref(),
        Some("batch-run")
    );
    assert_eq!(settled.changed[0].body, "run result");
    let settled_row = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-run"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.item_count, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read settled batch")
        .expect("settled row");
    assert_eq!(settled_row.0, "done");
    assert_eq!(settled_row.1, 1);
    assert!(settled_row.2.is_some());

    // A repeated or absent settle changes nothing and does not bump the
    // revision.
    let before = current_rev(&db);
    let settle_input = |id: &str| ResultBatchInput {
        id: id.to_owned(),
        node_id: "a".to_owned(),
        trigger: "run".to_owned(),
        provider: "mock-text".to_owned(),
        model: "mock-text".to_owned(),
        params_json: "{}".to_owned(),
        status: "failed".to_owned(),
        error: None,
    };
    let repeated = db
        .settle_run(settle_input("batch-run"), Vec::new())
        .expect("repeated settle");
    assert!(repeated.changed.is_empty());
    assert_eq!(repeated.rev, before as f64);
    let missing = db
        .settle_run(settle_input("batch-missing"), Vec::new())
        .expect("late settle");
    assert!(missing.changed.is_empty());
    assert_eq!(current_rev(&db), before);
}

#[test]
fn a_failed_rerun_keeps_the_previous_output() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        run_batch("batch-first", "a", "done", None),
        vec![text_item("item-first", "first result")],
    )
    .expect("first run");
    let first = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("node");
    let first_batch = first.batch.expect("the first run is the output");
    assert_eq!(first.node.status, "done");
    assert_eq!(first.node.output_batch_id.as_deref(), Some("batch-first"));
    assert_eq!(first_batch.id, "batch-first");
    assert_eq!(first_batch.error, None, "a done batch has no error");

    for (batch_id, status, error) in [
        ("batch-failed", "failed", Some("the provider failed")),
        ("batch-cancelled", "cancelled", None),
    ] {
        db.begin_run(run_batch(batch_id, "a", "running", None))
            .expect("begin rerun");
        let settled = db
            .settle_run(run_batch(batch_id, "a", status, error), Vec::new())
            .expect("settle rerun");
        let changed = settled
            .changed
            .iter()
            .find(|changed| changed.id == "a")
            .expect("the node changed");
        assert_eq!(changed.status, status);
        assert_eq!(
            changed.output_batch_id.as_deref(),
            Some("batch-first"),
            "a {status} run keeps the previous output"
        );
        assert_eq!(
            changed.body, "first result",
            "a {status} run keeps the body"
        );
        let detail = db
            .node_detail("a".to_owned())
            .expect("detail")
            .expect("node");
        assert_eq!(detail.batch.expect("output batch").id, "batch-first");
        let latest = detail.latest_batch.expect("the rerun batch");
        assert_eq!(
            (latest.id.as_str(), latest.status.as_str()),
            (batch_id, status)
        );
    }
}

#[test]
fn deleting_a_node_mid_run_cancels_its_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin run");
    assert_eq!(
        db.delete_nodes(vec!["a".to_owned()])
            .expect("delete mid-run")
            .changes
            .removed,
        ["a"]
    );
    let settled = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-live"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(settled.0, "cancelled", "delete settles the running batch");
    assert!(settled.1.is_some(), "the cancelled batch is finished");

    // Undo restores the node in a terminal state, not stuck running with
    // no run behind it.
    let undone = db.undo().expect("undo the delete");
    let restored = undone
        .changed
        .iter()
        .find(|changed| changed.id == "a")
        .expect("the node came back");
    assert_eq!(restored.status, "cancelled");

    // A late provider result is a no-op: it can neither fill the settled
    // batch nor overwrite the node the undo restored.
    let late = db
        .settle_run(
            run_batch("batch-live", "a", "done", None),
            vec![text_item("late-item", "late result")],
        )
        .expect("late settle");
    assert!(late.changed.is_empty());
    let detail = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("the node exists");
    assert_eq!(detail.node.status, "cancelled");
    assert_eq!(detail.node.body, "");
    assert!(detail.batch.is_none(), "the cancelled run wrote no output");
    assert_eq!(
        detail.latest_batch.map(|batch| batch.status),
        Some("cancelled".to_owned())
    );

    // The late settle did not invalidate the delete's redo entry.
    assert_eq!(db.redo().expect("redo the delete").removed, ["a"]);
    assert_eq!(db.count().expect("nodes after redo"), 0);

    // A one-call write for the now-missing node is also a no-op.
    let late_save = db
        .save_run(run_batch("batch-orphan", "a", "failed", None), Vec::new())
        .expect("late save");
    assert!(late_save.changed.is_empty());
    let batch_count = db
        .run(|conn| {
            result_batches::Entity::find()
                .all(conn)
                .map(|rows| rows.len())
                .map_err(|error| error.to_string())
        })
        .expect("count batches");
    assert_eq!(
        batch_count, 1,
        "a late save for a missing node writes nothing"
    );
}

#[test]
fn a_recreated_node_id_does_not_inherit_the_previous_incarnation_batches() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.save_run(
        run_batch("batch-old", "n", "done", None),
        vec![text_item("item-old", "old result")],
    )
    .expect("run");
    assert_eq!(
        db.node_detail("n".to_owned())
            .expect("detail")
            .expect("node")
            .latest_batch
            .expect("latest batch")
            .id,
        "batch-old"
    );

    db.delete_nodes(vec!["n".to_owned()]).expect("delete");
    db.insert_nodes(vec![node("n", "N", "new", &[], 10.0, 10.0)])
        .expect("recreate the id");
    let detail = db
        .node_detail("n".to_owned())
        .expect("detail")
        .expect("the new node");
    assert!(detail.batch.is_none(), "the new incarnation has no output");
    assert!(
        detail.latest_batch.is_none(),
        "a re-created id must not inherit the dead incarnation's batch"
    );
}

#[test]
fn settling_a_run_for_a_missing_or_replaced_node_cancels_it() {
    let db = Database::open(":memory:").expect("open");
    let remove_node = |id: &str| {
        let id = id.to_owned();
        db.run(move |conn| {
            node_rows::Entity::delete_many()
                .filter(node_rows::Column::Id.eq(id))
                .exec(conn)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .expect("remove the node out of band");
    };
    let batch_state = |id: &str| {
        let id = id.to_owned();
        db.run(move |conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq(id))
                .one(conn)
                .map(|row| {
                    row.map(|row| {
                        (
                            row.status,
                            row.item_count,
                            row.finished_at,
                            row.error.unwrap_or_default(),
                        )
                    })
                })
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row")
    };

    // The node row disappears while its batch still runs.
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-missing", "a", "running", None))
        .expect("begin run");
    remove_node("a");
    let missing = db
        .settle_run(
            run_batch("batch-missing", "a", "done", None),
            vec![text_item("late-item", "late result")],
        )
        .expect("settle against a missing node");
    assert!(missing.changed.is_empty());
    let (status, item_count, finished_at, error) = batch_state("batch-missing");
    assert_eq!(status, "cancelled");
    assert_eq!(item_count, 0, "an orphan settle writes no items");
    assert!(finished_at.is_some(), "the orphan batch is finished");
    assert!(error.contains("deleted"), "{error}");

    // The id comes back as a new incarnation (new seq) while the old
    // batch still runs: the old run must not attach to it.
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("new incarnation");
    db.begin_run(run_batch("batch-incarnation", "a", "running", None))
        .expect("begin run");
    remove_node("a");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("third incarnation");
    let replaced = db
        .settle_run(
            run_batch("batch-incarnation", "a", "done", None),
            vec![text_item("wrong-item", "wrong")],
        )
        .expect("settle against a replaced node");
    assert!(replaced.changed.is_empty());
    let (status, item_count, _, _) = batch_state("batch-incarnation");
    assert_eq!(status, "cancelled");
    assert_eq!(item_count, 0, "a dead incarnation's run writes no items");
    let live = db
        .node_detail("a".to_owned())
        .expect("detail")
        .expect("the live node");
    assert!(live.batch.is_none(), "the new incarnation has no output");
    assert!(live.latest_batch.is_none());
}

#[test]
fn deleting_several_nodes_settles_only_the_running_ones() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.save_run(
        run_batch("batch-done", "b", "done", None),
        vec![text_item("item-done", "done result")],
    )
    .expect("settle b");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin on a");

    let deleted = db
        .delete_nodes(vec!["a".to_owned(), "b".to_owned()])
        .expect("delete both");
    assert_eq!(deleted.changes.removed.len(), 2);
    let running = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Status.eq("running"))
                .all(conn)
                .map(|rows| rows.len())
                .map_err(|error| error.to_string())
        })
        .expect("count running batches");
    assert_eq!(running, 0, "no batch outlives its node");
    let done = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-done"))
                .one(conn)
                .map(|row| row.map(|row| row.status))
                .map_err(|error| error.to_string())
        })
        .expect("read done batch")
        .expect("done batch");
    assert_eq!(done, "done", "a settled batch is left untouched");

    let undone = db.undo().expect("undo the delete");
    let mut statuses: BTreeMap<&str, &str> = BTreeMap::new();
    for changed in &undone.changed {
        statuses.insert(changed.id.as_str(), changed.status.as_str());
    }
    assert_eq!(statuses.get("a"), Some(&"cancelled"));
    assert_eq!(statuses.get("b"), Some(&"done"));
    let b = db
        .node_detail("b".to_owned())
        .expect("detail")
        .expect("b returned");
    assert_eq!(b.batch.expect("output batch").id, "batch-done");
}

#[test]
fn applying_a_delete_op_cancels_a_running_batch() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.begin_run(run_batch("batch-live", "a", "running", None))
        .expect("begin");
    let changes = db
        .apply_ops(&[HistoryOp::Delete { id: "a".to_owned() }])
        .expect("apply a delete op");
    assert_eq!(changes.removed, ["a"]);
    let status = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-live"))
                .one(conn)
                .map(|row| row.map(|row| row.status))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "cancelled");
}

#[test]
fn recovering_a_running_batch_settles_it_with_a_finish_time() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.set_node_status("a".to_owned(), "running".to_owned())
        .expect("running");
    db.save_run(
        ResultBatchInput {
            id: "batch-running".to_owned(),
            node_id: "a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "running".to_owned(),
            error: None,
        },
        Vec::new(),
    )
    .expect("running batch");
    assert_eq!(db.recover_runs().expect("recover"), 1);
    let (status, finished_at) = db
        .run(|conn| {
            result_batches::Entity::find()
                .filter(result_batches::Column::Id.eq("batch-running"))
                .one(conn)
                .map(|row| row.map(|row| (row.status, row.finished_at)))
                .map_err(|error| error.to_string())
        })
        .expect("read batch")
        .expect("batch row");
    assert_eq!(status, "interrupted");
    assert!(finished_at.is_some(), "recovery settles the batch");
}
