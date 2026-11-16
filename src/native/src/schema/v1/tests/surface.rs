use super::*;

#[test]
fn v1_shape_has_the_release_indexes_triggers_and_integrity() {
    let conn = memory();
    create(&conn, "Surface").expect("create v1");

    let indexes = objects(&conn, "index");
    for index in [
        "nodes_sample",
        "nodes_running",
        "nodes_output",
        "edges_port_pair",
        "edges_to",
        "result_batches_node",
        "result_batches_latest",
        "result_batches_running",
        "result_items_asset",
        "node_inputs_edge",
        "node_inputs_item",
        "node_inputs_asset",
    ] {
        assert!(indexes.iter().any(|name| name == index), "missing {index}");
    }
    let edge_pair_sql: String = query_one(
        &conn,
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'edges_port_pair'",
        vec![],
    )
    .expect("read edges_port_pair SQL")
    .try_get_by_index(0)
    .expect("edges_port_pair SQL");
    assert!(edge_pair_sql.to_uppercase().contains("UNIQUE"));

    let mut named_indexes = query_all(
        &conn,
        "SELECT name FROM sqlite_master \
         WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
        vec![],
    )
    .into_iter()
    .map(|row| row.try_get_by_index(0).expect("index name"))
    .collect::<Vec<String>>();
    named_indexes.sort();
    assert_eq!(
        named_indexes,
        [
            "edges_port_pair",
            "edges_to",
            "node_inputs_asset",
            "node_inputs_edge",
            "node_inputs_item",
            "nodes_output",
            "nodes_running",
            "nodes_sample",
            "result_batches_latest",
            "result_batches_node",
            "result_batches_running",
            "result_items_asset",
        ]
    );
    let mut required_indexes: Vec<String> = REQUIRED_OBJECTS
        .iter()
        .filter(|(kind, _)| *kind == "index")
        .map(|(_, name)| (*name).to_owned())
        .collect();
    required_indexes.sort();
    assert_eq!(required_indexes, named_indexes);

    let edge_auto_indexes: i64 = count(
        &conn,
        "SELECT count(*) FROM sqlite_master \
         WHERE type = 'index' AND tbl_name = 'edges' AND sql IS NULL",
    );
    assert_eq!(
        edge_auto_indexes, 1,
        "edges must have only the id autoindex"
    );

    for (table, expected) in [
        ("document", 1),
        ("assets", 2),
        ("result_batches", 2),
        ("nodes", 1),
        ("edges", 1),
        ("result_items", 2),
        ("node_inputs", 2),
        ("nodes_geometry_dirty", 1),
    ] {
        let auto_indexes: i64 = count(
            &conn,
            &format!(
                "SELECT count(*) FROM sqlite_master \
                 WHERE type = 'index' AND tbl_name = '{table}' AND sql IS NULL"
            ),
        );
        assert_eq!(auto_indexes, expected, "{table} autoindex count");
    }

    assert_eq!(
        table_definition(&conn, "document"),
        [
            "id|INTEGER|0||1",
            "project_id|TEXT|1||0",
            "title|TEXT|1|'Flow'|0",
            "rev|INTEGER|1|0|0",
            "node_count|INTEGER|1|0|0",
            "edge_count|INTEGER|1|0|0",
            "demo_seeded|INTEGER|1|0|0",
            "clean_shutdown|INTEGER|1|0|0",
            "min_x|REAL|0||0",
            "max_x|REAL|0||0",
            "min_y|REAL|0||0",
            "max_y|REAL|0||0",
            "bounds_exact|INTEGER|1|1|0",
            "camera_x|REAL|1|0.0|0",
            "camera_y|REAL|1|0.0|0",
            "camera_zoom|REAL|1|1.0|0",
            "created_at|INTEGER|1||0",
            "updated_at|INTEGER|1||0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "assets"),
        [
            "id|TEXT|1||1",
            "hash|TEXT|1||0",
            "kind|TEXT|1||0",
            "name|TEXT|1||0",
            "mime|TEXT|1||0",
            "size|INTEGER|1||0",
            "meta_json|TEXT|1|'{}'|0",
            "created_at|INTEGER|1||0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "result_batches"),
        [
            "seq|INTEGER|0||1",
            "id|TEXT|1||0",
            "node_id|TEXT|1||0",
            "node_seq|INTEGER|1||0",
            "trigger|TEXT|1||0",
            "provider|TEXT|1|''|0",
            "model|TEXT|1|''|0",
            "params_json|TEXT|1|'{}'|0",
            "status|TEXT|1||0",
            "error|TEXT|0||0",
            "item_count|INTEGER|1|0|0",
            "created_at|INTEGER|1||0",
            "finished_at|INTEGER|0||0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "nodes"),
        [
            "seq|INTEGER|0||1",
            "id|TEXT|1||0",
            "kind|TEXT|1||0",
            "title|TEXT|1|''|0",
            "body|TEXT|1|''|0",
            "tags|TEXT|1|''|0",
            "x|REAL|1||0",
            "y|REAL|1||0",
            "width|REAL|1||0",
            "height|REAL|1||0",
            "z|REAL|1||0",
            "data_json|TEXT|1|'{}'|0",
            "settings_json|TEXT|1|'{}'|0",
            "status|TEXT|1|'idle'|0",
            "output_batch_id|TEXT|0||0",
            "rev|INTEGER|1|1|0",
            "created_at|INTEGER|1||0",
            "updated_at|INTEGER|1||0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "edges"),
        [
            "seq|INTEGER|0||1",
            "id|TEXT|1||0",
            "from_id|TEXT|1||0",
            "to_id|TEXT|1||0",
            "from_port|TEXT|1||0",
            "to_port|TEXT|1||0",
            "port_kind|TEXT|1||0",
            "from_offset|REAL|1||0",
            "to_offset|REAL|1||0",
            "kind|TEXT|1|'flow'|0",
            "data_json|TEXT|1|'{}'|0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "result_items"),
        [
            "id|TEXT|1||1",
            "batch_id|TEXT|1||0",
            "position|INTEGER|1||0",
            "port_id|TEXT|1||0",
            "kind|TEXT|1||0",
            "text|TEXT|1|''|0",
            "asset_id|TEXT|0||0",
            "meta_json|TEXT|1|'{}'|0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "node_inputs"),
        [
            "id|TEXT|1||1",
            "node_id|TEXT|1||0",
            "port_id|TEXT|1||0",
            "position|INTEGER|1||0",
            "kind|TEXT|1||0",
            "origin|TEXT|1||0",
            "edge_id|TEXT|0||0",
            "item_id|TEXT|0||0",
            "asset_id|TEXT|0||0",
            "text|TEXT|1|''|0",
            "meta_json|TEXT|1|'{}'|0",
            "created_at|INTEGER|1||0",
        ]
    );
    assert_eq!(
        table_definition(&conn, "nodes_geometry_dirty"),
        ["node_id|TEXT|1||1"]
    );

    let running_sql: String = query_one(
        &conn,
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'nodes_running'",
        vec![],
    )
    .expect("read nodes_running SQL")
    .try_get_by_index(0)
    .expect("nodes_running SQL");
    assert!(
        normalize_sql(&running_sql).contains("WHERE status = 'running'"),
        "{running_sql}"
    );
    for (object, fragments) in [
        (
            "nodes_rtree_ai",
            &["NEW.x - 2.0", "NEW.x + NEW.width + 2.0"][..],
        ),
        ("nodes_rtree_au", &["UPDATE OF x, y, width, height"][..]),
        ("nodes_fts_au", &["UPDATE OF title, body, tags"][..]),
        ("nodes_bounds_au", &["bounds_exact"][..]),
        ("nodes_identity_immutable", &["UPDATE OF id, seq"][..]),
        ("edges_identity_immutable", &["UPDATE OF id, seq"][..]),
        (
            "edges_no_duplicate_update",
            &[
                "UPDATE OF from_id, from_port, to_id, to_port",
                "AND from_id = NEW.from_id",
                "AND from_port = NEW.from_port",
                "AND to_id = NEW.to_id",
                "AND to_port = NEW.to_port",
            ][..],
        ),
    ] {
        let sql: String = query_one(
            &conn,
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
            vec![object.to_owned().into()],
        )
        .expect("read trigger SQL")
        .try_get_by_index(0)
        .expect("trigger SQL");
        let sql = normalize_sql(&sql);
        for fragment in fragments.iter().copied() {
            assert!(sql.contains(fragment), "{object} missing {fragment}: {sql}");
        }
    }

    let triggers = objects(&conn, "trigger");
    let expected_triggers = [
        "document_no_delete",
        "document_rev_monotonic",
        "document_project_id_immutable",
        "document_no_replace",
        "nodes_no_replace",
        "nodes_identity_immutable",
        "edges_no_replace",
        "edges_identity_immutable",
        "edges_no_duplicate_update",
        "nodes_rev_monotonic",
        "nodes_output_done_bi",
        "nodes_output_done_bu",
        "result_batches_owner_bi",
        "result_batches_insert_running",
        "result_batches_done_item",
        "result_batches_terminal_immutable",
        "result_batches_running_delete",
        "result_batches_item_count_consistent",
        "result_items_running_only",
        "result_items_no_update",
        "result_items_delete_guard",
        "result_items_count_ai",
        "result_items_count_ad",
        "node_inputs_edge_shape_bi",
        "node_inputs_edge_shape_bu",
        "nodes_count_bounds_ai",
        "nodes_count_bounds_ad",
        "nodes_bounds_au",
        "edges_count_ai",
        "edges_count_ad",
        "nodes_rtree_ai",
        "nodes_rtree_au",
        "nodes_rtree_ad",
        "nodes_geometry_dirty_au",
        "nodes_geometry_dirty_ad",
        "edges_rtree_ai",
        "edges_rtree_au",
        "edges_rtree_ad",
        "nodes_fts_ai",
        "nodes_fts_ad",
        "nodes_fts_au",
    ];
    for trigger in expected_triggers {
        assert!(
            triggers.iter().any(|name| name == trigger),
            "missing {trigger}"
        );
    }
    let mut actual_triggers = triggers;
    actual_triggers.sort();
    let mut expected_triggers: Vec<String> = expected_triggers
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    expected_triggers.sort();
    assert_eq!(actual_triggers, expected_triggers);
    let mut required_triggers: Vec<String> = REQUIRED_OBJECTS
        .iter()
        .filter(|(kind, _)| *kind == "trigger")
        .map(|(_, name)| (*name).to_owned())
        .collect();
    required_triggers.sort();
    assert_eq!(required_triggers, actual_triggers);

    let fts: String = query_one(
        &conn,
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'",
        vec![],
    )
    .expect("read nodes_fts SQL")
    .try_get_by_index(0)
    .expect("nodes_fts SQL");
    let fts = normalize_sql(&fts);
    assert!(fts.contains("content = 'nodes'"), "{fts}");
    assert!(fts.contains("content_rowid = 'seq'"), "{fts}");
    assert!(fts.contains("tokenize = 'trigram'"), "{fts}");

    let view: String = query_one(
        &conn,
        "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'edge_boxes'",
        vec![],
    )
    .expect("read edge_boxes SQL")
    .try_get_by_index(0)
    .expect("edge_boxes SQL");
    let view = normalize_sql(&view);
    for fragment in [
        "f.x + f.width + 14.0",
        "t.x - 14.0",
        "60.0",
        "260.0",
        "- 4.0",
        "+ 4.0",
    ] {
        assert!(
            view.contains(fragment),
            "edge_boxes missing {fragment}: {view}"
        );
    }

    let integrity: String = query_one(&conn, "PRAGMA integrity_check", vec![])
        .expect("integrity_check")
        .try_get_by_index(0)
        .expect("integrity_check value");
    assert_eq!(integrity, "ok");
    let foreign_key_errors = query_all(&conn, "PRAGMA foreign_key_check", vec![]);
    assert_eq!(foreign_key_errors.len(), 0);
}
