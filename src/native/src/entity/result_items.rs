use sea_orm::entity::prelude::*;

/// One text or image in a result batch. Items are immutable; a rerun appends
/// a new batch instead of editing an old item.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "result_items")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub batch_id: String,
    pub position: i32,
    pub port_id: String,
    pub kind: String,
    pub text: String,
    pub asset_id: Option<String>,
    pub meta_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::result_batches::Entity",
        from = "Column::BatchId",
        to = "super::result_batches::Column::Id",
        on_delete = "Cascade"
    )]
    Batch,
}

impl Related<super::result_batches::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Batch.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
