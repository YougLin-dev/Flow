//! Content-addressed asset bytes. Metadata lives in SQLite; bytes live in
//! `<database directory>/assets/<sha256>`, which TSX never touches directly.

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use sha2::{Digest, Sha256};

use crate::clock::now_ms;
use crate::entity::assets;
use crate::types::{AssetInput, AssetSummary};

/// Makes an in-memory database's private asset directory unique even when
/// several are opened in the same millisecond (parallel tests).
static NEXT_ASSETS_DIR: AtomicU64 = AtomicU64::new(0);

/// The directory an asset file lives in. `:memory:` databases get a private
/// temporary directory so tests exercise the real file path.
pub fn assets_dir_for(database_path: &str) -> PathBuf {
    if database_path == ":memory:" {
        return std::env::temp_dir().join(format!(
            "flow-assets-{}-{}-{}",
            std::process::id(),
            now_ms(),
            NEXT_ASSETS_DIR.fetch_add(1, Ordering::Relaxed)
        ));
    }
    let path = Path::new(database_path);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    parent.unwrap_or_else(|| Path::new(".")).join("assets")
}

pub fn import_asset(
    conn: &DatabaseConnection,
    assets_dir: &Path,
    input: AssetInput,
) -> Result<AssetSummary, String> {
    let hash = hash_bytes(&input.bytes);
    if !is_sha256_hex(&hash) {
        return Err("the asset hash is malformed".to_owned());
    }
    if let Some(existing) = assets::Entity::find()
        .filter(assets::Column::Hash.eq(&hash))
        .one(conn)
        .map_err(|error| error.to_string())?
    {
        return existing_asset(assets_dir, &existing, &input.bytes);
    }

    let meta_json = input.meta_json.unwrap_or_else(|| "{}".to_owned());
    let size = input.bytes.len() as i64;
    let row = assets::ActiveModel {
        id: sea_orm::ActiveValue::Set(input.id),
        hash: sea_orm::ActiveValue::Set(hash.clone()),
        kind: sea_orm::ActiveValue::Set(input.kind),
        name: sea_orm::ActiveValue::Set(input.name),
        mime: sea_orm::ActiveValue::Set(input.mime),
        size: sea_orm::ActiveValue::Set(size),
        meta_json: sea_orm::ActiveValue::Set(meta_json),
        created_at: sea_orm::ActiveValue::Set(now_ms()),
    };
    // Write the bytes first: a row must never point at a missing file. The
    // content-addressed name makes a concurrent identical import harmless;
    // if it wins the insert, its row is the one to return.
    write_bytes(assets_dir, &hash, &input.bytes)?;
    let stored = match assets::Entity::insert(row).exec(conn) {
        Ok(inserted) => assets::Entity::find_by_id(inserted.last_insert_id)
            .one(conn)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "the imported asset disappeared".to_owned())?,
        Err(error) => return conflict_asset(conn, assets_dir, &hash, &input.bytes, error),
    };
    Ok(AssetSummary::from(&stored))
}

/// A returned row's stored hash and size are checked before the file is used
/// or recreated, so a corrupt row is rejected rather than returned as a
/// broken asset. A matching file is never rewritten; a missing or corrupt
/// one is replaced with the verified imported bytes.
fn existing_asset(
    assets_dir: &Path,
    existing: &assets::Model,
    bytes: &[u8],
) -> Result<AssetSummary, String> {
    asset_path(assets_dir, existing)?;
    if hash_bytes(bytes) != existing.hash {
        return Err(format!(
            "asset {} does not match the imported bytes' hash",
            existing.id
        ));
    }
    if existing.size as usize != bytes.len() {
        return Err(format!(
            "asset {} is {} bytes but the imported bytes are {}",
            existing.id,
            existing.size,
            bytes.len()
        ));
    }
    // A valid file is left untouched; a missing or corrupt one is replaced
    // with the bytes whose hash and size were just verified.
    write_bytes(assets_dir, &existing.hash, bytes)?;
    Ok(AssetSummary::from(existing))
}

/// The failed-insert fallback: another writer may have won the hash between
/// the lookup and the insert. The winner is returned only after the same
/// validation as a hash hit.
pub(crate) fn conflict_asset(
    conn: &DatabaseConnection,
    assets_dir: &Path,
    hash: &str,
    bytes: &[u8],
    error: DbErr,
) -> Result<AssetSummary, String> {
    match assets::Entity::find()
        .filter(assets::Column::Hash.eq(hash))
        .one(conn)
        .map_err(|find_error| find_error.to_string())?
    {
        Some(existing) => existing_asset(assets_dir, &existing, bytes),
        None => Err(error.to_string()),
    }
}

