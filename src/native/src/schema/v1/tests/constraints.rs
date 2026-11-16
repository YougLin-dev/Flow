use super::*;

#[test]
fn schema_checks_are_enforced() {
    let conn = memory();
    exec(&conn, MIGRATION_1);
    let now = crate::clock::now_ms();
    let bad_id = execute(
        &conn,
        "INSERT INTO document (id, project_id, created_at, updated_at) \
         VALUES (1, 'short', ?1, ?1)",
        vec![now.into()],
    );
    assert!(bad_id.is_err(), "short project_id must fail");

    let bad_title = execute(
        &conn,
        "INSERT INTO document (id, project_id, title, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', '', ?1, ?1)",
        vec![now.into()],
    );
    assert!(bad_title.is_err(), "empty title must fail");

    let tab_title = execute(
        &conn,
        "INSERT INTO document (id, project_id, title, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', char(9), ?1, ?1)",
        vec![now.into()],
    );
    assert!(tab_title.is_err(), "whitespace-only title must fail");

    let nul_title = execute(
        &conn,
        "INSERT INTO document (id, project_id, title, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', char(0), ?1, ?1)",
        vec![now.into()],
    );
    assert!(nul_title.is_err(), "NUL title must fail");

    let embedded_nul_title = execute(
        &conn,
        "INSERT INTO document (id, project_id, title, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', 'a' || char(0) || 'b', ?1, ?1)",
        vec![now.into()],
    );
    assert!(embedded_nul_title.is_err(), "embedded NUL title must fail");

    let bad_camera = execute(
        &conn,
        "INSERT INTO document (id, project_id, camera_zoom, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', 0, ?1, ?1)",
        vec![now.into()],
    );
    assert!(bad_camera.is_err(), "non-positive camera_zoom must fail");

    let wide_camera = execute(
        &conn,
        "INSERT INTO document (id, project_id, camera_x, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', 1.5e308, ?1, ?1)",
        vec![now.into()],
    );
    assert!(
        wide_camera.is_err(),
        "camera_x outside the envelope must fail"
    );

    let infinite_camera = execute(
        &conn,
        "INSERT INTO document (id, project_id, camera_zoom, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', 9e999, ?1, ?1)",
        vec![now.into()],
    );
    assert!(infinite_camera.is_err(), "infinite camera_zoom must fail");

    execute(
        &conn,
        "INSERT INTO document (id, project_id, created_at, updated_at) \
         VALUES (1, '0123456789abcdef0123456789abcdef', ?1, ?1)",
        vec![now.into()],
    )
    .expect("insert a valid document");
    let bad_update = execute(
        &conn,
        "UPDATE document SET camera_zoom = 0 WHERE id = 1",
        vec![],
    );
    assert!(bad_update.is_err(), "camera_zoom update must fail");
}

#[test]
fn guard_rechecks_a_tampered_document_row() {
    let conn = memory();
    create(&conn, "Tamper").expect("create v1");

    exec(&conn, "PRAGMA ignore_check_constraints = ON");
    exec(&conn, "UPDATE document SET title = '' WHERE id = 1");
    exec(&conn, "PRAGMA ignore_check_constraints = OFF");
    let error = inspect(&conn).expect_err("empty title must be refused");
    assert_eq!(error, "the Flow database has an empty title");

    exec(&conn, "PRAGMA ignore_check_constraints = ON");
    exec(&conn, "UPDATE document SET title = char(9) WHERE id = 1");
    exec(&conn, "PRAGMA ignore_check_constraints = OFF");
    let error = inspect(&conn).expect_err("tab-only title must be refused");
    assert_eq!(error, "the Flow database has an empty title");

    exec(&conn, "PRAGMA ignore_check_constraints = ON");
    exec(&conn, "UPDATE document SET title = char(0) WHERE id = 1");
    exec(&conn, "PRAGMA ignore_check_constraints = OFF");
    let error = inspect(&conn).expect_err("NUL title must be refused");
    assert_eq!(error, "the Flow database has an invalid title");

    exec(&conn, "UPDATE document SET title = 'Restored' WHERE id = 1");
    exec(&conn, "PRAGMA ignore_check_constraints = ON");
    exec(
        &conn,
        "UPDATE document SET camera_zoom = 9e999 WHERE id = 1",
    );
    exec(&conn, "PRAGMA ignore_check_constraints = OFF");
    let error = inspect(&conn).expect_err("infinite camera must be refused");
    assert_eq!(error, "the Flow database has an invalid camera");

    exec(&conn, "PRAGMA ignore_check_constraints = ON");
    exec(&conn, "UPDATE document SET camera_x = 1.5e308 WHERE id = 1");
    exec(&conn, "PRAGMA ignore_check_constraints = OFF");
    let error = inspect(&conn).expect_err("camera outside the envelope must be refused");
    assert_eq!(error, "the Flow database has an invalid camera");

    exec(
        &conn,
        "UPDATE document SET camera_x = 0.0, camera_zoom = 1.0 WHERE id = 1",
    );
}

