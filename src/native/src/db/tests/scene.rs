//! Scene, viewport, overview and edge-index reads.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows the production `crate::scene`;
//! tests that need it spell the full path.

use super::*;

#[test]
fn overview_reads_every_card_and_the_document_bounds() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 100.0, 50.0),
        node("b", "B", "", &[], 700.0, 400.0),
    ])
    .expect("insert");

    let overview = db.overview().expect("overview");
    assert_eq!(
        (
            overview.bounds.x,
            overview.bounds.y,
            overview.bounds.width,
            overview.bounds.height
        ),
        (100.0, 50.0, 800.0, 434.0)
    );
    assert!(overview.rev > 0.0);
    let mut ids: Vec<&str> = overview.cards.iter().map(|card| card.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec!["a", "b"]);
    let card = overview
        .cards
        .iter()
        .find(|card| card.id == "b")
        .expect("card b");
    assert_eq!(
        (card.x, card.y, card.width, card.height),
        (700.0, 400.0, 200.0, 84.0)
    );
}

#[test]
fn overview_sample_stays_capped_on_a_large_document() {
    let db = Database::open(":memory:").expect("open");
    let nodes: Vec<NodeInput> = (0..crate::scene::OVERVIEW_LIMIT + 5)
        .map(|index| {
            let mut input = node(
                &format!("n{index}"),
                "Card",
                "",
                &[],
                index as f64 * 10.0,
                0.0,
            );
            // A raised card must not crowd the sample: order comes from
            // the insertion hash, not from stacking or row order.
            input.z = index as f64;
            input
        })
        .collect();
    db.insert_nodes(nodes).expect("insert");

    let overview = db.overview().expect("overview");
    assert_eq!(overview.cards.len() as u64, crate::scene::OVERVIEW_LIMIT);
    let unique: std::collections::BTreeSet<&str> =
        overview.cards.iter().map(|card| card.id.as_str()).collect();
    assert_eq!(unique.len(), overview.cards.len());
}

#[test]
fn overview_sample_is_neither_the_first_nor_the_top_cards() {
    let db = Database::open(":memory:").expect("open");
    let nodes: Vec<NodeInput> = (0..40)
        .map(|index| {
            let mut input = node(
                &format!("n{index:02}"),
                "Card",
                "",
                &[],
                index as f64 * 10.0,
                0.0,
            );
            input.z = index as f64;
            input
        })
        .collect();
    db.insert_nodes(nodes).expect("insert");

    // The private read with a small cap: the full `overview()` cap is 400
    // and this fixture is smaller.
    let cards = db
        .run(|conn| viewport::overview_cards(conn, 40, 10))
        .expect("sample");
    assert_eq!(cards.len(), 10);
    let mut sampled: Vec<String> = cards.iter().map(|card| card.id.clone()).collect();
    sampled.sort_unstable();
    let first: Vec<String> = (0..10).map(|index| format!("n{index:02}")).collect();
    let top: Vec<String> = (30..40).map(|index| format!("n{index:02}")).collect();
    assert_ne!(sampled, first);
    assert_ne!(sampled, top);
}

#[test]
fn viewport_prefers_nodes_inside_the_rect_over_the_margin() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a-margin", "Margin", "", &[], -250.0, 10.0),
        node("z-inside", "Inside", "", &[], 10.0, 10.0),
    ])
    .expect("insert");

    let nodes = db
        .viewport(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            300.0,
        )
        .expect("viewport");

    // `a-margin` sorts first by id, but only intersects the prefetch
    // margin; the card budget must see the visible node first.
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].id, "z-inside");
}

#[test]
fn the_in_view_order_uses_exact_geometry_not_the_padded_cell() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        // Its padded RTree cell reaches into the rect, and its low z
        // would outrank the visible card under the old cell-based CASE.
        {
            let mut margin = node("margin", "Margin", "", &[], 101.0, 10.0);
            margin.z = -1.0;
            margin
        },
        node("visible", "Visible", "", &[], 10.0, 10.0),
    ])
    .expect("insert");

    let scene = db
        .scene(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            300.0,
            1,
        )
        .expect("one-card scene");
    assert_eq!(scene.nodes.len(), 1);
    assert_eq!(scene.nodes[0].id, "visible");
}

