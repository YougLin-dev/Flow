//! Preview reads for result batches and their items.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn preview_items_stay_bounded_without_losing_total_count() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        // A node with no output has no current batch to preview.
        node("empty", "Empty", "", &[], 0.0, 0.0),
        node("single", "Single", "", &[], 300.0, 0.0),
        node("six", "Six", "", &[], 600.0, 0.0),
    ])
    .expect("insert preview nodes");

    preview_run(
        &db,
        "single",
        "preview-single",
        vec![preview_item("single-0".to_owned(), 0, None)],
    );
    preview_run(
        &db,
        "six",
        "preview-six",
        (0..6)
            .map(|position| preview_item(format!("six-{position}"), position, None))
            .collect(),
    );
    // v1 refuses to settle a `done` batch with no items, so a node with
    // an output always has something to preview.
    let empty_done = db.save_run(
        ResultBatchInput {
            id: "preview-empty".to_owned(),
            node_id: "empty".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-image".to_owned(),
            model: "mock-image".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        Vec::new(),
    );
    assert!(empty_done.is_err(), "a done batch needs an item");

    let ids = vec!["empty".to_owned(), "single".to_owned(), "six".to_owned()];
    let previews = db.previews(ids.clone()).expect("previews");
    let reference = db
        .run(move |conn| detail::previews_reference(conn, ids))
        .expect("reference previews");
    assert_eq!(previews, reference);
    assert!(
        previews.iter().all(|preview| preview.node_id != "empty"),
        "a node without an output has no preview"
    );

    let by_node = |id: &str| {
        previews
            .iter()
            .find(|preview| preview.node_id == id)
            .unwrap_or_else(|| panic!("missing {id} preview"))
    };
    let single = by_node("single");
    assert_eq!(single.item_count, 1.0);
    assert_eq!(single.items.len(), 1);
    let six = by_node("six");
    assert_eq!(
        six.item_count, 6.0,
        "the count is the full batch, not the preview cap"
    );
    assert_eq!(six.items.len(), 4, "a preview carries at most four items");
    let returned: Vec<&str> = six.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(returned, vec!["six-0", "six-1", "six-2", "six-3"]);
}

#[test]
fn preview_items_order_by_position_with_an_id_tiebreak() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("ordered", "Ordered", "", &[], 0.0, 0.0)])
        .expect("insert preview node");
    preview_run(
        &db,
        "ordered",
        "preview-ordered",
        vec![
            preview_item("b".to_owned(), 2, None),
            preview_item("a".to_owned(), 1, None),
            preview_item("z".to_owned(), 0, None),
            preview_item("c".to_owned(), 3, None),
        ],
    );

    let ids = vec!["ordered".to_owned()];
    let previews = db.previews(ids.clone()).expect("previews");
    let reference = db
        .run(move |conn| detail::previews_reference(conn, ids))
        .expect("reference previews");
    assert_eq!(previews, reference);
    let ordered = &previews[0];
    assert_eq!(ordered.item_count, 4.0);
    let returned: Vec<&str> = ordered.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(returned, vec!["z", "a", "b", "c"], "position order");

    // v1 makes positions unique per `(batch, port)`, so stored ties
    // cannot occur; the query still names id as the deterministic
    // tiebreak.
    let (sql, _) = detail::preview_items_statement(&["batch".to_owned()])
        .build(sea_orm::sea_query::SqliteQueryBuilder);
    let upper = sql.to_ascii_uppercase();
    assert!(upper.contains("ORDER BY \"BATCH_ID\" ASC"), "{sql}");
    assert!(upper.contains("\"POSITION\" ASC"), "{sql}");
    assert!(upper.contains("\"ID\" ASC"), "{sql}");
}

#[test]
fn previews_batch_chunks_and_share_assets() {
    let db = Database::open(":memory:").expect("open");
    db.import_asset(AssetInput {
        id: "shared-asset".to_owned(),
        kind: "image".to_owned(),
        name: "shared.png".to_owned(),
        mime: "image/png".to_owned(),
        bytes: benchmark_png(0),
        meta_json: None,
    })
    .expect("import shared asset");

    // 401 ids cross the 400-id chunk boundary once; every batch shares one
    // asset, so a per-node asset query would repeat the same read 401 times.
    let mut nodes = Vec::with_capacity(401);
    for index in 0..401usize {
        let mut preview = node(
            &format!("preview-node-{index}"),
            "Preview",
            "",
            &[],
            index as f64 * 240.0,
            0.0,
        );
        preview.kind = "image".to_owned();
        nodes.push(preview);
    }
    db.insert_nodes(nodes).expect("insert preview nodes");
    for index in 0..401usize {
        preview_run(
            &db,
            &format!("preview-node-{index}"),
            &format!("preview-batch-{index}"),
            (0..4)
                .map(|position| {
                    preview_item(
                        format!("preview-item-{index}-{position}"),
                        position,
                        Some("shared-asset"),
                    )
                })
                .collect(),
        );
    }

    let ids: Vec<String> = (0..401)
        .map(|index| format!("preview-node-{index}"))
        .collect();
    let previews = db.previews(ids.clone()).expect("previews");
    let reference = db
        .run({
            let ids = ids.clone();
            move |conn| detail::previews_reference(conn, ids)
        })
        .expect("reference previews");
    assert_eq!(previews, reference);
    assert_eq!(previews.len(), 401, "no requested preview crosses a chunk");
    for preview in &previews {
        assert_eq!(preview.item_count, 4.0, "{} count", preview.node_id);
        assert_eq!(preview.items.len(), 4, "{} items", preview.node_id);
        for item in &preview.items {
            assert_eq!(item.asset_id.as_deref(), Some("shared-asset"));
            assert!(item.asset.is_some(), "{} shared asset", item.id);
        }
    }
}

