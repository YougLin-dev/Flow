use sea_orm::entity::prelude::*;

/// The external-content trigram FTS5 index for a node. Its rowid is
/// `nodes.seq`; the v1 triggers keep it in step with title, body and tags, so
/// the entity is read-only for the app.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "nodes_fts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_name = "rowid")]
    pub rowid: i64,
    pub title: String,
    pub body: String,
    pub tags: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