#[test]
fn viewport_rechecks_exact_geometry_after_the_rtree() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        // The padded RTree cell reaches one unit into the rect; the card
        // itself starts one unit past it.
        node("past-right", "Right", "", &[], 101.0, 10.0),
        // A true edge that touches the rect boundary is inside.
        node("touching", "Touch", "", &[], -200.0, 10.0),
        node("inside", "Inside", "", &[], 10.0, 10.0),
    ])
    .expect("insert");

    let nodes = db
        .viewport(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            0.0,
        )
        .expect("viewport");
    let ids: BTreeSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    assert_eq!(ids, BTreeSet::from(["inside", "touching"]));
}

#[test]
fn a_viewport_read_reports_truncation_from_its_extra_row() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "A", "", &[], 10.0, 10.0),
        node("b", "B", "", &[], 60.0, 10.0),
        node("c", "C", "", &[], 110.0, 10.0),
    ])
    .expect("insert");
    let rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 100.0,
    };

    let capped_rect = rect.clone();
    let capped = db
        .run(move |conn| viewport::viewport_read(conn, capped_rect, 0.0, 2))
        .expect("capped read");
    assert_eq!(capped.nodes.len(), 2);
    assert!(capped.truncated, "the third card fell outside the budget");

    let complete = db
        .run(move |conn| viewport::viewport_read(conn, rect, 0.0, 3))
        .expect("complete read");
    assert_eq!(complete.nodes.len(), 3);
    assert!(
        !complete.truncated,
        "a read that fills its budget exactly is complete"
    );
}

#[test]
fn two_phase_scene_matches_the_single_statement_reference() {
    let db = Database::open(":memory:").expect("open");
    let dense: Vec<NodeInput> = (0..12)
        .map(|i| {
            let mut input = node(
                &format!("dense-{i:02}"),
                &format!("Dense {i}"),
                "",
                &[],
                (i % 4) as f64 * 210.0,
                (i / 4) as f64 * 130.0,
            );
            input.z = (i % 3) as f64;
            input
        })
        .collect();
    db.insert_nodes(dense).expect("insert dense nodes");

    let rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 800.0,
        height: 600.0,
    };
    let snapshot = db.scene(rect.clone(), 0.0, 5).expect("two-phase scene");
    // Run the legacy single statement on the same worker/connection so
    // the RTree and every ordering input are identical.
    let reference = db
        .run(move |conn| {
            let statement = viewport::viewport_statement_reference(rect, 0.0, 5);
            viewport::rows_from_statement(conn, &statement)
        })
        .expect("legacy reference read");

    assert_eq!(snapshot.nodes.len(), 5);
    assert_eq!(reference.len(), 5);
    let scene_rows: Vec<(&str, f64, f64)> = snapshot
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.z, node.rev))
        .collect();
    let reference_rows: Vec<(&str, f64, f64)> = reference
        .iter()
        .map(|node| (node.id.as_str(), node.z, node.rev))
        .collect();
    let scene_ids: Vec<&str> = scene_rows.iter().map(|row| row.0).collect();
    let reference_ids: Vec<&str> = reference_rows.iter().map(|row| row.0).collect();
    assert_eq!(
        scene_rows, reference_rows,
        "two-phase order {scene_ids:?} differs from the single statement {reference_ids:?}"
    );
}

#[test]
fn a_scene_reads_the_far_port_of_an_edge_to_an_off_screen_card() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("a", "Near", "", &[], 0.0, 0.0),
        node("far", "Far", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    db.connect_edge(EdgeInput {
        id: "a-far".to_owned(),
        from_id: "a".to_owned(),
        to_id: "far".to_owned(),
        from_port: "out".to_owned(),
        to_port: "in".to_owned(),
        port_kind: "text".to_owned(),
        from_offset: 42.0,
        to_offset: 42.0,
        kind: "flow".to_owned(),
        data_json: None,
    })
    .expect("connect");

    let scene = db
        .scene(
            Viewport {
                x: 0.0,
                y: 0.0,
                width: 400.0,
                height: 300.0,
            },
            0.0,
            viewport::NODE_LIMIT,
        )
        .expect("scene");

    // The far card is outside the read; its port still travels with the
    // edge so the near card's connector can be drawn to it.
    assert_eq!(scene.nodes.len(), 1);
    assert_eq!(scene.nodes[0].id, "a");
    assert_eq!(scene.edges.len(), 1);
    let edge = &scene.edges[0];
    assert_eq!(edge.from_point, Some(EdgePoint { x: 200.0, y: 42.0 }));
    assert_eq!(
        edge.to_point,
        Some(EdgePoint {
            x: 5_000.0,
            y: 42.0
        })
    );
}

