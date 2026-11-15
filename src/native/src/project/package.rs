//! Reading and checking a package without opening a document.
//!
//! Package operations run on short-lived bare connections, never beside a
//! live `Document`: the project lease is the interlock. Identity reads prefer
//! a read-only connection so scans never write to a foreign package; a
//! package whose write-ahead log needs recovery falls back to a short
//! read-write connection.

use std::path::Path;

use sea_orm::{Database, DatabaseConnection, EntityTrait};

use crate::db;
use crate::document;
use crate::entity::assets;
use crate::project::paths;
use crate::schema::v1;

/// The identity and lifecycle facts a catalog entry is built from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub project_id: String,
    pub title: String,
    pub updated_at: i64,
    /// The previous session recorded a clean shutdown.
    pub clean_shutdown: bool,
}

/// Reads the document identity of an existing package. A missing database,
/// a foreign file and a package that fails the v1 guard are distinct errors.
pub(crate) fn read_identity(database: &Path) -> Result<Identity, String> {
    if !paths::is_regular_file(database) {
        return Err(missing_database(database));
    }
    let guard = |error: String| not_a_package(database, &error);

    let conn = connect_for_read(database).map_err(guard)?;
    v1::configure(&conn).map_err(guard)?;
    let info = match v1::inspect(&conn).map_err(guard)? {
        v1::FileState::Current(info) => info,
        v1::FileState::New => return Err(missing_database(database)),
    };
    let row = document::current(&conn).map_err(|error| guard(error.to_string()))?;
    Ok(Identity {
        project_id: info.project_id,
        title: row.title,
        updated_at: row.updated_at,
        clean_shutdown: row.clean_shutdown != 0,
    })
}

fn connect_for_read(database: &Path) -> Result<DatabaseConnection, String> {
    let path = database.to_string_lossy();
    // Read-only first: a scan must not create a journal or write to a
    // foreign package. A package whose WAL needs recovery cannot be opened
    // read-only; the short fallback below lets SQLite repair it in place.
    match Database::connect(db::sqlite_url_ro(&path)?) {
        Ok(conn) => Ok(conn),
        Err(_) => Database::connect(db::sqlite_url_rw(&path)?).map_err(|error| error.to_string()),
    }
}

pub(crate) fn missing_database(database: &Path) -> String {
    format!(
        "the project package has no Flow database: {}",
        database.display()
    )
}

/// The identity a directory's document must carry for managed mutations.
pub(crate) fn identity_mismatch(root: &Path, project_id: &str) -> String {
    format!(
        "the package identity does not match its directory: {}",
        paths::package_dir(root, project_id).display()
    )
}

pub(crate) fn not_a_package(database: &Path, error: &str) -> String {
    format!(
        "the project package is not a Flow project package: {}: {error}",
        database.display()
    )
}

