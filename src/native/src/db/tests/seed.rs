//! The document seed command.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn seed_document_writes_the_example_and_only_once() {
    let db = Database::open(":memory:").expect("open");
    // Populate the undo stack on an empty document first: a successful
    // seed must clear it, so undo cannot revive the scratch node or
    // remove the demo.
    db.insert_nodes(vec![node("scratch", "Scratch", "", &[], 0.0, 0.0)])
        .expect("scratch node");
    db.delete_nodes(vec!["scratch".to_owned()])
        .expect("delete the scratch node");
    assert_eq!(db.count().expect("empty again"), 0);
    let changes = db.seed_document(seed_input()).expect("seed");
    assert_eq!(db.count().expect("nodes"), 2);
    assert_eq!(db.edge_count().expect("edges"), 1);
    assert_eq!(changes.edges_changed.len(), 1);
    let text = db
        .node_detail("seed-text".to_owned())
        .expect("detail")
        .expect("text detail");
    assert_eq!(text.node.status, "done");
    assert_eq!(text.node.body, "A calm lake.");
    assert_eq!(text.batch.expect("batch").items[0].text, "A calm lake.");
    let image = db
        .node_detail("seed-image".to_owned())
        .expect("detail")
        .expect("image detail");
    assert_eq!(image.inputs.len(), 1);
    assert_eq!(image.inputs[0].item_id.as_deref(), Some("seed-item"));
    let info = db.project_info().expect("project info");
    assert!(info.demo_seeded);
    assert_eq!((info.node_count, info.edge_count), (2.0, 1.0));

    // The seed is not undo history.
    assert!(db.undo().expect("undo after seed").changed.is_empty());

    // A second seed is a no-op even after the user deletes every node,
    // and it leaves the delete undoable: only a new project or a reset
    // seeds again.
    db.delete_nodes(vec!["seed-text".to_owned(), "seed-image".to_owned()])
        .expect("delete the demo");
    assert_eq!(db.count().expect("empty nodes"), 0);
    let second = db.seed_document(seed_input()).expect("second seed");
    assert!(second.changed.is_empty());
    assert_eq!(db.count().expect("still empty"), 0);
    let undone = db.undo().expect("undo the delete after a no-op seed");
    let restored: BTreeSet<&str> = undone.changed.iter().map(|node| node.id.as_str()).collect();
    assert!(
        restored.contains("seed-text") && restored.contains("seed-image"),
        "the no-op seed kept the delete undoable"
    );
    assert_eq!(db.count().expect("the demo is back"), 2);
}

#[test]
fn seed_document_refuses_a_non_empty_document_and_rolls_back() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("existing", "Existing", "", &[], 0.0, 0.0)])
        .expect("insert");
    let error = db
        .seed_document(seed_input())
        .expect_err("a non-empty document must be refused");
    assert!(error.contains("not empty"), "{error}");
    assert_eq!(db.count().expect("count"), 1);

    let db = Database::open(":memory:").expect("open");
    let mut input = seed_input();
    input.edges[0].to_id = "missing".to_owned();
    let error = db
        .seed_document(input)
        .expect_err("an edge to a missing node must fail");
    assert!(error.contains("missing"), "{error}");
    assert_eq!(db.count().expect("rolled back nodes"), 0);
    assert_eq!(db.edge_count().expect("rolled back edges"), 0);
    assert!(!db.project_info().expect("project info").demo_seeded);
}
