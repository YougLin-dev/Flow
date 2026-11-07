use sea_orm::{ConnectionTrait, DbErr, EntityTrait};

use crate::constants::DOCUMENT_ID;
use crate::entity::documents;

/// The current revision of the default document.
pub fn current_rev<C>(conn: &C) -> Result<i64, DbErr>
where
    C: ConnectionTrait,
{
    documents::Entity::find_by_id(DOCUMENT_ID)
        .one(conn)?
        .map(|document| document.rev)
        .ok_or_else(|| DbErr::RecordNotFound("the default document was not found".to_owned()))
}
