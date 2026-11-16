//! The database worker thread, connections and SQLite URLs.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};

use sea_orm::{
    ActiveValue::Set, ActiveValue::Unchanged, ConnectionTrait, DatabaseConnection, EntityTrait,
};

use crate::document;
use crate::entity::document as document_row;
use crate::schema;

/// A unit of work for the database thread.
pub(super) enum Job {
    Run(Box<dyn FnOnce(&DatabaseConnection) + Send + 'static>),
    /// Saves the camera (when given), checkpoints, records the shutdown
    /// state, acknowledges, and stops the worker.
    Close {
        ack: Sender<Result<(), String>>,
        camera: Option<(f64, f64, f64)>,
        /// Shared with the handle: a close job reads it in the worker, after
        /// any earlier verify job has stored its outcome (FIFO order).
        recovery_pending: Arc<AtomicBool>,
    },
}

/// How a database connection treats its file.
#[derive(Clone, Debug)]
pub(super) enum OpenMode {
    /// Create the file and its release schema when missing. The legacy and
    /// dev path.
    Create,
    /// Require an existing compatible package whose document carries this
    /// identity. Never creates the file or a parent directory.
    Existing { project_id: String },
}

pub(super) fn worker(
    path: &str,
    mode: OpenMode,
    ready: Sender<Result<bool, String>>,
    jobs: Receiver<Job>,
) {
    let conn = match open_connection(path, mode) {
        Ok(opened) => {
            let _ = ready.send(Ok(opened.clean));
            opened.conn
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    for job in jobs {
        match job {
            // A Run body reports its own error. This outer guard keeps a
            // panicking job from killing the only worker thread.
            Job::Run(run) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&conn)));
            }
            Job::Close {
                ack,
                camera,
                recovery_pending,
            } => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Read inside the worker: an earlier verify job that
                    // started has already stored its outcome here (FIFO); a
                    // verify still queued at close is skipped before it runs.
                    let mark_clean = !recovery_pending.load(Ordering::SeqCst);
                    if let Some((x, y, zoom)) = camera {
                        document_row::Entity::update(document_row::ActiveModel {
                            id: Unchanged(document::ROW_ID),
                            camera_x: Set(x),
                            camera_y: Set(y),
                            camera_zoom: Set(zoom),
                            ..Default::default()
                        })
                        .exec(&conn)
                        .map_err(|error| error.to_string())?;
                    }
                    // Fold committed WAL frames back into the package file
                    // first. Only a complete checkpoint may be called a clean
                    // close; the flag stays 0 otherwise.
                    schema::package::checkpoint_truncate(&conn)?;
                    if mark_clean {
                        schema::package::mark_clean(&conn)?;
                    }
                    Ok(())
                }))
                .unwrap_or_else(|_| Err("the database job panicked".to_owned()));
                // Release the file before acknowledging: a rename, delete or
                // backup the caller starts after close must not race the
                // connection.
                drop(conn);
                let _ = ack.send(result);
                return;
            }
        }
    }
}

/// An opened package connection and the shutdown state it had beforehand.
pub(super) struct OpenConnection {
    pub(super) conn: DatabaseConnection,
    /// A new package has nothing from a previous session to verify.
    clean: bool,
}

pub(crate) fn open_connection(path: &str, mode: OpenMode) -> Result<OpenConnection, String> {
    if matches!(mode, OpenMode::Create)
        && path != ":memory:"
        && let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let url = match &mode {
        OpenMode::Create => sqlite_url(path)?,
        OpenMode::Existing { .. } => {
            if path != ":memory:" && !Path::new(path).is_file() {
                return Err(missing_package_error(path));
            }
            sqlite_url_rw(path)?
        }
    };
    let conn = sea_orm::Database::connect(url.as_str()).map_err(|error| error.to_string())?;
    schema::v1::configure(&conn).map_err(|error| package_error(path, error))?;

    // Inspect before tuning the file: setting WAL would write to a foreign
    // database even though the guard then refuses it. The previous session's
    // flag is read here, before the open marks the package dirty.
    let clean = match schema::v1::inspect(&conn).map_err(|error| package_error(path, error))? {
        schema::v1::FileState::New => match &mode {
            OpenMode::Create => {
                schema::v1::create(&conn, "Flow").map_err(|error| package_error(path, error))?;
                true
            }
            OpenMode::Existing { .. } => {
                return Err(missing_package_error(path));
            }
        },
        schema::v1::FileState::Current(info) => {
            if let OpenMode::Existing { project_id } = &mode
                && info.project_id != *project_id
            {
                return Err(format!(
                    "the project package belongs to a different project: {path}"
                ));
            }
            document::current(&conn)
                .map_err(|error| error.to_string())?
                .clean_shutdown
                != 0
        }
    };
    configure(&conn, path)?;

    // The flag stays 0 for the whole session; `close` sets it once the
    // document has been written out cleanly.
    schema::package::mark_dirty(&conn).map_err(|error| error.to_string())?;

    Ok(OpenConnection { conn, clean })
}

