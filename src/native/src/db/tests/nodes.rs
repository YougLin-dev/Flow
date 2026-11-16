//! Node insert, move, tag, bounds and delete commands.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn inserts_searches_moves_and_deletes() {
    let db = Database::open(":memory:").expect("open");
    let mutation = db
        .insert_nodes(vec![
            node(
                "a",
                "Image generator",
                "Makes an image",
                &["image"],
                0.0,
                0.0,
            ),
            node("b", "Text panel", "A text node", &["text"], 300.0, 0.0),
        ])
        .expect("insert");
    assert_eq!(mutation.changes.changed.len(), 2);
    assert_eq!(db.count().expect("count"), 2);

    let found = db.get_node("a".to_owned()).expect("get node");
    assert_eq!(
        found.as_ref().map(|node| node.title.as_str()),
        Some("Image generator")
    );
    assert!(
        db.get_node("missing".to_owned())
            .expect("get missing")
            .is_none()
    );

    let hits = db
        .search("generator".to_owned(), SearchFilters::default(), 20)
        .expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "a");
    assert!(
        db.search("   ".to_owned(), SearchFilters::default(), 20)
            .expect("empty search")
            .is_empty()
    );
    assert_eq!(
        db.search(
            "panel".to_owned(),
            SearchFilters {
                kind: Some("text".to_owned()),
            },
            20,
        )
        .expect("kind search")
        .len(),
        1
    );
    assert!(
        db.search(
            "panel".to_owned(),
            SearchFilters {
                kind: Some("image".to_owned()),
            },
            20,
        )
        .expect("kind search miss")
        .is_empty()
    );

    let viewport = db
        .viewport(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 150.0,
                height: 100.0,
            },
            0.0,
        )
        .expect("viewport");
    assert_eq!(viewport.len(), 1);
    assert_eq!(viewport[0].id, "a");

    let moved = db
        .move_nodes(vec!["a".to_owned()], 50.0, 25.0)
        .expect("move");
    assert_eq!(moved.changes.changed[0].x, 50.0);
    assert_eq!(moved.changes.changed[0].y, 25.0);

    db.apply_ops(&moved.inverse).expect("undo move");
    let restored = db
        .viewport(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 150.0,
                height: 100.0,
            },
            0.0,
        )
        .expect("viewport after undo");
    assert_eq!(restored[0].x, 0.0);

    let deleted = db.delete_nodes(vec!["a".to_owned()]).expect("delete");
    assert_eq!(deleted.changes.removed, vec!["a"]);
    assert_eq!(db.count().expect("count after delete"), 1);
    db.apply_ops(&deleted.inverse).expect("undo delete");
    assert_eq!(db.count().expect("count after undo"), 2);
}

#[test]
fn undo_restores_a_deleted_node_its_edges_and_indexes() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "Generator", "Makes an image", &["image"], 0.0, 0.0),
        node("b", "Text panel", "A text node", &["text"], 300.0, 0.0),
    ])
    .expect("insert nodes");
    db.insert_edges(vec![EdgeInput {
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
    }])
    .expect("insert edge");
    assert_eq!(db.edge_count().expect("edge count"), 1);

    let deleted = db.delete_nodes(vec!["a".to_owned()]).expect("delete");
    assert_eq!(deleted.changes.edges_removed, vec!["a-b"]);
    assert_eq!(db.edge_count().expect("edge count after delete"), 0);
    assert!(
        db.search("Generator".to_owned(), SearchFilters::default(), 20)
            .expect("search after delete")
            .is_empty()
    );

    let undone = db.undo().expect("undo delete");
    assert!(undone.changed.iter().any(|node| node.id == "a"));
    assert_eq!(db.count().expect("count after undo"), 2);
    assert_eq!(db.edge_count().expect("edge count after undo"), 1);
    assert_eq!(
        db.search("Generator".to_owned(), SearchFilters::default(), 20)
            .expect("search after undo")
            .len(),
        1
    );

    let redone = db.redo().expect("redo delete");
    assert_eq!(redone.removed, vec!["a"]);
    assert_eq!(db.count().expect("count after redo"), 1);
    assert_eq!(db.edge_count().expect("edge count after redo"), 0);
}

