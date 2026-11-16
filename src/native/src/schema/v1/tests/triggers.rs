use super::*;

#[test]
fn edge_boxes_matches_the_rust_connector_oracle() {
    use crate::edge_index::connection_bounds;
    use crate::types::EdgePoint;

    let conn = memory();
    create(&conn, "Geometry").expect("create v1");
    let nodes = [
        ("a", 0.0, 0.0, 200.0, 80.0),
        ("b", 900.0, 140.0, 200.0, 80.0),
        ("c", 120.0, 40.0, 160.0, 60.0),
        ("d", -300.0, -100.0, 200.0, 80.0),
        ("e", 5_000.0, 0.0, 200.0, 80.0),
    ];
    for (id, x, y, width, height) in nodes {
        execute(
            &conn,
            "INSERT INTO nodes \
             (id, kind, title, x, y, width, height, z, created_at, updated_at) \
             VALUES (?1, 'text', ?1, ?2, ?3, ?4, ?5, 0, 0, 0)",
            vec![id.into(), x.into(), y.into(), width.into(), height.into()],
        )
        .expect("insert node");
    }

    let geometry = |id: &str| {
        let (_, x, y, width, height) = nodes
            .iter()
            .find(|node| node.0 == id)
            .expect("node geometry");
        (*x, *y, *width, *height)
    };
    let edges = [
        ("forward", "a", "b", 20.0, 30.0),
        ("backward", "b", "a", 10.0, 40.0),
        ("short", "c", "a", 5.0, 10.0),
        ("floor", "a", "c", 20.0, 0.0),
        ("far", "a", "e", 0.0, 0.0),
        ("negative", "d", "c", 75.0, 55.0),
    ];
    for (id, from, to, from_offset, to_offset) in edges {
        execute(
            &conn,
            "INSERT INTO edges \
             (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
             VALUES (?1, ?2, ?3, 'out', 'in', 'text', ?4, ?5)",
            vec![
                id.into(),
                from.into(),
                to.into(),
                from_offset.into(),
                to_offset.into(),
            ],
        )
        .expect("insert edge");

        let row = query_one(
            &conn,
            "SELECT b.min_x, b.max_x, b.min_y, b.max_y \
             FROM edge_boxes AS b JOIN edges AS e ON e.seq = b.id \
             WHERE e.id = ?1",
            vec![id.into()],
        )
        .expect("edge box");
        let sql = [
            row.try_get_by_index::<f64>(0).expect("min_x"),
            row.try_get_by_index::<f64>(1).expect("max_x"),
            row.try_get_by_index::<f64>(2).expect("min_y"),
            row.try_get_by_index::<f64>(3).expect("max_y"),
        ];

        let (from_x, from_y, from_width, _) = geometry(from);
        let (to_x, to_y, _, _) = geometry(to);
        let oracle = connection_bounds(
            EdgePoint {
                x: from_x + from_width,
                y: from_y + from_offset,
            },
            EdgePoint {
                x: to_x,
                y: to_y + to_offset,
            },
        );
        assert_eq!(
            sql,
            [oracle.0, oracle.1, oracle.2, oracle.3],
            "edge {id} must match the Rust oracle"
        );
    }

    // Pin the port-centre and stroke-padding formula itself, not only
    // agreement with the oracle.
    let forward = query_one(
        &conn,
        "SELECT b.min_x, b.max_x, b.min_y, b.max_y \
         FROM edge_boxes AS b JOIN edges AS e ON e.seq = b.id \
         WHERE e.id = 'forward'",
        vec![],
    )
    .expect("forward box");
    assert_eq!(
        [
            forward.try_get_by_index::<f64>(0).expect("min_x"),
            forward.try_get_by_index::<f64>(1).expect("max_x"),
            forward.try_get_by_index::<f64>(2).expect("min_y"),
            forward.try_get_by_index::<f64>(3).expect("max_y"),
        ],
        [210.0, 890.0, 16.0, 174.0]
    );

    // A raw reach below 60 must be lifted to the floor.
    let floor = query_one(
        &conn,
        "SELECT b.min_x, b.max_x, b.min_y, b.max_y \
         FROM edge_boxes AS b JOIN edges AS e ON e.seq = b.id \
         WHERE e.id = 'floor'",
        vec![],
    )
    .expect("floor box");
    assert_eq!(
        [
            floor.try_get_by_index::<f64>(0).expect("min_x"),
            floor.try_get_by_index::<f64>(1).expect("max_x"),
            floor.try_get_by_index::<f64>(2).expect("min_y"),
            floor.try_get_by_index::<f64>(3).expect("max_y"),
        ],
        [42.0, 278.0, 16.0, 44.0]
    );
}

