//! Opening, paths and the SQLite URL rules.
//!
//! Fixtures live in `db::tests`; this module shares them through
//! `use super::*;`.

use super::*;

#[test]
fn sqlite_url_makes_a_relative_path_absolute() {
    let url = sqlite_url("my data/notes:2024.db").expect("url");
    assert!(url.starts_with("sqlite:file:"));
    assert!(url.contains("my%20data/notes:2024.db"));
    assert!(!url.contains("sqlite://my"));
}

#[cfg(windows)]
#[test]
fn sqlite_url_strips_a_verbatim_prefix() {
    let url = sqlite_url("\\\\?\\C:\\Flow Data\\flow.db").expect("url");
    assert!(!url.contains("%3F"), "{url}");
    assert!(url.contains("C:/Flow%20Data/flow.db"), "{url}");
}

#[cfg(windows)]
#[test]
fn sqlite_url_keeps_a_verbatim_unc_share() {
    let url = sqlite_url("\\\\?\\UNC\\nas\\backups\\flow.db").expect("url");
    assert!(!url.contains("%3F"), "{url}");
    // The authority-less `file://server` form is rejected by the bundled
    // SQLite; the ignored `localhost` authority keeps the UNC path.
    assert!(
        url.starts_with("sqlite:file://localhost//nas/backups/flow.db"),
        "{url}"
    );
    assert!(!url.contains("file://nas"), "{url}");
}

#[cfg(windows)]
#[test]
fn sqlite_url_opens_a_canonicalized_package() {
    let (path, database) = temp_database("verbatim-open");
    {
        let db = Database::open(&database).expect("create");
        db.close().expect("close");
    }
    let canonical = std::fs::canonicalize(&path).expect("canonicalize");
    let url = sqlite_url_ro(&canonical.to_string_lossy()).expect("url");
    let conn = sea_orm::Database::connect(url).expect("open canonicalized url");
    let state = schema::v1::inspect(&conn).expect("inspect the opened package");
    assert!(matches!(state, schema::v1::FileState::Current(_)));
    drop(conn);
    remove_database_files(&path);
}

#[test]
fn persists_across_reopen() {
    let path = std::env::temp_dir().join(format!(
        "flow-native-{}-{}.db",
        std::process::id(),
        now_ms()
    ));
    let path = path.to_string_lossy().into_owned();

    {
        let db = Database::open(&path).expect("open");
        db.insert_nodes(vec![node(
            "persisted",
            "Persistent panel",
            "Survives a reopen",
            &["disk"],
            10.0,
            20.0,
        )])
        .expect("insert");
    }

    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(db.count().expect("count"), 1);
        let hits = db
            .search("Persistent".to_owned(), SearchFilters::default(), 20)
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "persisted");
    }

    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

#[test]
fn opens_a_database_in_a_directory_with_spaces() {
    let dir = std::env::temp_dir().join(format!("flow native {} {}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).expect("create directory");
    let path = dir.join("flow.db");
    let path = path.to_string_lossy().into_owned();

    {
        let db = Database::open(&path).expect("open");
        db.insert_nodes(vec![node("spaced", "With spaces", "", &[], 0.0, 0.0)])
            .expect("insert");
    }
    {
        let db = Database::open(&path).expect("reopen");
        assert_eq!(db.count().expect("count"), 1);
    }

    for suffix in ["", "-wal", "-shm"] {
        remove_path_retrying(std::path::Path::new(&format!("{path}{suffix}")));
    }
    remove_path_retrying(&dir);
}

#[test]
fn opening_an_empty_file_creates_a_v1_package() {
    let db = Database::open(":memory:").expect("open");
    let info = db.project_info().expect("project info");
    assert_eq!(info.title, "Flow");
    assert_eq!(info.project_id.len(), 32);
    assert!(
        info.project_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "a project id is 32 lowercase hex characters"
    );
    assert!(!info.demo_seeded);
    assert_eq!((info.node_count, info.edge_count), (0.0, 0.0));
    assert_eq!(
        (info.camera_x, info.camera_y, info.camera_zoom),
        (0.0, 0.0, 1.0)
    );

    let pragmas = db
        .run(|conn| {
            let read = |name: &str| {
                conn.query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    format!("PRAGMA {name}"),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("PRAGMA {name} returned no row"))?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())
            };
            let clean = conn
                .query_one_raw(sea_orm::Statement::from_string(
                    conn.get_database_backend(),
                    "SELECT clean_shutdown FROM document WHERE id = 1".to_owned(),
                ))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "missing document row".to_owned())?
                .try_get_by_index::<i64>(0)
                .map_err(|error| error.to_string())?;
            Ok((
                read("application_id")?,
                read("user_version")?,
                read("foreign_keys")?,
                read("recursive_triggers")?,
                clean,
            ))
        })
        .expect("read pragmas");
    assert_eq!(pragmas.0, schema::v1::APPLICATION_ID);
    assert_eq!(pragmas.1, schema::v1::USER_VERSION);
    assert_eq!(pragmas.2, 1, "foreign keys are on");
    assert_eq!(pragmas.3, 0, "recursive triggers stay off");
    assert_eq!(pragmas.4, 0, "an open package is dirty");
}