#[test]
fn validate_document_rejects_invalid_identity_title_and_camera() {
    let valid_id = "0123456789abcdef0123456789abcdef".to_owned();
    let valid = || validate_document(valid_id.clone(), "Title".to_owned(), 0.0, 0.0, 1.0);
    assert!(valid().is_ok());

    for project_id in [
        "short".to_owned(),
        "ABCDEF0123456789ABCDEF0123456789".to_owned(),
        "0123456789abcdef0123456789abcde-".to_owned(),
    ] {
        let error = validate_document(project_id, "Title".to_owned(), 0.0, 0.0, 1.0)
            .expect_err("invalid project_id must be refused");
        assert_eq!(error, "the Flow database has an invalid project_id");
    }

    for title in ["", " ", "\t\n", "\r"] {
        let error = validate_document(valid_id.clone(), title.to_owned(), 0.0, 0.0, 1.0)
            .expect_err("blank title must be refused");
        assert_eq!(error, "the Flow database has an empty title");
    }
    for title in ["\0", "a\0", "\0b"] {
        let error = validate_document(valid_id.clone(), title.to_owned(), 0.0, 0.0, 1.0)
            .expect_err("NUL title must be refused");
        assert_eq!(error, "the Flow database has an invalid title");
    }

    for (x, y, zoom) in [
        (1.5e308, 0.0, 1.0),
        (0.0, -1.5e308, 1.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, f64::INFINITY),
        (f64::INFINITY, 0.0, 1.0),
    ] {
        let error = validate_document(valid_id.clone(), "Title".to_owned(), x, y, zoom)
            .expect_err("invalid camera must be refused");
        assert_eq!(error, "the Flow database has an invalid camera");
    }
}

#[test]
fn document_is_immutable_in_the_expected_ways() {
    let conn = memory();
    let project = create(&conn, "Immutable").expect("create v1");
    let delete = execute(&conn, "DELETE FROM document", vec![]);
    assert!(delete.is_err(), "document delete must fail");
    let replace = execute(
        &conn,
        "INSERT OR REPLACE INTO document (id, project_id, created_at, updated_at) \
         VALUES (1, 'ffffffffffffffffffffffffffffffff', 0, 0)",
        vec![],
    );
    assert!(replace.is_err(), "document REPLACE must fail");
    let stored: String = query_one(
        &conn,
        "SELECT project_id FROM document WHERE id = 1",
        vec![],
    )
    .expect("read project_id")
    .try_get_by_index(0)
    .expect("project_id");
    assert_eq!(stored, project.project_id);
    let update = execute(
        &conn,
        "UPDATE document SET project_id = 'ffffffffffffffffffffffffffffffff'",
        vec![],
    );
    assert!(update.is_err(), "project_id update must fail");
}

