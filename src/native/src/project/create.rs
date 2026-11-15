//! Creating a project package.
//!
//! The package is built under a temp name at the root, checked and made
//! durable there, then made visible by one directory rename. A crash leaves
//! either residue (swept after a day) or the complete package, never a
//! half-built one. A seed runs in its own transaction inside the temp
//! package, so a rejected seed removes everything.
//!
//! A blank create records `demo_seeded = 1`: the initial-content decision
//! was made, and the legacy auto-seed must not fill the user's empty
//! project. A seeded create starts at 0 and `seed_document` flips it.

use std::fs;
use std::path::Path;

use sea_orm::Database;

use crate::db;
use crate::document;
use crate::mutation;
use crate::project::commit::TempPackage;
use crate::project::{catalog, paths};
use crate::schema::v1;
use crate::types::SeedDocumentInput;

pub(crate) fn create_project(
    root: &Path,
    title: &str,
    seed: Option<SeedDocumentInput>,
) -> Result<catalog::Entry, String> {
    v1::validate_title(title)?;

    let temp = TempPackage::create(root, "create")?;
    let database = temp.path().join(paths::DATABASE_FILE);

    let url = db::sqlite_url(&database.to_string_lossy())?;
    let conn = Database::connect(url)
        .map_err(|error| format!("the project package could not be created: {error}"))?;
    db::configure(&conn, &database.to_string_lossy())?;
    v1::create_with(&conn, title, seed.is_none())?;
    if let Some(seed) = seed {
        mutation::seed_document(&conn, seed)?;
    }
    fs::create_dir(temp.path().join(paths::ASSETS_DIR))
        .map_err(|error| format!("the project package could not be created: {error}"))?;

    // The first open of a freshly created package has nothing to verify.
    crate::schema::package::checkpoint_truncate(&conn)?;
    crate::schema::package::mark_clean(&conn)?;
    let row = document::current(&conn).map_err(|error| error.to_string())?;
    let entry = catalog::Entry {
        path: row.project_id.clone(),
        project_id: row.project_id,
        title: row.title,
        updated_at: row.updated_at,
        last_opened_at: None,
    };
    drop(conn);

    temp.commit(root, &entry)?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use sea_orm::{Database, DatabaseConnection};

    use super::*;
    use crate::project::package;
    use crate::project::test_support::TempRoot;
    use crate::types::NodeInput;

    fn seed() -> SeedDocumentInput {
        SeedDocumentInput {
            nodes: vec![NodeInput {
                id: "seed-note".to_owned(),
                kind: "note".to_owned(),
                title: "Seed note".to_owned(),
                body: String::new(),
                tags: vec!["text".to_owned()],
                x: 0.0,
                y: 0.0,
                width: 240.0,
                height: 120.0,
                z: 0.0,
                data_json: None,
                settings_json: None,
            }],
            edges: vec![],
            batch: None,
            item: None,
        }
    }

    fn connect(root: &Path, id: &str) -> DatabaseConnection {
        let database = paths::database_path(root, id);
        let url = db::sqlite_url(&database.to_string_lossy()).expect("url");
        Database::connect(url).expect("connect package")
    }

    fn document(conn: &DatabaseConnection) -> crate::entity::document::Model {
        document::current(conn).expect("document")
    }

    fn residue(root: &Path) -> Vec<String> {
        fs::read_dir(root)
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".create-"))
            .collect()
    }

    #[test]
    fn a_seeded_create_is_complete_clean_and_committed() {
        let temp = TempRoot::new("seeded");
        let entry = create_project(temp.path(), "Seeded", Some(seed())).expect("create");

        assert_eq!(entry.title, "Seeded");
        assert_eq!(entry.path, entry.project_id);
        assert_eq!(entry.path.len(), 32);
        assert!(paths::package_dir(temp.path(), &entry.path).is_dir());
        assert!(paths::assets_dir(temp.path(), &entry.path).is_dir());
        assert!(residue(temp.path()).is_empty());
        for sidecar in ["-wal", "-shm"] {
            let mut path = paths::database_path(temp.path(), &entry.path);
            path.set_extension(format!("db{sidecar}"));
            assert!(!path.exists(), "committed package must not carry {sidecar}");
        }

        let conn = connect(temp.path(), &entry.path);
        let row = document(&conn);
        assert_eq!(row.project_id, entry.path);
        assert_eq!(row.title, "Seeded");
        assert_eq!(row.node_count, 1);
        assert_eq!(row.demo_seeded, 1);
        assert_eq!(row.clean_shutdown, 1);
        assert_eq!(
            package::read_identity(&paths::database_path(temp.path(), &entry.path))
                .expect("identity")
                .project_id,
            entry.path
        );
        let catalog = catalog::load_valid(temp.path()).expect("catalog");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].path, entry.path);
    }

    #[test]
    fn a_blank_create_is_empty_but_marks_the_seed_decision() {
        let temp = TempRoot::new("blank");
        let entry = create_project(temp.path(), "Blank", None).expect("create");
        let conn = connect(temp.path(), &entry.path);
        let row = document(&conn);
        assert_eq!(row.node_count, 0);
        assert_eq!(row.edge_count, 0);
        assert_eq!(row.demo_seeded, 1);
        assert_eq!(row.clean_shutdown, 1);
    }

    #[test]
    fn an_invalid_seed_leaves_no_package_or_residue() {
        let temp = TempRoot::new("bad-seed");
        let mut bad = seed();
        bad.nodes.clear();
        let error = create_project(temp.path(), "Bad", Some(bad)).expect_err("seed refuses");
        assert!(error.contains("at least one node"), "unexpected: {error}");
        let names: Vec<_> = fs::read_dir(temp.path())
            .expect("root")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        assert!(names.is_empty(), "temp package must be removed: {names:?}");
        assert!(catalog::load_valid(temp.path()).is_none());
    }

    #[test]
    fn an_invalid_title_is_refused_before_touching_the_disk() {
        let temp = TempRoot::new("bad-title");
        assert_eq!(
            create_project(temp.path(), " \t", None),
            Err("the project title is empty".to_owned())
        );
        assert!(fs::read_dir(temp.path()).expect("root").next().is_none());
    }
}
