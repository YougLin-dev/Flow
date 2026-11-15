//! Package collection: terminal batches no live row references, their items
//! (by foreign-key cascade), unreferenced asset rows, and asset files with no
//! row.
//!
//! The command runs at open/maintenance, never mid-session, and refuses while
//! the undo history holds an entry: an entry can name a batch or asset that is
//! otherwise unreachable, and deleting it would break that undo. Rows are
//! removed in one transaction; the file sweep runs after the commit, so a
//! failed transaction can never leave a live row without its bytes. A crash
//! between the commit and the sweep leaves orphan files, which the next run
//! removes.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use sea_orm::sea_query::{Alias, Condition, Expr, ExprTrait, Func, Query, SelectStatement};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter,
};

use crate::asset::is_sha256_hex;
use crate::entity::{assets, node_inputs, nodes, result_batches, result_items};
use crate::types::GcReport;

/// Removes every collectable row, then sweeps the assets directory.
pub fn collect(conn: &DatabaseConnection, assets_dir: &Path) -> Result<GcReport, String> {
    let counts = conn
        .transaction::<_, (u64, u64, u64), DbErr>(|txn| {
            let (batches, items) = delete_batches(txn)?;
            let assets = delete_assets(txn)?;
            Ok((batches, items, assets))
        })
        .map_err(|error| error.to_string())?;
    let files = sweep_files(conn, assets_dir)?;
    Ok(GcReport {
        batches: counts.0 as f64,
        items: counts.1 as f64,
        assets: counts.2 as f64,
        files: files as f64,
    })
}

fn delete_batches(txn: &DatabaseTransaction) -> Result<(u64, u64), DbErr> {
    let items = result_items::Entity::find()
        .filter(
            Expr::col((result_items::Entity, result_items::Column::BatchId))
                .in_subquery(collectable_batch_ids()),
        )
        .count(txn)?;
    let batches = result_batches::Entity::find()
        .filter(collectable_condition())
        .count(txn)?;
    result_batches::Entity::delete_many()
        .filter(collectable_condition())
        .exec(txn)?;
    Ok((batches, items))
}

fn delete_assets(txn: &DatabaseTransaction) -> Result<u64, DbErr> {
    let unreferenced = Condition::all()
        .add(
            Expr::col((assets::Entity, assets::Column::Id))
                .not_in_subquery(result_item_asset_ids()),
        )
        .add(Expr::col((assets::Entity, assets::Column::Id)).not_in_subquery(input_asset_ids()));
    let count = assets::Entity::find()
        .filter(unreferenced.clone())
        .count(txn)?;
    assets::Entity::delete_many()
        .filter(unreferenced)
        .exec(txn)?;
    Ok(count)
}

/// A terminal batch is collectable when no node outputs it, no node input
/// snapshots one of its items, and it is not the newest batch of a live node
/// incarnation (the composer shows that one's error line).
fn collectable_condition() -> Condition {
    Condition::all()
        .add(Expr::col((result_batches::Entity, result_batches::Column::Status)).ne("running"))
        .add(
            Expr::col((result_batches::Entity, result_batches::Column::Id))
                .not_in_subquery(output_batch_ids()),
        )
        .add(
            Expr::col((result_batches::Entity, result_batches::Column::Id))
                .not_in_subquery(input_batch_ids()),
        )
        .add(
            Expr::col((result_batches::Entity, result_batches::Column::Id))
                .not_in_subquery(newest_batch_ids()),
        )
}

fn collectable_batch_ids() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((result_batches::Entity, result_batches::Column::Id))
        .from(result_batches::Entity)
        .cond_where(collectable_condition());
    select
}

/// Output pointers can be NULL; a NULL in a `NOT IN` list would make the
/// whole predicate unknown, so the subquery filters them out.
fn output_batch_ids() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((nodes::Entity, nodes::Column::OutputBatchId))
        .from(nodes::Entity)
        .and_where(Expr::col((nodes::Entity, nodes::Column::OutputBatchId)).is_not_null());
    select
}

