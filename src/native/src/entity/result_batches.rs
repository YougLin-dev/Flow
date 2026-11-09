use sea_orm::entity::prelude::*;

/// One immutable set of results a node produced in one run (or one manual
/// text edit). Batches outlive the node they belong to so an undo can restore
/// the node's reference, and so downstream input snapshots keep resolving.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "result_batches")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub node_id: String,
    pub trigger: String,
    pub provider: String,
    pub model: String,
    pub params_json: String,
    pub status: String,
    pub error: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::result_items::Entity")]
    Items,
}

impl Related<super::result_items::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Items.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