/// The only place a stored hash becomes a filesystem path. A malformed or
/// negative-size row is rejected before any join or read.
fn asset_path(assets_dir: &Path, asset: &assets::Model) -> Result<PathBuf, String> {
    if !is_sha256_hex(&asset.hash) {
        return Err(format!("asset {} has a malformed hash", asset.id));
    }
    if asset.size < 0 {
        return Err(format!("asset {} has a negative size", asset.id));
    }
    Ok(assets_dir.join(&asset.hash))
}

pub fn asset_bytes(
    conn: &DatabaseConnection,
    assets_dir: &Path,
    id: String,
) -> Result<Vec<u8>, String> {
    let asset = assets::Entity::find_by_id(id.clone())
        .one(conn)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("asset {id} was not found"))?;
    let path = asset_path(assets_dir, &asset)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("asset {id} could not be read: {error}"))?;
    if bytes.len() as i64 != asset.size {
        return Err(format!(
            "asset {id} holds {} bytes but its row says {}",
            bytes.len(),
            asset.size
        ));
    }
    if hash_bytes(&bytes) != asset.hash {
        return Err(format!("asset {id} does not match its stored hash"));
    }
    Ok(bytes)
}
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// A content hash must be exactly what `hash_bytes` produces: 64 lowercase
/// hexadecimal characters. A malformed stored hash is not used as a path.
pub(crate) fn is_sha256_hex(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn write_bytes(dir: &Path, hash: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let target = dir.join(hash);
    if file_matches(&target, hash, bytes.len())? {
        return Ok(());
    }
    let temp = dir.join(format!(".{hash}.tmp-{}", std::process::id()));
    // The content-addressed name is a durability promise: flush the bytes
    // before the rename that publishes them, and flush the directory entry
    // after. A crash otherwise leaves a referenced row without durable bytes.
    let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    match fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
    }
    match fs::rename(&temp, &target) {
        Ok(()) => {
            crate::fsutil::sync_dir_best_effort(dir);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            // Another writer may have installed valid bytes after the remove.
            if file_matches(&target, hash, bytes.len())? {
                Ok(())
            } else {
                Err(error.to_string())
            }
        }
    }
}

/// Whether a stored file is exactly the bytes its content-addressed name
/// promises. A missing file is a mismatch, not an error.
pub(crate) fn file_matches(path: &Path, hash: &str, size: usize) -> Result<bool, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() != size as u64 {
        return Ok(false);
    }
    // Stream the file: asset bytes are untrusted and may be large, and the
    // package verification pass must not allocate the whole file.
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()) == hash)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::entity::assets;

    use super::{existing_asset, is_sha256_hex};

    fn stored(hash: &str, size: i64) -> assets::Model {
        assets::Model {
            id: "asset".to_owned(),
            hash: hash.to_owned(),
            kind: "image".to_owned(),
            name: "one.png".to_owned(),
            mime: "image/png".to_owned(),
            size,
            meta_json: "{}".to_owned(),
            created_at: 0,
        }
    }

    #[test]
    fn a_content_hash_is_64_lowercase_hex_characters() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(is_sha256_hex(&"0123456789abcdef".repeat(4)));
        assert!(!is_sha256_hex(&"A".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&format!("{}g", "a".repeat(63))));
        assert!(!is_sha256_hex(""));
    }

    #[test]
    fn a_malformed_stored_hash_is_rejected_before_any_file_use() {
        let error = existing_asset(Path::new("."), &stored("../escape", 3), b"abc")
            .expect_err("a malformed hash must not be used as a path");
        assert!(error.contains("malformed hash"), "{error}");
    }

    #[test]
    fn a_stored_size_mismatch_is_rejected_before_the_file_is_recreated() {
        let hash = super::hash_bytes(b"abc");
        let error = existing_asset(Path::new("."), &stored(&hash, 4), b"abc")
            .expect_err("a size mismatch must be rejected");
        assert!(error.contains("imported bytes are 3"), "{error}");
    }

    #[test]
    fn a_stored_hash_that_does_not_match_the_bytes_is_rejected() {
        let error = existing_asset(Path::new("."), &stored(&"a".repeat(64), 3), b"abc")
            .expect_err("a content hash mismatch must be rejected");
        assert!(error.contains("does not match"), "{error}");
    }

    #[test]
    fn a_negative_stored_size_is_rejected_after_the_hash_check() {
        let hash = super::hash_bytes(b"abc");
        let error = existing_asset(Path::new("."), &stored(&hash, -1), b"abc")
            .expect_err("a negative stored size must be rejected");
        assert!(error.contains("negative size"), "{error}");
    }
}