#[test]
fn schema_cascades_edges_and_inputs_with_their_nodes() {
    let db = Database::open(":memory:").expect("open");
    let schema = db
        .run(|conn| {
            let statement = sea_orm::Statement::from_string(
                sea_orm::DbBackend::Sqlite,
                "SELECT name, sql FROM sqlite_master \
                     WHERE name IN ('edges', 'node_inputs')"
                    .to_owned(),
            );
            let rows = conn
                .query_all_raw(statement)
                .map_err(|error| error.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    (
                        row.try_get::<String>("", "name").unwrap_or_default(),
                        row.try_get::<String>("", "sql").unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>())
        })
        .expect("schema");

    assert_eq!(schema.len(), 2, "both node-owned relations were found");
    for (name, sql) in schema {
        assert!(
            sql.contains("ON DELETE CASCADE"),
            "{name} must cascade when its node is deleted"
        );
    }
}

#[test]
fn deleting_a_node_cascades_its_edges_and_inputs() {
    use sea_orm::{ActiveValue::Set, PaginatorTrait};

    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert nodes");
    test_asset(&db, "asset-local");

    db.run(|conn| {
        edge_rows::Entity::insert(edge_rows::ActiveModel {
            seq: sea_orm::ActiveValue::NotSet,
            id: Set("edge".to_owned()),
            from_id: Set("a".to_owned()),
            to_id: Set("b".to_owned()),
            from_port: Set("out".to_owned()),
            to_port: Set("in".to_owned()),
            port_kind: Set("text".to_owned()),
            from_offset: Set(42.0),
            to_offset: Set(42.0),
            kind: Set("link".to_owned()),
            data_json: Set("{}".to_owned()),
        })
        .exec(conn)
        .map_err(|error| error.to_string())?;
        node_inputs::Entity::insert(node_inputs::ActiveModel {
            id: Set("local-input".to_owned()),
            node_id: Set("b".to_owned()),
            port_id: Set("references".to_owned()),
            position: Set(0),
            kind: Set("image".to_owned()),
            origin: Set("local".to_owned()),
            edge_id: Set(None),
            item_id: Set(None),
            asset_id: Set(Some("asset-local".to_owned())),
            text: Set("local".to_owned()),
            meta_json: Set("{}".to_owned()),
            created_at: Set(0),
        })
        .exec(conn)
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .expect("insert relations");

    db.delete_nodes(vec!["b".to_owned()]).expect("delete node");

    let counts = db
        .run(|conn| {
            let edges = edge_rows::Entity::find()
                .count(conn)
                .map_err(|error| error.to_string())?;
            let inputs = node_inputs::Entity::find()
                .count(conn)
                .map_err(|error| error.to_string())?;
            Ok((edges, inputs))
        })
        .expect("count relations");

    assert_eq!(counts, (0, 0));
}

#[test]
fn deleting_a_source_removes_downstream_inputs_and_undo_restores_them() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("text", "Text", "A lake", &[], 0.0, 0.0),
        node("image", "Image", "", &[], 400.0, 0.0),
    ])
    .expect("insert nodes");
    db.save_run(
        ResultBatchInput {
            id: "batch".to_owned(),
            node_id: "text".to_owned(),
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

    db.delete_nodes(vec!["text".to_owned()])
        .expect("delete source");
    let after = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(after.inputs.len(), 0);
    assert_eq!(db.edge_count().expect("edges"), 0);

    db.undo().expect("undo delete");
    let restored = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(restored.inputs.len(), 1);
    assert_eq!(db.edge_count().expect("edges after undo"), 1);

    db.redo().expect("redo delete");
    let after_redo = db
        .node_detail("image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(after_redo.inputs.len(), 0);
    assert_eq!(db.edge_count().expect("edges after redo"), 0);
}

#[test]
fn undoing_a_node_insert_cleans_edge_inputs_on_survivors() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "before", &[], 0.0, 0.0)])
        .expect("insert a");
    db.insert_nodes(vec![node("t", "T", "", &[], 400.0, 0.0)])
        .expect("insert t");
    test_asset(&db, "asset-local-t");
    db.add_input(InputItemInput {
        id: "local-t".to_owned(),
        node_id: "t".to_owned(),
        port_id: "out".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some("asset-local-t".to_owned()),
        text: "local".to_owned(),
        meta_json: None,
    })
    .expect("add a local input");
    db.set_manual_text(
        "a".to_owned(),
        "A output".to_owned(),
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
        ResultItemInput {
            id: "item-a".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "A output".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual output");
    connect(&db, "a-t", "a", "t");
    db.save_run(
        ResultBatchInput {
            id: "batch-t".to_owned(),
            node_id: "t".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-text".to_owned(),
            model: "mock-text".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-t".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "T output".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run t");

    // The run invalidated the connect entry, so undoing the manual output
    // and then the insert is the path that must clean T's snapshot.
    db.undo().expect("undo the manual output");
    let undone = db.undo().expect("undo the insert");
    assert!(
        undone.changed.iter().any(|row| row.id == "t"),
        "the survivor's touched summary is in the change set"
    );
    assert_eq!(db.get_node("a".to_owned()).expect("get a"), None);
    let target = db
        .node_detail("t".to_owned())
        .expect("detail")
        .expect("t detail");
    let input_ids: Vec<&str> = target
        .inputs
        .iter()
        .map(|input| input.id.as_str())
        .collect();
    assert_eq!(
        input_ids,
        ["local-t"],
        "only the deleted node's edge snapshot is removed; local inputs survive"
    );
}

#[test]
fn tags_are_stored_in_canonical_newline_form() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node(
        "tagged",
        "Tagged",
        "",
        &[" alpha ", "", "beta\ngamma"],
        0.0,
        0.0,
    )])
    .expect("insert");
    let tags = db
        .run(|conn| {
            node_rows::Entity::find()
                .filter(node_rows::Column::Id.eq("tagged"))
                .one(conn)
                .map(|row| row.map(|row| row.tags))
                .map_err(|error| error.to_string())
        })
        .expect("read tags")
        .expect("tagged node");
    assert_eq!(tags, "alpha\nbeta\ngamma");
    let hits = db
        .search("gamma".to_owned(), SearchFilters::default(), 20)
        .expect("search a tag");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "tagged");
}

