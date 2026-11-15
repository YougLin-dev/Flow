use sea_orm::entity::prelude::*;

/// One immutable set of results a node produced in one run, manual edit or
/// upload. A batch is inserted `running`, filled with items, then settled;
/// after that no field may change except through the item-count triggers.
/// `node_seq` binds the batch to the node incarnation that produced it.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "result_batches")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub seq: i64,
    #[sea_orm(unique)]
    pub id: String,
    pub node_id: String,
    pub node_seq: i64,
    pub trigger: String,
    pub provider: String,
    pub model: String,
    pub params_json: String,
    pub status: String,
    pub error: Option<String>,
    pub item_count: i64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
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
