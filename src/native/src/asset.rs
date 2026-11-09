//! Content-addressed asset bytes. Metadata lives in SQLite; bytes live in
//! `<database directory>/assets/<sha256>`, which TSX never touches directly.

use std::fs;
use std::path::{Path, PathBuf};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use sha2::{Digest, Sha256};

use crate::clock::now_ms;
use crate::entity::assets;
use crate::types::{AssetInput, AssetSummary};

/// The directory an asset file lives in. `:memory:` databases get a private
/// temporary directory so tests exercise the real file path.
pub fn assets_dir_for(database_path: &str) -> PathBuf {
    if database_path == ":memory:" {
        return std::env::temp_dir().join(format!(
            "flow-assets-{}-{}",
            std::process::id(),
            now_ms()
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
    if let Some(existing) = assets::Entity::find()
        .filter(assets::Column::Hash.eq(&hash))
        .one(conn)
        .map_err(|error| error.to_string())?
    {
        // The row may outlive its file (manual cleanup, a truncated copy, a
        // database copied without the assets directory); the content is at
        // hand, so make the bytes exist again instead of returning a broken
        // asset.
        write_bytes(assets_dir, &existing.hash, &input.bytes)?;
        return Ok(asset_summary(&existing));
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
        Err(error) => assets::Entity::find()
            .filter(assets::Column::Hash.eq(&hash))
            .one(conn)
            .map_err(|find_error| find_error.to_string())?
            .ok_or_else(|| error.to_string())?,
    };
    Ok(asset_summary(&stored))
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
    fs::read(assets_dir.join(&asset.hash))
        .map_err(|error| format!("asset {id} could not be read: {error}"))
}
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn write_bytes(dir: &Path, hash: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let target = dir.join(hash);
    if target.exists() {
        return Ok(());
    }
    let temp = dir.join(format!(".{hash}.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    match fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            let _ = fs::remove_file(&temp);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error.to_string())
        }
    }
}

fn asset_summary(asset: &assets::Model) -> AssetSummary {
    AssetSummary {
        id: asset.id.clone(),
        hash: asset.hash.clone(),
        kind: asset.kind.clone(),
        name: asset.name.clone(),
        mime: asset.mime.clone(),
        size: asset.size as f64,
        meta_json: asset.meta_json.clone(),
        created_at: asset.created_at as f64,
    }
}
