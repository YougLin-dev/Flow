//! Integrity checks and rebuilds after drift.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows `crate::db::verify` after the
//! production split; tests that need it spell the full path.

use super::*;

#[test]
fn verify_stops_at_the_entry_when_a_close_is_pending() {
    let db = Database::open(":memory:").expect("open");
    let error = db
        .run(|conn| verify_connection(conn, || true))
        .expect_err("a pending close aborts the recovery check");
    assert!(error.contains("closing"), "{error}");
}

#[test]
fn a_close_request_skips_a_queued_verify_and_leaves_it_pending() {
    let (path, database) = temp_database("verify-skip");
    {
        let db = Database::open(&database).expect("open");
        db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
            .expect("insert");
        // Drop without close: the package is due for recovery.
    }
    {
        let db = Database::open(&database).expect("reopen");
        assert!(!db.project_info().expect("info").opened_clean);
        db.closing.store(true, Ordering::SeqCst);
        let error = db
            .verify()
            .expect_err("the close gate skips the queued check");
        assert!(error.contains("closed"), "{error}");
        db.close().expect("close after the skipped check");
    }
    {
        let db = Database::open(&database).expect("reopen after close");
        assert!(
            !db.project_info().expect("info").opened_clean,
            "a skipped verify keeps the recovery pending"
        );
        db.verify().expect("complete the recovery check");
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn verify_stops_between_phases_and_rolls_the_repair_back() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.insert_edges(vec![edge("a-b", "a", "b")])
        .expect("connect");
    let seq = edge_seq(&db, "a-b");
    let before = min_x_of(&db, "edges_rtree", seq);
    // A direct geometry write records the dirty connector but does not
    // run the command's flush, so the edge box still holds the old curve.
    direct_write(&db, "UPDATE nodes SET x = x + 400 WHERE id = 'a'");
    assert_eq!(min_x_of(&db, "edges_rtree", seq), before);
    let error = db
        .run(|conn| {
            let calls = std::cell::Cell::new(0u32);
            // Stop after the transaction's geometry flush has run with a
            // repair phase still to go: the rollback must undo the flush.
            verify_connection(conn, || {
                let next = calls.get() + 1;
                calls.set(next);
                next >= 6
            })
        })
        .expect_err("a close between phases aborts the repair");
    assert!(error.contains("closing"), "{error}");
    assert_eq!(
        min_x_of(&db, "edges_rtree", seq),
        before,
        "the aborted transaction rolled the flush back"
    );
    let dirty = db
        .run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes_geometry_dirty".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the dirty count");
    assert!(dirty > 0, "the flush still has work to do");

    db.verify().expect("the next verify finishes the repair");
    assert!(
        (min_x_of(&db, "edges_rtree", seq) - before).abs() > 50.0,
        "the completed flush updates the edge box"
    );
}

#[test]
fn verify_accepts_a_healthy_package() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.verify().expect("a healthy package passes verification");
}

#[test]
fn verify_rejects_an_orphan_input_row() {
    let db = Database::open(":memory:").expect("open");
    test_asset(&db, "asset-orphan");
    db.run(|conn| {
            conn.execute_unprepared("PRAGMA foreign_keys = OFF")
                .map_err(|error| error.to_string())?;
            let inserted = conn.execute_unprepared(
                "INSERT INTO node_inputs \
                 (id, node_id, position, port_id, kind, origin, asset_id, text, meta_json, created_at) \
                 VALUES ('orphan', 'missing', 0, 'references', 'image', 'local', \
                         'asset-orphan', '', '{}', 0)",
            );
            conn.execute_unprepared("PRAGMA foreign_keys = ON")
                .map_err(|error| error.to_string())?;
            inserted.map(|_| ()).map_err(|error| error.to_string())
        })
        .expect("insert an orphan input with foreign keys off");
    let error = db.verify().expect_err("verify must report the orphan row");
    assert!(error.contains("foreign-key"), "{error}");
}

#[test]
fn verify_rebuilds_a_drifted_fts_index() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node(
        "a",
        "Alpha",
        "searchable body",
        &["tag"],
        0.0,
        0.0,
    )])
    .expect("insert");
    let seq = node_seq(&db, "a");
    // Remove the index entry without the trigger that mirrors nodes.
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "INSERT INTO nodes_fts(nodes_fts, rowid, title, body, tags) \
                 VALUES('delete', ?, ?, ?, ?)",
            [
                seq.into(),
                "Alpha".into(),
                "searchable body".into(),
                "tag".into(),
            ],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("desync the index");
    assert!(
        db.search("searchable".to_owned(), SearchFilters::default(), 20)
            .expect("search the missing row")
            .is_empty(),
        "the index lost the node"
    );

    db.verify().expect("verify rebuilds the index");
    let hits = db
        .search("searchable".to_owned(), SearchFilters::default(), 20)
        .expect("search after verify");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "a");
}

