use sea_orm::entity::prelude::*;

/// A canvas node. `seq` is the internal SQLite key used by the RTree and FTS
/// indexes; `id` is the stable identifier the UI uses.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "nodes")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub seq: i32,
    #[sea_orm(unique)]
    pub id: String,
    pub document_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tags_json: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    pub data_json: String,
    pub rev: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::documents::Entity",
        from = "Column::DocumentId",
        to = "super::documents::Column::Id",
        on_delete = "Cascade"
    )]
    Document,
    #[sea_orm(has_many = "super::node_assets::Entity")]
    Assets,
}

impl Related<super::documents::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Document.def()
    }
}

impl Related<super::node_assets::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Assets.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