#[test]
fn deleting_the_last_node_cascades_its_edges() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert nodes");
    db.insert_edges(vec![EdgeInput {
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
    }])
    .expect("insert edge");
    assert_eq!(db.edge_count().expect("edge count"), 1);
    assert!(!db.is_empty().expect("populated document"));

    db.run(|conn| {
        node_rows::Entity::delete_many()
            .exec(conn)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .expect("delete nodes");

    assert_eq!(db.count().expect("node count"), 0);
    assert_eq!(
        db.edge_count()
            .expect("edge count after deleting both nodes"),
        0,
        "sea-orm enables foreign keys, so the edge relation's Cascade removes the edge"
    );
    // `has_edges` stays in `is_empty` as defense in depth: if foreign
    // keys or the edge schema stop cascading, this assertion fails and
    // the edge-only branch must be proven again rather than dropped.
    assert!(
        db.is_empty().expect("empty after the cascade"),
        "the document is empty only after both nodes and their edge are gone"
    );
}

#[test]
fn set_node_bounds_change_set_shape_matches_baseline() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![NodeInput {
        id: "styled".to_owned(),
        kind: "image".to_owned(),
        title: "Styled".to_owned(),
        body: "Body".to_owned(),
        tags: vec!["alpha".to_owned(), "β".to_owned()],
        x: 10.0,
        y: 20.0,
        width: 200.0,
        height: 84.0,
        z: 3.5,
        data_json: Some("{\"prompt\":\"a cat\"}".to_owned()),
        settings_json: Some("{\"model\":\"m1\"}".to_owned()),
    }])
    .expect("insert");
    db.save_run(
        ResultBatchInput {
            id: "batch-1".to_owned(),
            node_id: "styled".to_owned(),
            trigger: "run".to_owned(),
            provider: "test".to_owned(),
            model: "m1".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![ResultItemInput {
            id: "item-1".to_owned(),
            position: 0.0,
            port_id: "out".to_owned(),
            kind: "text".to_owned(),
            text: "Result text".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("save run");

    let before = db
        .get_node("styled".to_owned())
        .expect("read before")
        .expect("the node exists");
    let document_rev = db
        .scene(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 1_000.0,
                height: 1_000.0,
            },
            0.0,
            viewport::NODE_LIMIT,
        )
        .expect("before scene")
        .rev;
    let read_stored = || {
        db.run(|conn| {
            node_rows::Entity::find()
                .filter(node_rows::Column::Id.eq("styled"))
                .one(conn)
                .map_err(|error| error.to_string())
        })
        .expect("read stored row")
        .expect("the stored row exists")
    };
    let before_row = read_stored();

    let target = NodeBounds {
        id: "styled".to_owned(),
        x: 100.0,
        y: 200.0,
        width: 300.0,
        height: 120.0,
    };
    let result = db
        .set_node_bounds(vec![target.clone()])
        .expect("move bounds");

    assert_eq!(result.changes.rev, document_rev + 1.0);
    assert_eq!(result.changes.changed.len(), 1);
    let mut expected = before.clone();
    expected.x = target.x;
    expected.y = target.y;
    expected.width = target.width;
    expected.height = target.height;
    expected.rev = before.rev + 1.0;
    assert_eq!(
        result.changes.changed[0], expected,
        "every non-geometry summary field is carried through"
    );

    let [
        HistoryOp::NodeGeometry {
            id,
            x,
            y,
            width,
            height,
        },
    ] = result.forward.as_slice()
    else {
        panic!("one forward NodeGeometry op, got {:?}", result.forward);
    };
    assert_eq!(id.as_str(), "styled");
    assert_eq!(
        (*x, *y, *width, *height),
        (target.x, target.y, target.width, target.height)
    );
    let [
        HistoryOp::NodeGeometry {
            id,
            x,
            y,
            width,
            height,
        },
    ] = result.inverse.as_slice()
    else {
        panic!("one inverse NodeGeometry op, got {:?}", result.inverse);
    };
    assert_eq!(id.as_str(), "styled");
    assert_eq!(
        (*x, *y, *width, *height),
        (before.x, before.y, before.width, before.height)
    );

    let after_row = read_stored();
    assert_eq!(after_row.tags, before_row.tags);
    assert_eq!(after_row.tags, "alpha\nβ");
    assert_eq!(after_row.kind, before_row.kind);
    assert_eq!(after_row.seq, before_row.seq);
    assert_eq!(after_row.created_at, before_row.created_at);
    assert_eq!(after_row.data_json, before_row.data_json);
    assert_eq!(after_row.settings_json, before_row.settings_json);
    assert_eq!(after_row.status, "done");
    assert_eq!(after_row.output_batch_id.as_deref(), Some("batch-1"));
    assert_eq!(
        (after_row.x, after_row.y, after_row.width, after_row.height),
        (target.x, target.y, target.width, target.height)
    );
    assert_eq!(after_row.rev, before_row.rev + 1);
    assert!(after_row.updated_at >= before_row.updated_at);

    let undone = db.undo().expect("undo bounds");
    assert_eq!(undone.changed.len(), 1);
    assert_eq!(undone.rev, result.changes.rev + 1.0);
    assert_eq!(undone.changed[0].rev, before.rev + 2.0);
    assert_eq!(
        (
            undone.changed[0].x,
            undone.changed[0].y,
            undone.changed[0].width,
            undone.changed[0].height
        ),
        (before.x, before.y, before.width, before.height)
    );
    assert_eq!(undone.changed[0].status, before.status);
    assert_eq!(undone.changed[0].output_batch_id, before.output_batch_id);
    let undone_row = read_stored();
    assert_eq!(undone_row.rev, before_row.rev + 2);
    assert!(undone_row.updated_at >= after_row.updated_at);

    let redone = db.redo().expect("redo bounds");
    assert_eq!(redone.changed.len(), 1);
    assert_eq!(redone.rev, undone.rev + 1.0);
    assert_eq!(redone.changed[0].rev, before.rev + 3.0);
    assert_eq!(
        (
            redone.changed[0].x,
            redone.changed[0].y,
            redone.changed[0].width,
            redone.changed[0].height
        ),
        (target.x, target.y, target.width, target.height)
    );
    assert_eq!(redone.changed[0].status, before.status);
    assert_eq!(redone.changed[0].output_batch_id, before.output_batch_id);
    let redone_row = read_stored();
    assert_eq!(redone_row.rev, before_row.rev + 3);
    assert!(redone_row.updated_at >= undone_row.updated_at);
}