#[test]
fn open_package_refuses_missing_files_without_creating_them() {
    let (path, _) = temp_database("package-missing");
    let missing = path.with_file_name(format!(
        "flow-missing-package-{}-{}.db",
        std::process::id(),
        now_ms()
    ));
    let text = missing.to_string_lossy().into_owned();
    let error = match Database::open_package(&text, "a".repeat(32)) {
        Ok(_) => panic!("a missing package must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("has no Flow database"), "{error}");
    assert!(!missing.exists(), "the open must not create the file");
    remove_database_files(&path);

    let (empty_path, empty) = temp_database("package-empty");
    std::fs::write(&empty_path, b"").expect("empty package file");
    let error = match Database::open_package(&empty, "a".repeat(32)) {
        Ok(_) => panic!("an empty package must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("has no Flow database"), "{error}");
    assert_eq!(
        std::fs::metadata(&empty_path).expect("empty file").len(),
        0,
        "an empty file must not receive a schema"
    );
    remove_database_files(&empty_path);
}

#[test]
fn open_package_requires_the_matching_identity_without_marking_it_dirty() {
    let (path, database) = temp_database("package-identity");
    let project_id;
    {
        let db = Database::open(&database).expect("create");
        project_id = db.project_info().expect("info").project_id;
        db.close().expect("clean close");
    }
    {
        let db = Database::open_package(&database, project_id.clone()).expect("open package");
        let info = db.project_info().expect("info");
        assert!(info.opened_clean);
        assert_eq!(info.project_id, project_id);
        db.close().expect("close");
    }
    let error = match Database::open_package(&database, "b".repeat(32)) {
        Ok(_) => panic!("a mismatched identity must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("belongs to a different project"), "{error}");
    {
        let db = Database::open_package(&database, project_id).expect("reopen");
        assert!(
            db.project_info().expect("info").opened_clean,
            "a refused identity must not mark the package dirty"
        );
        db.close().expect("close");
    }
    remove_database_files(&path);
}

#[test]
fn opening_refuses_foreign_and_legacy_files_without_dropping_them() {
    let (foreign_path, foreign) = temp_database("foreign");
    write_raw_database(
        &foreign,
        "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep');",
    );
    let error = match Database::open(&foreign) {
        Ok(_) => panic!("a foreign database must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("not a Flow database"), "{error}");
    assert!(error.contains(&foreign), "the error names the package path");
    let kept = {
        let url = sqlite_url(&foreign).expect("raw URL");
        let conn = sea_orm::Database::connect(url.as_str()).expect("reopen raw database");
        let row = conn
            .query_one_raw(sea_orm::Statement::from_string(
                conn.get_database_backend(),
                "SELECT body FROM notes".to_owned(),
            ))
            .expect("read foreign row")
            .expect("foreign row survives");
        row.try_get_by_index::<String>(0).expect("foreign body")
    };
    assert_eq!(kept, "keep");
    remove_database_files(&foreign_path);

    let (legacy_path, legacy) = temp_database("legacy");
    write_raw_database(
        &legacy,
        "CREATE TABLE documents (id TEXT PRIMARY KEY); \
             CREATE TABLE nodes (id TEXT PRIMARY KEY); \
             INSERT INTO documents VALUES ('default');",
    );
    let error = match Database::open(&legacy) {
        Ok(_) => panic!("a v5 development file must be refused"),
        Err(error) => error,
    };
    assert!(error.contains("not a Flow database"), "{error}");
    remove_database_files(&legacy_path);
}
