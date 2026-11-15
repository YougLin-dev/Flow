//! Reads and the revision write for the singleton `document` row.

use sea_orm::{
    ActiveValue::Set, ActiveValue::Unchanged, ConnectionTrait, DatabaseTransaction, DbErr,
    EntityTrait,
};

use crate::clock::now_ms;
use crate::entity::document;

/// The only row a project package's `document` table may hold.
pub const ROW_ID: i32 = 1;

pub fn current<C>(conn: &C) -> Result<document::Model, DbErr>
where
    C: ConnectionTrait,
{
    document::Entity::find_by_id(ROW_ID)
        .one(conn)?
        .ok_or_else(|| DbErr::RecordNotFound("the document row was not found".to_owned()))
}

/// The current revision of the project's document.
pub fn current_rev<C>(conn: &C) -> Result<i64, DbErr>
where
    C: ConnectionTrait,
{
    Ok(current(conn)?.rev)
}

/// Bumps the document revision and timestamp. Every user command calls this
/// once; maintenance writes that are not undoable (camera, compaction) do
/// not.
pub fn bump_rev(txn: &DatabaseTransaction) -> Result<i64, DbErr> {
    let before = current(txn)?;
    let updated = document::Entity::update(document::ActiveModel {
        id: Unchanged(ROW_ID),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;
    Ok(updated.rev)
}