#[test]
fn a_scene_reads_a_connector_between_two_off_screen_cards() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    // Both cards are far outside the read; the connector's curve crosses
    // it, so the edge RTree reports it with both endpoint ports.
    let scene = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
    assert!(scene.nodes.is_empty());
    assert_eq!(scene.edges.len(), 1);
    let edge = &scene.edges[0];
    assert_eq!(edge.id, "left-right");
    assert_eq!(
        edge.from_point,
        Some(EdgePoint {
            x: -4_800.0,
            y: 42.0
        })
    );
    assert_eq!(
        edge.to_point,
        Some(EdgePoint {
            x: 5_000.0,
            y: 42.0
        })
    );
}

#[test]
fn a_capped_scene_read_does_not_return_uncrossable_offscreen_connectors() {
    let db = Database::open(":memory:").expect("open");
    let interiors = ["interior-0", "interior-1", "interior-2"];
    let mut inputs = Vec::new();
    for (index, id) in interiors.iter().enumerate() {
        inputs.push(node(id, id, "", &[], 50.0 + index as f64 * 240.0, 50.0));
    }
    // The long connector's cards sit below every in-view card's z, so the
    // in-view-first ordering can never promote one into a one-card sample.
    let mut left = node("left", "Left", "", &[], -5_000.0, 0.0);
    left.z = -1.0;
    let mut right = node("right", "Right", "", &[], 5_000.0, 0.0);
    right.z = -1.0;
    inputs.push(left);
    inputs.push(right);
    db.insert_nodes(inputs).expect("insert");
    // Only left -> right; none of the interior cards touches the long
    // connector.
    connect(&db, "left-right", "left", "right");

    let rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 800.0,
        height: 600.0,
    };

    // The uncapped read still runs the RTree half and finds the crossing.
    let full = db
        .scene(rect.clone(), 0.0, viewport::NODE_LIMIT)
        .expect("uncapped scene");
    assert_eq!(full.nodes.len(), 3);
    assert!(full.edges.iter().all(|edge| edge.id == "left-right"));
    assert!(full.edges.iter().any(|edge| edge.id == "left-right"));

    // One kept card is a capped sample; the RTree half must not add a
    // connector that touches none of the kept cards.
    let one = db.scene(rect.clone(), 0.0, 1).expect("one-card scene");
    assert_eq!(one.nodes.len(), 1);
    assert!(
        interiors.contains(&one.nodes[0].id.as_str()),
        "the kept card was {}",
        one.nodes[0].id
    );
    assert!(!one.edges.iter().any(|edge| edge.id == "left-right"));

    // A complete read that happens to equal the budget is not a sample:
    // the one-row probe found nothing beyond it, so the crossing
    // connector is part of the scene.
    let three = db.scene(rect.clone(), 0.0, 3).expect("three-card scene");
    assert_eq!(three.nodes.len(), 3);
    assert!(three.edges.iter().any(|edge| edge.id == "left-right"));

    // A zero budget is the deliberate empty read: no cards and no
    // crossing half, even when the read itself fits.
    let empty = db.scene(rect, 0.0, 0).expect("empty scene");
    assert!(empty.nodes.is_empty());
    assert!(empty.edges.is_empty());
}