#[test]
fn trigger_maintenance_updates_counts_indexes_and_cascades() {
    let conn = memory();
    create(&conn, "Triggers").expect("create v1");
    insert_node(&conn, "n1", "alpha");
    insert_node(&conn, "n2", "beta");
    assert_eq!(count(&conn, "SELECT node_count FROM document"), 2);
    assert_eq!(count(&conn, "SELECT count(*) FROM nodes_rtree"), 2);
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
        ),
        1
    );

    insert_edge(&conn, "e1", "n1", "n2");
    assert_eq!(count(&conn, "SELECT edge_count FROM document"), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM edges_rtree"), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM edge_boxes"), 1);

    exec(&conn, "UPDATE nodes SET title = 'gamma' WHERE id = 'n1'");
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
        ),
        0
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'gamma'"
        ),
        1
    );

    let node_box_before = query_one(
        &conn,
        "SELECT min_x, max_x FROM nodes_rtree \
         WHERE id = (SELECT seq FROM nodes WHERE id = 'n1')",
        vec![],
    )
    .expect("read node box");
    let before_min_x: f64 = node_box_before.try_get_by_index(0).expect("min_x");
    let before_max_x: f64 = node_box_before.try_get_by_index(1).expect("max_x");
    exec(&conn, "UPDATE nodes SET x = 50 WHERE id = 'n1'");
    let node_box_after = query_one(
        &conn,
        "SELECT min_x, max_x FROM nodes_rtree \
         WHERE id = (SELECT seq FROM nodes WHERE id = 'n1')",
        vec![],
    )
    .expect("read the moved node box");
    let after_min_x: f64 = node_box_after.try_get_by_index(0).expect("min_x");
    let after_max_x: f64 = node_box_after.try_get_by_index(1).expect("max_x");
    assert_ne!((before_min_x, before_max_x), (after_min_x, after_max_x));
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_geometry_dirty WHERE node_id = 'n1'"
        ),
        1
    );

    let edge_box_before = query_one(
        &conn,
        "SELECT min_y, max_y FROM edges_rtree \
         WHERE id = (SELECT seq FROM edges WHERE id = 'e1')",
        vec![],
    )
    .expect("read edge box");
    let before_min_y: f64 = edge_box_before.try_get_by_index(0).expect("min_y");
    let before_max_y: f64 = edge_box_before.try_get_by_index(1).expect("max_y");
    exec(&conn, "UPDATE edges SET from_offset = 10 WHERE id = 'e1'");
    let edge_box_after = query_one(
        &conn,
        "SELECT min_y, max_y FROM edges_rtree \
         WHERE id = (SELECT seq FROM edges WHERE id = 'e1')",
        vec![],
    )
    .expect("read the moved edge box");
    let after_min_y: f64 = edge_box_after.try_get_by_index(0).expect("min_y");
    let after_max_y: f64 = edge_box_after.try_get_by_index(1).expect("max_y");
    assert_ne!((before_min_y, before_max_y), (after_min_y, after_max_y));

    exec(&conn, "DELETE FROM nodes WHERE id = 'n1'");
    assert_eq!(count(&conn, "SELECT node_count FROM document"), 1);
    assert_eq!(count(&conn, "SELECT edge_count FROM document"), 0);
    assert_eq!(count(&conn, "SELECT count(*) FROM nodes_rtree"), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM edges_rtree"), 0);
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
        ),
        0
    );
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'beta'"
        ),
        1
    );
}
