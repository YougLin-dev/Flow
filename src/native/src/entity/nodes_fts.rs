use sea_orm::entity::prelude::*;

/// The trigram FTS5 index for a node. Its rowid is `nodes.seq`; title, body
/// and tags are the searchable text.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "nodes_fts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_name = "rowid")]
    pub rowid: i32,
    pub title: String,
    pub body: String,
    pub tags: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
