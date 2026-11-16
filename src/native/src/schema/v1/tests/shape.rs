use super::*;

#[test]
fn v1_shape_has_the_release_tables_and_columns() {
    let conn = memory();
    create(&conn, "Shape").expect("create v1");

    let digest = {
        let mut hasher = Sha256::new();
        hasher.update(MIGRATION_1.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(
        digest,
        "bba8ca75beab3ced9e0a7079d452dbe5e836a595c0e71a2e32cd1aed7424463d"
    );
    let mut declared = ddl_objects();
    declared.sort();
    let mut required = REQUIRED_OBJECTS.to_vec();
    required.sort();
    assert_eq!(declared, required);

    let tables = objects(&conn, "table");
    for table in [
        "assets",
        "document",
        "edges",
        "edges_rtree",
        "node_inputs",
        "nodes",
        "nodes_fts",
        "nodes_geometry_dirty",
        "nodes_rtree",
        "result_batches",
        "result_items",
    ] {
        assert!(tables.iter().any(|name| name == table), "missing {table}");
    }
    assert!(
        objects(&conn, "view")
            .iter()
            .any(|name| name == "edge_boxes")
    );

    assert_eq!(
        columns(&conn, "document"),
        [
            "id",
            "project_id",
            "title",
            "rev",
            "node_count",
            "edge_count",
            "demo_seeded",
            "clean_shutdown",
            "min_x",
            "max_x",
            "min_y",
            "max_y",
            "bounds_exact",
            "camera_x",
            "camera_y",
            "camera_zoom",
            "created_at",
            "updated_at",
        ]
    );
    assert_eq!(
        columns(&conn, "assets"),
        [
            "id",
            "hash",
            "kind",
            "name",
            "mime",
            "size",
            "meta_json",
            "created_at"
        ]
    );
    assert_eq!(
        columns(&conn, "result_batches"),
        [
            "seq",
            "id",
            "node_id",
            "node_seq",
            "trigger",
            "provider",
            "model",
            "params_json",
            "status",
            "error",
            "item_count",
            "created_at",
            "finished_at",
        ]
    );
    assert_eq!(
        columns(&conn, "nodes"),
        [
            "seq",
            "id",
            "kind",
            "title",
            "body",
            "tags",
            "x",
            "y",
            "width",
            "height",
            "z",
            "data_json",
            "settings_json",
            "status",
            "output_batch_id",
            "rev",
            "created_at",
            "updated_at",
        ]
    );
    assert_eq!(
        columns(&conn, "edges"),
        [
            "seq",
            "id",
            "from_id",
            "to_id",
            "from_port",
            "to_port",
            "port_kind",
            "from_offset",
            "to_offset",
            "kind",
            "data_json",
        ]
    );
    assert_eq!(
        columns(&conn, "result_items"),
        [
            "id",
            "batch_id",
            "position",
            "port_id",
            "kind",
            "text",
            "asset_id",
            "meta_json",
        ]
    );
    assert_eq!(
        columns(&conn, "node_inputs"),
        [
            "id",
            "node_id",
            "port_id",
            "position",
            "kind",
            "origin",
            "edge_id",
            "item_id",
            "asset_id",
            "text",
            "meta_json",
            "created_at",
        ]
    );
    assert_eq!(columns(&conn, "nodes_geometry_dirty"), ["node_id"]);
}