#[test]
fn previews_keep_the_old_node_and_item_summaries() {
    let db = Database::open(":memory:").expect("open");
    db.import_asset(AssetInput {
        id: "shared-asset".to_owned(),
        kind: "image".to_owned(),
        name: "shared.png".to_owned(),
        mime: "image/png".to_owned(),
        bytes: benchmark_png(0),
        meta_json: None,
    })
    .expect("import shared asset");
    db.import_asset(AssetInput {
        id: "other-asset".to_owned(),
        kind: "image".to_owned(),
        name: "other.png".to_owned(),
        mime: "image/png".to_owned(),
        bytes: benchmark_png(1),
        meta_json: None,
    })
    .expect("import second asset");
    let mut first = node("image-a", "Image A", "", &[], 0.0, 0.0);
    first.kind = "image".to_owned();
    let mut second = node("image-b", "Image B", "", &[], 400.0, 0.0);
    second.kind = "image".to_owned();
    db.insert_nodes(vec![first, second])
        .expect("insert preview nodes");
    preview_run(
        &db,
        "image-a",
        "batch-a",
        vec![
            preview_item("a-0".to_owned(), 0, Some("shared-asset")),
            preview_item("a-1".to_owned(), 1, Some("other-asset")),
            preview_item("a-2".to_owned(), 2, None),
            preview_item("a-3".to_owned(), 3, Some("shared-asset")),
        ],
    );
    preview_run(
        &db,
        "image-b",
        "batch-b",
        vec![
            preview_item("b-0".to_owned(), 0, Some("shared-asset")),
            preview_item("b-1".to_owned(), 1, Some("other-asset")),
        ],
    );

    let ids = vec!["image-a".to_owned(), "image-b".to_owned()];
    let previews = db.previews(ids.clone()).expect("previews");
    let reference = db
        .run(move |conn| detail::previews_reference(conn, ids))
        .expect("reference previews");
    assert_eq!(previews, reference);

    let a = previews
        .iter()
        .find(|preview| preview.node_id == "image-a")
        .expect("image-a preview");
    assert_eq!(a.item_count, 4.0);
    assert_eq!(a.items.len(), 4);
    assert_eq!(a.items[0].asset_id.as_deref(), Some("shared-asset"));
    assert!(a.items[0].asset.is_some());
    assert_eq!(a.items[1].asset_id.as_deref(), Some("other-asset"));
    assert!(a.items[1].asset.is_some());
    assert!(a.items[2].asset.is_none(), "an item without an asset id");
    assert_eq!(a.items[3].asset_id.as_deref(), Some("shared-asset"));
    assert!(
        a.items[3].asset.is_some(),
        "a repeated asset still resolves"
    );

    // v1 refuses an item whose asset row does not exist, so a preview can
    // never meet the missing-asset case this test used to model.
    let missing = db.save_run(
        ResultBatchInput {
            id: "batch-missing".to_owned(),
            node_id: "image-a".to_owned(),
            trigger: "run".to_owned(),
            provider: "mock-image".to_owned(),
            model: "mock-image".to_owned(),
            params_json: "{}".to_owned(),
            status: "done".to_owned(),
            error: None,
        },
        vec![preview_item("missing".to_owned(), 0, Some("missing-asset"))],
    );
    assert!(missing.is_err(), "a missing asset row must be refused");

    let b = previews
        .iter()
        .find(|preview| preview.node_id == "image-b")
        .expect("image-b preview");
    assert_eq!(b.item_count, 2.0);
    assert_eq!(b.items.len(), 2);
    assert_eq!(b.items[1].asset_id.as_deref(), Some("other-asset"));
    assert!(b.items[1].asset.is_some());
}

#[test]
fn preview_query_caps_rows_in_the_outer_window_query() {
    use sea_orm::sea_query::SqliteQueryBuilder;

    let statement = detail::preview_items_statement(&["batch-id".to_owned()]);
    let (sql, values) = statement.build(SqliteQueryBuilder);
    let upper = sql.to_ascii_uppercase();
    assert!(upper.contains("ROW_NUMBER()"), "{sql}");
    assert!(upper.contains("OVER"), "{sql}");
    assert!(upper.contains("PARTITION BY"), "{sql}");
    assert_eq!(
        upper.matches("ROW_NUMBER()").count(),
        1,
        "one window ranks the whole chunk: {sql}"
    );
    assert!(
        sql.contains("\"preview_row_number\" <= ?"),
        "the cap is an outer bound value, not an interpolated id: {sql}"
    );
    assert_eq!(
        sql.matches('?').count(),
        2,
        "the batch id and cap stay bound values: {sql}"
    );
    assert!(
        !sql.contains("batch-id"),
        "batch ids never enter the statement text: {sql}"
    );
    assert_eq!(values.0.len(), 2, "one id list and the cap are bound");
}