fn input_batch_ids() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((result_items::Entity, result_items::Column::BatchId))
        .from(node_inputs::Entity)
        .inner_join(
            result_items::Entity,
            Expr::col((result_items::Entity, result_items::Column::Id))
                .equals((node_inputs::Entity, node_inputs::Column::ItemId)),
        )
        .and_where(Expr::col((node_inputs::Entity, node_inputs::Column::ItemId)).is_not_null());
    select
}

fn newest_batch_ids() -> SelectStatement {
    let mut latest = Query::select();
    latest
        .expr_as(
            Func::max(Expr::col((
                result_batches::Entity,
                result_batches::Column::Seq,
            ))),
            Alias::new("seq"),
        )
        .from(result_batches::Entity)
        .and_where(
            Expr::col((result_batches::Entity, result_batches::Column::NodeSeq))
                .in_subquery(live_node_seqs()),
        )
        .group_by_col((result_batches::Entity, result_batches::Column::NodeSeq));

    let mut select = Query::select();
    select
        .column((result_batches::Entity, result_batches::Column::Id))
        .from(result_batches::Entity)
        .and_where(
            Expr::col((result_batches::Entity, result_batches::Column::Seq)).in_subquery(latest),
        )
        .and_where(
            Expr::col((result_batches::Entity, result_batches::Column::NodeSeq))
                .in_subquery(live_node_seqs()),
        );
    select
}

fn live_node_seqs() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((nodes::Entity, nodes::Column::Seq))
        .from(nodes::Entity);
    select
}

fn result_item_asset_ids() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((result_items::Entity, result_items::Column::AssetId))
        .from(result_items::Entity)
        .and_where(Expr::col((result_items::Entity, result_items::Column::AssetId)).is_not_null());
    select
}

fn input_asset_ids() -> SelectStatement {
    let mut select = Query::select();
    select
        .column((node_inputs::Entity, node_inputs::Column::AssetId))
        .from(node_inputs::Entity)
        .and_where(Expr::col((node_inputs::Entity, node_inputs::Column::AssetId)).is_not_null());
    select
}

/// Deletes files whose content-addressed name has no asset row. Names that
/// are neither a hash nor one of the importer's temporary files are left
/// alone: the directory is a package resource, not a dumping ground, but GC
/// only claims files it can prove it wrote.
fn sweep_files(conn: &impl ConnectionTrait, assets_dir: &Path) -> Result<u64, String> {
    let entries = match fs::read_dir(assets_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let stored: BTreeSet<String> = assets::Entity::find()
        .all(conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|asset| asset.hash)
        .collect();
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(hash) = sweepable_hash(name) else {
            continue;
        };
        if stored.contains(hash) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(removed)
}

/// The stored hash a file name stands for: the name itself, or the hash part
/// of the importer's `.hash.tmp-<pid>` temporary file.
fn sweepable_hash(name: &str) -> Option<&str> {
    if is_sha256_hex(name) {
        return Some(name);
    }
    let rest = name.strip_prefix('.')?;
    let (hash, pid) = rest.split_once(".tmp-")?;
    if is_sha256_hex(hash) && !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(hash);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweepable_names_are_hashes_or_importer_temporaries() {
        let hash = "a".repeat(64);
        assert_eq!(sweepable_hash(&hash), Some(hash.as_str()));
        assert_eq!(
            sweepable_hash(&format!(".{hash}.tmp-1234")),
            Some(hash.as_str())
        );
        assert_eq!(sweepable_hash("notes.txt"), None);
        assert_eq!(sweepable_hash(&format!(".{hash}.tmp-")), None);
        assert_eq!(sweepable_hash(&format!(".{hash}.tmp-x1")), None);
        assert_eq!(sweepable_hash(&format!("{}.tmp-1", "A".repeat(64))), None);
    }
}