#[test]
fn moving_a_card_moves_its_connector_in_the_edge_index() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    db.move_nodes(vec!["left".to_owned()], 9_000.0, 0.0)
        .expect("move");

    // The old crossing no longer exists; the moved connector is indexed
    // between the cards' new positions.
    assert!(
        scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
            .edges
            .is_empty()
    );
    let scene = scene_between(&db, 4_250.0, 0.0, 400.0, 600.0, viewport::NODE_LIMIT);
    assert!(scene.nodes.is_empty());
    assert_eq!(scene.edges.len(), 1);
    assert_eq!(
        scene.edges[0].from_point,
        Some(EdgePoint {
            x: 4_200.0,
            y: 42.0
        })
    );
}

#[test]
fn deleting_and_undoing_edges_keeps_the_edge_index_in_step() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    db.delete_edges(vec!["left-right".to_owned()])
        .expect("delete edge");
    assert!(
        scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
            .edges
            .is_empty()
    );

    let undone = db.undo().expect("undo delete");
    // The change set itself carries both ports, so the scene redraws the
    // restored connector before the next viewport read arrives.
    assert_eq!(
        undone.edges_changed[0].from_point,
        Some(EdgePoint {
            x: -4_800.0,
            y: 42.0
        })
    );
    assert_eq!(
        undone.edges_changed[0].to_point,
        Some(EdgePoint {
            x: 5_000.0,
            y: 42.0
        })
    );
    assert_eq!(
        scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
            .edges
            .len(),
        1
    );
}

#[test]
fn moving_both_ends_of_a_connector_in_one_command_writes_its_box_once() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    db.set_node_bounds(vec![
        NodeBounds {
            id: "left".to_owned(),
            x: -4_000.0,
            y: 2_000.0,
            width: 200.0,
            height: 84.0,
        },
        NodeBounds {
            id: "right".to_owned(),
            x: 6_000.0,
            y: 2_000.0,
            width: 200.0,
            height: 84.0,
        },
    ])
    .expect("move both ends");

    let scene = db
        .scene(
            Viewport {
                x: -4_000.0,
                y: 1_500.0,
                width: 10_200.0,
                height: 2_000.0,
            },
            2_000.0,
            viewport::NODE_LIMIT,
        )
        .expect("new-region scene");
    let left = scene
        .nodes
        .iter()
        .find(|node| node.id == "left")
        .expect("the moved left card");
    assert_eq!(
        (left.x, left.y, left.width, left.height),
        (-4_000.0, 2_000.0, 200.0, 84.0)
    );
    let right = scene
        .nodes
        .iter()
        .find(|node| node.id == "right")
        .expect("the moved right card");
    assert_eq!(
        (right.x, right.y, right.width, right.height),
        (6_000.0, 2_000.0, 200.0, 84.0)
    );

    let edges: Vec<_> = scene
        .edges
        .iter()
        .filter(|edge| edge.id == "left-right")
        .collect();
    assert_eq!(edges.len(), 1, "the connector is indexed once");
    assert_eq!(
        edges[0].from_point,
        Some(EdgePoint::output(-4_000.0, 2_000.0, 200.0, 42.0))
    );
    assert_eq!(
        edges[0].to_point,
        Some(EdgePoint::input(6_000.0, 2_000.0, 42.0))
    );

    // The old crossing is gone. Margin 0 keeps the moved cards and the
    // connector's new box out of the read.
    let old = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
    assert!(old.nodes.is_empty());
    assert!(old.edges.iter().all(|edge| edge.id != "left-right"));

    // A box between the new left port and the old right port would cross
    // this band; neither the genuine old nor new box does, and no card
    // touches it, so only the index can return the connector.
    let stale_probe = Viewport {
        x: -3_500.0,
        y: 1_000.0,
        width: 500.0,
        height: 300.0,
    };
    let after = db
        .scene(stale_probe, 0.0, viewport::NODE_LIMIT)
        .expect("stale-endpoint probe");
    assert!(after.nodes.is_empty());
    assert!(after.edges.iter().all(|edge| edge.id != "left-right"));
}

