//! Asset import, bytes and package lifecycle.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn a_referenced_asset_cannot_be_deleted() {
    use crate::entity::assets;
    use sea_orm::ActiveValue::Set;

    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("a", "A", "", &[], 0.0, 0.0)])
        .expect("insert");
    let asset = test_asset(&db, "asset-keep");
    let input_asset = asset.clone();
    db.run(move |conn| {
        node_inputs::Entity::insert(node_inputs::ActiveModel {
            id: Set("local-input".to_owned()),
            node_id: Set("a".to_owned()),
            position: Set(0),
            port_id: Set("references".to_owned()),
            kind: Set("image".to_owned()),
            origin: Set("local".to_owned()),
            edge_id: Set(None),
            item_id: Set(None),
            asset_id: Set(Some(input_asset)),
            text: Set(String::new()),
            meta_json: Set("{}".to_owned()),
            created_at: Set(0),
        })
        .exec(conn)
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .expect("attach the asset to an input");

    let deleted = db.run(move |conn| {
        assets::Entity::delete_by_id(asset)
            .exec(conn)
            .map(|_| ())
            .map_err(|error| error.to_string())
    });
    assert!(
        deleted.is_err(),
        "an asset an input still uses must not be deleted"
    );
}

#[test]
fn an_asset_import_invalidates_history_that_references_the_asset() {
    let db = Database::open(":memory:").expect("open");
    db.insert_nodes(vec![node("n", "N", "", &[], 0.0, 0.0)])
        .expect("insert");
    db.import_asset(AssetInput {
        id: "asset-1".to_owned(),
        kind: "image".to_owned(),
        name: "one.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("import asset");
    db.clear_history().expect("clear setup history");
    db.add_input(InputItemInput {
        id: "input-1".to_owned(),
        node_id: "n".to_owned(),
        port_id: "in".to_owned(),
        kind: "image".to_owned(),
        origin: "local".to_owned(),
        edge_id: None,
        item_id: None,
        asset_id: Some("asset-1".to_owned()),
        text: String::new(),
        meta_json: None,
    })
    .expect("add asset input");

    // The same bytes under a new requested id resolve to the first row
    // and invalidate the entry that references it.
    db.import_asset(AssetInput {
        id: "asset-2".to_owned(),
        kind: "image".to_owned(),
        name: "one-copy.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("re-import the same bytes");

    let undone = db.undo().expect("undo after the asset import");
    assert!(undone.changed.is_empty());
    assert_eq!(
        db.node_detail("n".to_owned())
            .expect("detail")
            .expect("node detail")
            .inputs
            .len(),
        1,
        "the import invalidated the input entry"
    );
}

#[test]
fn reimporting_an_asset_restores_missing_bytes() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");

    std::fs::remove_file(db.assets_dir.join(&first.hash)).expect("remove the stored bytes");
    assert!(db.asset_bytes(first.id.clone()).is_err());

    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("reimport");
    assert_eq!(second.id, first.id);
    assert_eq!(db.asset_bytes(first.id).expect("read back"), bytes);
}

#[test]
fn a_stored_size_mismatch_rejects_the_import_and_does_not_write() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    std::fs::remove_file(db.assets_dir.join(&first.hash)).expect("remove the stored bytes");
    direct_write(&db, "UPDATE assets SET size = 99 WHERE id = 'asset-1'");

    let error = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes,
            meta_json: None,
        })
        .expect_err("a size mismatch must be rejected");
    assert!(error.contains("imported bytes are 6"), "{error}");
    assert!(
        !db.assets_dir.join(&first.hash).exists(),
        "mismatched bytes must not be written"
    );
}

#[test]
fn a_reimport_repairs_a_corrupt_file_and_keeps_the_first_metadata() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    let path = db.assets_dir.join(&first.hash);

    // A same-length corruption is caught by the content hash.
    std::fs::write(&path, b"XXXXXX").expect("tamper the stored bytes");
    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/png".to_owned(),
            bytes: bytes.clone(),
            meta_json: Some("{\"changed\":true}".to_owned()),
        })
        .expect("reimport over same-length corruption");
    assert_eq!(second.id, "asset-1");
    assert_eq!(second.kind, "image");
    assert_eq!(second.name, "one.svg");
    assert_eq!(second.mime, "image/svg+xml");
    assert_eq!(second.meta_json, "{}");
    assert_eq!(second.hash, first.hash);
    assert_eq!(std::fs::read(&path).expect("read the file"), bytes);

    // A truncated file is caught by its size and repaired the same way.
    std::fs::write(&path, b"<sv").expect("truncate the stored bytes");
    db.import_asset(AssetInput {
        id: "asset-3".to_owned(),
        kind: "image".to_owned(),
        name: "three.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: bytes.clone(),
        meta_json: None,
    })
    .expect("reimport over truncation");
    assert_eq!(std::fs::read(&path).expect("read the file"), bytes);
}

#[test]
fn an_in_memory_database_removes_its_temporary_assets_on_drop() {
    let bytes = b"<svg/>".to_vec();
    let dir = {
        let db = Database::open(":memory:").expect("open");
        let asset = db
            .import_asset(AssetInput {
                id: "asset-1".to_owned(),
                kind: "image".to_owned(),
                name: "one.svg".to_owned(),
                mime: "image/svg+xml".to_owned(),
                bytes: bytes.clone(),
                meta_json: None,
            })
            .expect("import");
        let dir = db.assets_dir.to_path_buf();
        let clone = db.clone();
        drop(db);
        assert!(dir.exists(), "a live clone keeps the directory");
        assert_eq!(
            clone.asset_bytes(asset.id).expect("read through the clone"),
            bytes
        );
        drop(clone);
        dir
    };
    assert!(!dir.exists(), "the temporary directory is removed on drop");
}