/// Checks that every asset row has its content-addressed file in the
/// package. Used after copying or importing, before the package is renamed
/// into place, so a race with an asset sweep becomes a clean failure.
pub(crate) fn verify_assets(conn: &DatabaseConnection, package_dir: &Path) -> Result<(), String> {
    let rows = assets::Entity::find()
        .all(conn)
        .map_err(|error| error.to_string())?;
    for row in rows {
        let missing = || format!("the package is missing asset {}", row.hash);
        let size = usize::try_from(row.size).map_err(|_| missing())?;
        if !crate::asset::is_sha256_hex(&row.hash) {
            return Err(missing());
        }
        // The name is the integrity promise: a same-length corrupt file must
        // fail here, before the package becomes visible.
        let path = package_dir.join(paths::ASSETS_DIR).join(&row.hash);
        let matches = crate::asset::file_matches(&path, &row.hash, size).map_err(|error| {
            format!("the package asset {} could not be read: {error}", row.hash)
        })?;
        if !matches {
            return Err(missing());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use sea_orm::{ActiveModelTrait, ActiveValue::Set, ConnectionTrait};

    use super::*;
    use crate::project::test_support::TempRoot;

    struct TempPackage {
        root: TempRoot,
        id: String,
    }

    impl TempPackage {
        fn new(label: &str) -> Self {
            let root = TempRoot::new(label);
            let id = "0123456789abcdef0123456789abcdef".to_owned();
            fs::create_dir_all(paths::package_dir(root.path(), &id)).expect("package dir");
            Self { root, id }
        }

        fn database(&self) -> PathBuf {
            paths::database_path(self.root.path(), &self.id)
        }

        fn package_dir(&self) -> PathBuf {
            paths::package_dir(self.root.path(), &self.id)
        }

        fn create(&self, title: &str) -> DatabaseConnection {
            let url = db::sqlite_url(&self.database().to_string_lossy()).expect("url");
            let conn = Database::connect(url).expect("connect");
            v1::create(&conn, title).expect("create v1");
            crate::schema::package::remint_project_id(&conn, &self.id, title, 1, 1)
                .expect("use the fixture id");
            conn
        }
    }

    #[test]
    fn read_identity_reads_a_current_package() {
        let temp = TempPackage::new("identity");
        {
            let conn = temp.create("Read me");
            crate::schema::package::mark_clean(&conn).expect("mark clean");
        }
        let identity = read_identity(&temp.database()).expect("identity");
        assert_eq!(identity.project_id, temp.id);
        assert_eq!(identity.title, "Read me");
        assert!(identity.updated_at > 0);
        assert!(identity.clean_shutdown);
    }

    #[test]
    fn read_identity_distinguishes_missing_foreign_and_newer_packages() {
        let temp = TempPackage::new("invalid");

        let error = read_identity(&temp.database()).expect_err("missing database");
        assert!(error.starts_with("the project package has no Flow database:"));

        fs::write(temp.database(), b"not a database").expect("junk file");
        let error = read_identity(&temp.database()).expect_err("foreign database");
        assert!(error.starts_with("the project package is not a Flow project package:"));

        fs::remove_file(temp.database()).expect("remove junk");
        let conn = temp.create("Newer");
        conn.execute_unprepared("PRAGMA user_version = 2")
            .expect("newer schema");
        let error = read_identity(&temp.database()).expect_err("newer schema");
        assert!(error.contains("newer"));
    }

    #[test]
    fn read_identity_refuses_an_empty_file_without_creating_a_schema() {
        let temp = TempPackage::new("empty");
        fs::write(temp.database(), b"").expect("empty file");
        let error = read_identity(&temp.database()).expect_err("empty database");
        assert!(error.starts_with("the project package has no Flow database:"));
        assert_eq!(fs::metadata(temp.database()).expect("file").len(), 0);
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn verify_assets_accepts_text_only_and_rejects_bad_bytes() {
        let temp = TempPackage::new("assets");
        let conn = temp.create("Assets");
        verify_assets(&conn, &temp.package_dir()).expect("text-only package");

        let bytes = b"0123456789";
        let hash = sha256_hex(bytes);
        let asset_dir = temp.package_dir().join(paths::ASSETS_DIR);
        fs::create_dir_all(&asset_dir).expect("assets dir");
        assets::ActiveModel {
            id: Set("asset-1".to_owned()),
            hash: Set(hash.clone()),
            kind: Set("image".to_owned()),
            name: Set("image.png".to_owned()),
            mime: Set("image/png".to_owned()),
            size: Set(bytes.len() as i64),
            meta_json: Set("{}".to_owned()),
            created_at: Set(1),
        }
        .insert(&conn)
        .expect("insert asset");

        assert_eq!(
            verify_assets(&conn, &temp.package_dir()),
            Err(format!("the package is missing asset {hash}"))
        );
        fs::write(asset_dir.join(&hash), b"short").expect("short asset");
        assert_eq!(
            verify_assets(&conn, &temp.package_dir()),
            Err(format!("the package is missing asset {hash}"))
        );
        // Same length, different bytes: only the content hash catches it.
        fs::write(asset_dir.join(&hash), b"9876543210").expect("corrupt asset");
        assert_eq!(
            verify_assets(&conn, &temp.package_dir()),
            Err(format!("the package is missing asset {hash}"))
        );
        fs::write(asset_dir.join(&hash), bytes).expect("full asset");
        verify_assets(&conn, &temp.package_dir()).expect("complete asset");

        // Larger than the streaming buffer: the hash is still the file hash.
        let big: Vec<u8> = (0..200_000u32).map(|value| (value % 251) as u8).collect();
        let big_hash = sha256_hex(&big);
        assets::ActiveModel {
            id: Set("asset-2".to_owned()),
            hash: Set(big_hash.clone()),
            kind: Set("image".to_owned()),
            name: Set("large.png".to_owned()),
            mime: Set("image/png".to_owned()),
            size: Set(big.len() as i64),
            meta_json: Set("{}".to_owned()),
            created_at: Set(1),
        }
        .insert(&conn)
        .expect("insert large asset");
        fs::write(asset_dir.join(&big_hash), &big).expect("large asset");
        verify_assets(&conn, &temp.package_dir()).expect("large complete asset");
    }
}