#[test]
fn undo_of_a_two_end_move_restores_both_rtree_boxes() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    db.set_node_bounds(vec![
        NodeBounds {
            id: "left".to_owned(),
            x: -4_000.0,
            y: 2_000.0,
            width: 200.0,
            height: 84.0,
        },
        NodeBounds {
            id: "right".to_owned(),
            x: 6_000.0,
            y: 2_000.0,
            width: 200.0,
            height: 84.0,
        },
    ])
    .expect("move both ends");
    db.undo().expect("undo the two-end move");

    let old = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
    assert!(old.nodes.is_empty(), "both original cards are outside");
    assert_eq!(old.edges.len(), 1, "the original box is indexed again");
    assert_eq!(old.edges[0].id, "left-right");
    assert_eq!(
        old.edges[0].from_point,
        Some(EdgePoint::output(-5_000.0, 0.0, 200.0, 42.0))
    );
    assert_eq!(
        old.edges[0].to_point,
        Some(EdgePoint::input(5_000.0, 0.0, 42.0))
    );

    // The new box is gone. Use the new region without its usual margin:
    // margin 2,000 would include the restored connector at y=42.
    let new_region = scene_between(
        &db,
        -4_000.0,
        1_500.0,
        10_200.0,
        2_000.0,
        viewport::NODE_LIMIT,
    );
    assert!(new_region.edges.iter().all(|edge| edge.id != "left-right"));

    let stale_probe = Viewport {
        x: -3_500.0,
        y: 1_000.0,
        width: 500.0,
        height: 300.0,
    };
    let stale = db
        .scene(stale_probe.clone(), 0.0, viewport::NODE_LIMIT)
        .expect("stale-endpoint probe after undo");
    assert!(stale.nodes.is_empty());
    assert!(stale.edges.iter().all(|edge| edge.id != "left-right"));

    db.redo().expect("redo the two-end move");
    let scene = db
        .scene(
            Viewport {
                x: -4_000.0,
                y: 1_500.0,
                width: 10_200.0,
                height: 2_000.0,
            },
            2_000.0,
            viewport::NODE_LIMIT,
        )
        .expect("new-region scene after redo");
    let left = scene
        .nodes
        .iter()
        .find(|node| node.id == "left")
        .expect("the redone left card");
    assert_eq!(
        (left.x, left.y, left.width, left.height),
        (-4_000.0, 2_000.0, 200.0, 84.0)
    );
    let right = scene
        .nodes
        .iter()
        .find(|node| node.id == "right")
        .expect("the redone right card");
    assert_eq!(
        (right.x, right.y, right.width, right.height),
        (6_000.0, 2_000.0, 200.0, 84.0)
    );
    let edges: Vec<_> = scene
        .edges
        .iter()
        .filter(|edge| edge.id == "left-right")
        .collect();
    assert_eq!(edges.len(), 1, "the connector is indexed once after redo");
    assert_eq!(
        edges[0].from_point,
        Some(EdgePoint::output(-4_000.0, 2_000.0, 200.0, 42.0))
    );
    assert_eq!(
        edges[0].to_point,
        Some(EdgePoint::input(6_000.0, 2_000.0, 42.0))
    );

    let old_after_redo = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
    assert!(old_after_redo.nodes.is_empty());
    assert!(
        old_after_redo
            .edges
            .iter()
            .all(|edge| edge.id != "left-right")
    );
    let after = db
        .scene(stale_probe, 0.0, viewport::NODE_LIMIT)
        .expect("stale-endpoint probe after redo");
    assert!(after.nodes.is_empty());
    assert!(after.edges.iter().all(|edge| edge.id != "left-right"));
}

#[test]
fn undoing_a_node_delete_restores_the_connector_index() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("left", "Left", "", &[], -5_000.0, 0.0),
        node("right", "Right", "", &[], 5_000.0, 0.0),
    ])
    .expect("insert");
    connect(&db, "left-right", "left", "right");

    db.delete_nodes(vec!["left".to_owned()]).expect("delete");
    assert!(
        scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT)
            .edges
            .is_empty()
    );

    // Undo restores the node before its edges (the history inverse is
    // reversed again on apply), so the edge insert indexes the curve.
    db.undo().expect("undo delete");
    let scene = scene_between(&db, 0.0, 0.0, 800.0, 600.0, viewport::NODE_LIMIT);
    assert_eq!(scene.edges.len(), 1);
    assert_eq!(
        scene.edges[0].from_point,
        Some(EdgePoint {
            x: -4_800.0,
            y: 42.0
        })
    );
}