#[test]
fn a_file_database_keeps_its_assets_after_drop_and_reopen() {
    let dir = std::env::temp_dir().join(format!("flow assets {} {}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).expect("create directory");
    let path = dir.join("flow.db");
    let path = path.to_string_lossy().into_owned();
    let bytes = b"<svg/>".to_vec();

    let (id, hash) = {
        let db = Database::open(&path).expect("open");
        let asset = db
            .import_asset(AssetInput {
                id: "asset-1".to_owned(),
                kind: "image".to_owned(),
                name: "one.svg".to_owned(),
                mime: "image/svg+xml".to_owned(),
                bytes: bytes.clone(),
                meta_json: None,
            })
            .expect("import");
        assert!(db.assets_dir.join(&asset.hash).exists());
        (asset.id, asset.hash)
    };
    let stored = dir.join("assets").join(&hash);
    assert!(
        stored.exists(),
        "a file database must keep its assets directory"
    );
    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(
            db.asset_bytes(id).expect("read after reopen"),
            bytes,
            "the stored bytes survive the close"
        );
    }
    assert!(stored.exists());

    for suffix in ["", "-wal", "-shm"] {
        remove_path_retrying(std::path::Path::new(&format!("{path}{suffix}")));
    }
    remove_path_retrying(&dir);
}

#[test]
fn asset_bytes_rejects_a_malformed_stored_hash() {
    let db = Database::open(":memory:").expect("open");
    db.import_asset(AssetInput {
        id: "asset-1".to_owned(),
        kind: "image".to_owned(),
        name: "one.svg".to_owned(),
        mime: "image/svg+xml".to_owned(),
        bytes: b"<svg/>".to_vec(),
        meta_json: None,
    })
    .expect("import");
    // The v1 CHECK refuses a malformed hash on an ordinary write; bypass
    // it to exercise the read path's own guard.
    direct_write(&db, "PRAGMA ignore_check_constraints = ON");
    direct_write(
        &db,
        "UPDATE assets SET hash = '../escape' WHERE id = 'asset-1'",
    );
    direct_write(&db, "PRAGMA ignore_check_constraints = OFF");

    let error = db
        .asset_bytes("asset-1".to_owned())
        .expect_err("a malformed hash must not be read");
    assert!(error.contains("malformed hash"), "{error}");
}

#[test]
fn asset_bytes_rejects_bytes_that_do_not_match_the_row_size() {
    let db = Database::open(":memory:").expect("open");
    let asset = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: b"<svg/>".to_vec(),
            meta_json: None,
        })
        .expect("import");
    std::fs::write(db.assets_dir.join(&asset.hash), b"a longer file")
        .expect("tamper the stored bytes");

    let error = db
        .asset_bytes(asset.id)
        .expect_err("a file whose size disagrees with its row must be rejected");
    assert!(error.contains("its row says 6"), "{error}");
}

#[test]
fn asset_bytes_rejects_a_same_length_corrupt_file() {
    let db = Database::open(":memory:").expect("open");
    let asset = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: b"<svg/>".to_vec(),
            meta_json: None,
        })
        .expect("import");
    std::fs::write(db.assets_dir.join(&asset.hash), b"broken").expect("tamper the stored bytes");

    let error = db
        .asset_bytes(asset.id)
        .expect_err("a file whose content hash disagrees with its row must be rejected");
    assert!(error.contains("stored hash"), "{error}");
}

#[test]
fn a_failed_insert_returns_and_validates_the_winning_asset() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");

    let assets_dir = Arc::clone(&db.assets_dir);
    let hash = first.hash.clone();
    let import_bytes = bytes.clone();
    let winner = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &hash,
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect("the conflict winner");
    assert_eq!(winner.id, first.id);

    direct_write(&db, "UPDATE assets SET size = 99 WHERE id = 'asset-1'");
    let assets_dir = Arc::clone(&db.assets_dir);
    let hash = first.hash.clone();
    let import_bytes = bytes.clone();
    let error = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &hash,
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect_err("a corrupt winner must be rejected");
    assert!(error.contains("imported bytes are 6"), "{error}");

    let assets_dir = Arc::clone(&db.assets_dir);
    let import_bytes = bytes.clone();
    let error = db
        .run(move |conn| {
            asset::conflict_asset(
                conn,
                &assets_dir,
                &"f".repeat(64),
                &import_bytes,
                sea_orm::DbErr::Custom("the insert failed".to_owned()),
            )
        })
        .expect_err("without a winner the insert error is returned");
    assert!(error.contains("the insert failed"), "{error}");
}

#[test]
fn assets_are_content_addressed_and_read_back() {
    let db = Database::open(":memory:").expect("open");
    let bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
    let first = db
        .import_asset(AssetInput {
            id: "asset-1".to_owned(),
            kind: "image".to_owned(),
            name: "one.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import");
    let second = db
        .import_asset(AssetInput {
            id: "asset-2".to_owned(),
            kind: "image".to_owned(),
            name: "two.svg".to_owned(),
            mime: "image/svg+xml".to_owned(),
            bytes: bytes.clone(),
            meta_json: None,
        })
        .expect("import duplicate");
    assert_eq!(first.id, second.id);
    assert_eq!(first.size, bytes.len() as f64);
    assert_eq!(db.asset_bytes(first.id).expect("read bytes"), bytes);
}
