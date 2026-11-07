use sea_orm::entity::prelude::*;

/// One applied database migration. The table replaces `PRAGMA user_version`
/// so migrations are ordinary, inspectable rows.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "schema_migrations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub version: i32,
    pub applied_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