#[test]
fn replace_cannot_bypass_node_or_edge_checks() {
    let conn = memory();
    create(&conn, "Replace").expect("create v1");
    insert_node(&conn, "n1", "alpha");
    insert_node(&conn, "n2", "beta");
    insert_edge(&conn, "e1", "n1", "n2");

    let node_by_id = execute(
        &conn,
        "INSERT OR REPLACE INTO nodes (id, kind, x, y, width, height, z, created_at, updated_at) \
         VALUES ('n1', 'text', 0, 0, 100, 50, 0, 0, 0)",
        vec![],
    );
    assert!(node_by_id.is_err(), "REPLACE by node id must fail");

    let node_by_seq = execute(
        &conn,
        "INSERT OR REPLACE INTO nodes \
         (seq, id, kind, title, x, y, width, height, z, created_at, updated_at) \
         SELECT seq, 'z', kind, 'zulu', x, y, width, height, z, created_at, updated_at \
         FROM nodes WHERE id = 'n1'",
        vec![],
    );
    assert!(node_by_seq.is_err(), "REPLACE by node seq must fail");
    assert_eq!(count(&conn, "SELECT node_count FROM document"), 2);
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'alpha'"
        ),
        1
    );

    let edge_by_seq = execute(
        &conn,
        "INSERT OR REPLACE INTO edges \
         (seq, id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         SELECT seq, 'z', from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset \
         FROM edges WHERE id = 'e1'",
        vec![],
    );
    assert!(edge_by_seq.is_err(), "REPLACE by edge seq must fail");
    assert_eq!(count(&conn, "SELECT edge_count FROM document"), 1);

    let edge_by_pair = execute(
        &conn,
        "INSERT OR REPLACE INTO edges \
         (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES ('e-replace', 'n1', 'n2', 'out', 'in', 'text', 0, 0)",
        vec![],
    );
    assert!(edge_by_pair.is_err(), "REPLACE by edge port pair must fail");
    assert_eq!(count(&conn, "SELECT edge_count FROM document"), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM edges_rtree"), 1);

    let node_identity = execute(
        &conn,
        "UPDATE nodes SET id = 'renamed' WHERE id = 'n1'",
        vec![],
    );
    assert!(node_identity.is_err(), "node id update must fail");
    let node_seq_identity = execute(&conn, "UPDATE nodes SET seq = 999 WHERE id = 'n1'", vec![]);
    assert!(node_seq_identity.is_err(), "node seq update must fail");
    let edge_identity = execute(&conn, "UPDATE edges SET seq = 999 WHERE id = 'e1'", vec![]);
    assert!(edge_identity.is_err(), "edge seq update must fail");
    let edge_id_identity = execute(
        &conn,
        "UPDATE edges SET id = 'renamed' WHERE id = 'e1'",
        vec![],
    );
    assert!(edge_id_identity.is_err(), "edge id update must fail");

    insert_node(&conn, "n3", "three");
    insert_node(&conn, "n4", "four");
    insert_edge(&conn, "e2", "n1", "n3");
    insert_edge(&conn, "e3", "n4", "n2");
    execute(
        &conn,
        "INSERT INTO edges \
         (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES ('e4', 'n1', 'n2', 'out2', 'in', 'text', 0, 0)",
        vec![],
    )
    .expect("insert a distinct port pair");
    execute(
        &conn,
        "INSERT INTO edges \
         (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES ('e5', 'n1', 'n2', 'out', 'in2', 'text', 0, 0)",
        vec![],
    )
    .expect("insert a distinct to-port pair");
    let duplicate_update = execute(
        &conn,
        "UPDATE edges SET to_id = 'n2' WHERE id = 'e2'",
        vec![],
    );
    assert!(duplicate_update.is_err(), "duplicate pair update must fail");
    let replace_update = execute(
        &conn,
        "UPDATE OR REPLACE edges SET to_id = 'n2' WHERE id = 'e2'",
        vec![],
    );
    assert!(
        replace_update.is_err(),
        "UPDATE OR REPLACE duplicate must fail"
    );
    let duplicate_from_id = execute(
        &conn,
        "UPDATE OR REPLACE edges SET from_id = 'n1' WHERE id = 'e3'",
        vec![],
    );
    assert!(
        duplicate_from_id.is_err(),
        "duplicate pair by from_id must fail"
    );
    let duplicate_from_port = execute(
        &conn,
        "UPDATE OR REPLACE edges SET from_port = 'out' WHERE id = 'e4'",
        vec![],
    );
    assert!(
        duplicate_from_port.is_err(),
        "duplicate pair by from_port must fail"
    );
    let duplicate_to_port = execute(
        &conn,
        "UPDATE OR REPLACE edges SET to_port = 'in' WHERE id = 'e5'",
        vec![],
    );
    assert!(
        duplicate_to_port.is_err(),
        "duplicate pair by to_port must fail"
    );
    assert_eq!(count(&conn, "SELECT edge_count FROM document"), 5);
}

#[test]
fn duplicate_edge_port_pair_is_rejected() {
    let conn = memory();
    create(&conn, "Unique edge").expect("create v1");
    insert_node(&conn, "n1", "one");
    insert_node(&conn, "n2", "two");
    insert_edge(&conn, "e1", "n1", "n2");
    let duplicate = execute(
        &conn,
        "INSERT INTO edges (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES ('e2', 'n1', 'n2', 'out', 'in', 'text', 0, 0)",
        vec![],
    );
    assert!(duplicate.is_err(), "duplicate port pair must fail");
}