fn missing_package_error(path: &str) -> String {
    format!(
        "the project package has no Flow database: {path}. \
         Create a project or choose an existing package."
    )
}

/// Adds the package path and a recovery suggestion to a guard error. The
/// guard itself sees only the connection.
fn package_error(path: &str, error: String) -> String {
    format!(
        "{path}: {error}. The file is not a compatible Flow project package; \
         delete it and its assets directory, or open a new project."
    )
}

pub(crate) fn sqlite_url(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }
    absolute_sqlite_url(path)
}

/// A read-only URL for a scan: SQLite fails instead of creating a missing
/// file, and a foreign or damaged package is inspected without writing to it.
pub(crate) fn sqlite_url_ro(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }
    Ok(format!("{}?mode=ro", absolute_sqlite_url(path)?))
}

/// A read-write URL that refuses to create a missing file. The managed open
/// path must not leave an empty database behind when the package is absent.
pub(crate) fn sqlite_url_rw(path: &str) -> Result<String, String> {
    if path == ":memory:" {
        return Ok("sqlite::memory:".to_owned());
    }
    Ok(format!("{}?mode=rw", absolute_sqlite_url(path)?))
}

fn absolute_sqlite_url(path: &str) -> Result<String, String> {
    // SQLite resolves `file:` URIs as absolute paths. Make relative overrides
    // (`FLOW_DB_PATH=./flow.db`) absolute first so they open next to the
    // caller rather than at the filesystem root, and so a colon in a file
    // name cannot be read as a URL authority and port.
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let normalized = absolute.to_string_lossy().replace('\\', "/");
    // `fs::canonicalize` produces a verbatim `\\?\C:\...` path on Windows
    // (or `\\?\UNC\server\share`); its `?` is not part of a SQLite `file:`
    // URI and must not survive as an authority. A verbatim UNC prefix
    // becomes the normal `//server/share` authority; a drive path drops the
    // prefix.
    let normalized = match normalized.strip_prefix("//?/UNC/") {
        Some(rest) => format!("//{rest}"),
        None => normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_owned(),
    };
    let encoded = encode_uri_path(&normalized);
    if encoded.starts_with("//") {
        // A UNC path's `//server/share` would be read as a URI authority,
        // which the bundled SQLite rejects (it is built without
        // SQLITE_ALLOW_URI_AUTHORITY). `localhost` is the one authority such
        // a build accepts and ignores, leaving the double-slash UNC path.
        Ok(format!("sqlite:file://localhost{encoded}"))
    } else if encoded.starts_with('/') {
        Ok(format!("sqlite:file:{encoded}"))
    } else {
        Ok(format!("sqlite:file:///{encoded}"))
    }
}

fn is_uri_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
}

/// Percent-encodes a filesystem path for SQLite's `file:` URI. SQLite decodes
/// the escapes, so a data directory with spaces ("Application Support") works.
fn encode_uri_path(path: &str) -> String {
    use std::fmt::Write;

    let mut encoded = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        if is_uri_path_byte(*byte) {
            encoded.push(char::from(*byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub(crate) fn configure(conn: &DatabaseConnection, path: &str) -> Result<(), String> {
    conn.execute_unprepared("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -64000;")
        .map_err(|error| error.to_string())?;
    if path != ":memory:" {
        conn.execute_unprepared("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
