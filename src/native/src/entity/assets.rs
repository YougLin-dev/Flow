use sea_orm::entity::prelude::*;

/// Metadata for content-addressed bytes under the package's `assets/`
/// directory. The first writer of a hash wins; result items and local inputs
/// reference the row by `id`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "assets")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    #[sea_orm(unique)]
    pub hash: String,
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub meta_json: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::result_items::Entity")]
    ResultItems,
    #[sea_orm(has_many = "super::node_inputs::Entity")]
    NodeInputs,
}

impl Related<super::result_items::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ResultItems.def()
    }
}

impl Related<super::node_inputs::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInputs.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