#[test]
fn verify_rebuilds_a_missing_node_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 10.0, 20.0)])
        .expect("insert");
    let seq = node_seq(&db, "a");
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "DELETE FROM nodes_rtree WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("remove the box");
    let rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 400.0,
    };
    assert!(
        db.viewport(rect.clone(), 0.0).expect("viewport").is_empty(),
        "the missing box hides the node"
    );

    db.verify().expect("verify rebuilds the node index");
    assert_eq!(
        db.viewport(rect, 0.0).expect("viewport after verify").len(),
        1
    );
}

#[test]
fn verify_rebuilds_a_stale_node_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 10.0, 20.0)])
        .expect("insert");
    let seq = node_seq(&db, "a");
    let min_x = |db: &Database| {
        db.run(move |conn| {
            conn.query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DbBackend::Sqlite,
                "SELECT min_x FROM nodes_rtree WHERE id = ?",
                [seq.into()],
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the box row is missing".to_owned())?
            .try_get_by_index::<f64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("read the box")
    };
    assert!((min_x(&db) - 8.0).abs() < 0.01);
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "UPDATE nodes_rtree \
                    SET min_x = min_x + 1000, max_x = max_x + 1000 \
                  WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("move the box away from the node");
    assert!(
        (min_x(&db) - 8.0).abs() > 100.0,
        "the box no longer matches the node"
    );

    db.verify().expect("verify rebuilds a stale box");
    assert!((min_x(&db) - 8.0).abs() < 0.01);
}

#[test]
fn verify_rebuilds_a_stale_edge_box() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
    db.insert_edges(vec![edge("a-b", "a", "b")])
        .expect("connect");
    // The view and the RTree key on `edges.seq`, not the connector id.
    let seq = edge_seq(&db, "a-b");
    let expected = min_x_of(&db, "edge_boxes", seq);
    db.run(move |conn| {
        conn.execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Sqlite,
            "UPDATE edges_rtree SET min_x = min_x + 1000, max_x = max_x + 1000 \
                  WHERE id = ?",
            [seq.into()],
        ))
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("move the edge box away");
    let stale = min_x_of(&db, "edges_rtree", seq);
    assert!((stale - expected).abs() > 100.0);

    db.verify().expect("verify rebuilds the edge box");
    let repaired = min_x_of(&db, "edges_rtree", seq);
    assert!((repaired - expected).abs() < 0.01);
}

#[test]
fn verify_accepts_rtree_cells_at_the_world_limits() {
    let db = Database::open(":memory:").expect("open");
    // The quarter-unit offsets are not representable in a 32-bit RTree
    // cell, so the stored cells genuinely round outward at these
    // magnitudes. Exact coordinates would make the parity delta zero and
    // leave the tolerance untested.
    db.insert_nodes(vec![
        node("a", "A", "", &[], 9_999_000.25, -9_999_000.25),
        node("b", "B", "", &[], -9_999_000.25, 9_999_000.25),
        node("c", "C", "", &[], 0.125, -0.375),
        node("d", "D", "", &[], 8_388_000.75, -8_388_000.75),
    ])
    .expect("insert at the world limits");
    let mut across = edge("limit-edge", "a", "b");
    across.from_offset = 42.3;
    across.to_offset = 42.7;
    db.insert_edges(vec![across])
        .expect("connect across the world");
    db.verify()
        .expect("legitimate 32-bit cells pass the parity tolerance");
}

#[test]
fn verify_clears_leftover_geometry_markers() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 300.0, 0.0),
    ])
    .expect("insert");
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
    .expect("connect");
    db.run(|conn| {
        conn.execute_unprepared("INSERT INTO nodes_geometry_dirty (node_id) VALUES ('a')")
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .expect("leave a marker behind");
    let markers = |db: &Database| {
        db.run(|conn| {
            conn.query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT count(*) FROM nodes_geometry_dirty".to_owned(),
            ))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the marker count returned no row".to_owned())?
            .try_get_by_index::<i64>(0)
            .map_err(|error| error.to_string())
        })
        .expect("count markers")
    };
    assert_eq!(markers(&db), 1);

    db.verify().expect("verify flushes the markers");
    assert_eq!(markers(&db), 0);
}

#[test]
fn verify_tightens_the_bounds_without_bumping_the_revision() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 0.0, 0.0),
        node("b", "B", "", &[], 5000.0, 5000.0),
    ])
    .expect("insert");
    db.delete_nodes(vec!["b".to_owned()]).expect("delete");
    let loose = db.bounds().expect("bounds after delete");
    assert!(
        loose.width > 200.0,
        "a delete leaves the conservative envelope"
    );
    let rev = current_rev(&db);

    db.verify().expect("verify compacts the bounds");
    let exact = db.bounds().expect("bounds after verify");
    assert_eq!(
        (exact.x, exact.y, exact.width, exact.height),
        (0.0, 0.0, 200.0, 84.0)
    );
    assert_eq!(current_rev(&db), rev, "maintenance is not an undo step");
}
