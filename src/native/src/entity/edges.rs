use sea_orm::entity::prelude::*;

/// A directed port connection. `seq` is the immutable SQLite key the edge
/// RTree is keyed by; `id` is the stable identifier the UI uses.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "edges")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub seq: i64,
    #[sea_orm(unique)]
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub from_port: String,
    pub to_port: String,
    pub port_kind: String,
    pub from_offset: f64,
    pub to_offset: f64,
    pub kind: String,
    pub data_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::nodes::Entity",
        from = "Column::FromId",
        to = "super::nodes::Column::Id",
        on_delete = "Cascade",
        on_update = "Cascade"
    )]
    FromNode,
    #[sea_orm(
        belongs_to = "super::nodes::Entity",
        from = "Column::ToId",
        to = "super::nodes::Column::Id",
        on_delete = "Cascade",
        on_update = "Cascade"
    )]
    ToNode,
}

impl ActiveModelBehavior for ActiveModel {}
