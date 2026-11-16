//! Search queries and the FTS index across writes and undo.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`. The module name shadows the production `crate::search`;
//! tests that need it spell the full path.

use super::*;

#[test]
fn short_terms_all_match_in_a_mixed_query() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node(
            "a",
            "Generator",
            "AI image generation",
            &["image"],
            0.0,
            0.0,
        ),
        node("b", "图像生成器", "把文本变成图片", &["设计"], 300.0, 0.0),
    ])
    .expect("insert");

    let english = db
        .search("AI image".to_owned(), SearchFilters::default(), 20)
        .expect("mixed short query");
    assert_eq!(english.len(), 1);
    assert_eq!(english[0].id, "a");

    let chinese = db
        .search("图像 生成".to_owned(), SearchFilters::default(), 20)
        .expect("mixed CJK query");
    assert_eq!(chinese.len(), 1);
    assert_eq!(chinese[0].id, "b");

    assert!(
        db.search("AI missing".to_owned(), SearchFilters::default(), 20)
            .expect("all terms required")
            .is_empty()
    );
    assert!(
        db.search("image".to_owned(), SearchFilters::default(), 0)
            .expect("zero limit")
            .is_empty()
    );
}

#[test]
fn updates_searchable_text_and_undoes_the_index_change() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node(
        "a",
        "Old title",
        "Body text",
        &["old"],
        0.0,
        0.0,
    )])
    .expect("insert");

    let changed = db
        .set_node_text(
            "a".to_owned(),
            "New title".to_owned(),
            vec!["new".to_owned()],
        )
        .expect("set text");
    assert_eq!(changed.changes.changed[0].title, "New title");
    assert_eq!(
        changed.changes.changed[0].body, "Body text",
        "a title/tags edit leaves the output-derived body alone"
    );
    assert_eq!(
        db.search("New title".to_owned(), SearchFilters::default(), 20)
            .expect("new search")
            .len(),
        1
    );
    assert!(
        db.search("Old title".to_owned(), SearchFilters::default(), 20)
            .expect("old search")
            .is_empty()
    );
    assert_eq!(
        db.search("Body text".to_owned(), SearchFilters::default(), 20)
            .expect("body search")
            .len(),
        1,
        "the untouched body stays searchable"
    );

    db.undo().expect("undo text");
    assert_eq!(
        db.search("Old title".to_owned(), SearchFilters::default(), 20)
            .expect("restored search")
            .len(),
        1
    );
    assert!(
        db.search("New title".to_owned(), SearchFilters::default(), 20)
            .expect("new title removed")
            .is_empty()
    );
    assert_eq!(
        db.search("Body text".to_owned(), SearchFilters::default(), 20)
            .expect("body search after undo")
            .len(),
        1
    );
    db.redo().expect("redo text");
    assert!(
        db.search("Old title".to_owned(), SearchFilters::default(), 20)
            .expect("removed again")
            .is_empty()
    );
}

#[test]
fn short_cjk_queries_use_the_like_fallback() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node(
        "a",
        "图像生成器",
        "把文本变成图片",
        &["设计", "生成"],
        0.0,
        0.0,
    )])
    .expect("insert");

    // Two characters cannot be indexed by the trigram tokenizer; each
    // searchable field falls back to the bounded LIKE scan.
    for query in ["图像", "图片", "设计"] {
        let hits = db
            .search(query.to_owned(), SearchFilters::default(), 20)
            .expect("short search");
        assert_eq!(hits.len(), 1, "query {query}");
    }

    let hits = db
        .search("生成器".to_owned(), SearchFilters::default(), 20)
        .expect("trigram search");
    assert_eq!(hits.len(), 1);

    let text = db
        .search(
            "图像".to_owned(),
            SearchFilters {
                kind: Some("text".to_owned()),
            },
            20,
        )
        .expect("filtered search");
    assert_eq!(text.len(), 1);
    assert!(
        db.search(
            "图像".to_owned(),
            SearchFilters {
                kind: Some("image".to_owned()),
            },
            20,
        )
        .expect("filter miss")
        .is_empty()
    );
}

#[test]
fn bodies_written_by_manual_edits_and_runs_are_searchable() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("text", "Panel", "Before", &[], 0.0, 0.0)])
        .expect("insert");

    db.set_manual_text(
        "text".to_owned(),
        "Orchid petals".to_owned(),
        ResultBatchInput {
            id: "batch-manual".to_owned(),
            node_id: "text".to_owned(),
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
            text: "Orchid petals".to_owned(),
            asset_id: None,
            meta_json: None,
        },
    )
    .expect("manual edit");
    assert_eq!(
        db.search("Orchid".to_owned(), SearchFilters::default(), 20)
            .expect("manual search")
            .len(),
        1
    );
    assert!(
        db.search("Before".to_owned(), SearchFilters::default(), 20)
            .expect("old body search")
            .is_empty()
    );

    db.save_run(
        ResultBatchInput {
            id: "batch-run".to_owned(),
            node_id: "text".to_owned(),
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
            text: "Marigold fields".to_owned(),
            asset_id: None,
            meta_json: None,
        }],
    )
    .expect("run");
    assert_eq!(
        db.search("Marigold".to_owned(), SearchFilters::default(), 20)
            .expect("run search")
            .len(),
        1
    );
    assert!(
        db.search("Orchid".to_owned(), SearchFilters::default(), 20)
            .expect("replaced body search")
            .is_empty()
    );
}

#[test]
fn a_mixed_search_indexes_long_terms_and_filters_short_ones() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("both", "AI image generator", "", &[], 0.0, 0.0),
        node("long", "image generator", "", &[], 0.0, 0.0),
        node("short", "AI image", "", &[], 0.0, 0.0),
    ])
    .expect("insert");

    // "generator" uses the trigram index; "AI" is too short for it and is
    // checked against the title, body and tags after the match.
    let hits = db
        .search("AI generator".to_owned(), SearchFilters::default(), 20)
        .expect("mixed search");
    let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(ids, ["both"]);
}

#[test]
fn a_mixed_search_applies_every_short_term() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![
        node("all", "generator a b c d e f g h z", "", &[], 0.0, 0.0),
        node("missing-z", "generator a b c d e f g h", "", &[], 0.0, 0.0),
    ])
    .expect("insert");

    // Nine short terms plus one long one: the mixed path must apply all
    // of them, not the all-short fallback's first eight.
    let hits = db
        .search(
            "generator a b c d e f g h z".to_owned(),
            SearchFilters::default(),
            20,
        )
        .expect("mixed search");
    let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(ids, ["all"]);
}

#[test]
fn an_all_short_search_applies_at_most_eight_terms() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("eight", "a b c d e f g h", "", &[], 0.0, 0.0)])
        .expect("insert");

    // The ninth short term is past the fallback's cap and is ignored; a
    // query applying it would find nothing.
    let hits = db
        .search("a b c d e f g h z".to_owned(), SearchFilters::default(), 20)
        .expect("short search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "eight");
}
