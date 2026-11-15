use sea_orm::entity::prelude::*;

/// One ordered input item of a node. An item either references a result item
/// from an upstream batch (`origin = "edge"`, with the edge that added it) or
/// a locally uploaded asset (`origin = "local"`). Positions are unique per
/// `(node_id, port_id)`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "node_inputs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub node_id: String,
    pub port_id: String,
    pub position: i64,
    pub kind: String,
    pub origin: String,
    pub edge_id: Option<String>,
    pub item_id: Option<String>,
    pub asset_id: Option<String>,
    pub text: String,
    pub meta_json: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::nodes::Entity",
        from = "Column::NodeId",
        to = "super::nodes::Column::Id",
        on_delete = "Cascade",
        on_update = "Cascade"
    )]
    Node,
    #[sea_orm(
        belongs_to = "super::edges::Entity",
        from = "Column::EdgeId",
        to = "super::edges::Column::Id",
        on_delete = "Cascade",
        on_update = "Cascade"
    )]
    Edge,
    #[sea_orm(
        belongs_to = "super::result_items::Entity",
        from = "Column::ItemId",
        to = "super::result_items::Column::Id",
        on_delete = "Restrict",
        on_update = "Cascade"
    )]
    Item,
    #[sea_orm(
        belongs_to = "super::assets::Entity",
        from = "Column::AssetId",
        to = "super::assets::Column::Id",
        on_delete = "Restrict",
        on_update = "Cascade"
    )]
    Asset,
}

impl Related<super::nodes::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Node.def()
    }
}

impl Related<super::assets::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Asset.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
