use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "edges")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub document_id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: Option<String>,
    pub to_port: Option<String>,
    pub kind: String,
    pub data_json: String,
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
    #[sea_orm(
        belongs_to = "super::nodes::Entity",
        from = "Column::FromId",
        to = "super::nodes::Column::Id",
        on_delete = "Cascade"
    )]
    FromNode,
    #[sea_orm(
        belongs_to = "super::nodes::Entity",
        from = "Column::ToId",
        to = "super::nodes::Column::Id",
        on_delete = "Cascade"
    )]
    ToNode,
}

impl Related<super::documents::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Document.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
