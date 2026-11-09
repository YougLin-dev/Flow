use sea_orm::entity::prelude::*;

/// One ordered input item of a node. An item either references a result item
/// from an upstream batch (`origin = "edge"`, with the edge that added it) or
/// a locally uploaded asset (`origin = "local"`).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "node_inputs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub node_id: String,
    pub position: i32,
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
        on_delete = "Cascade"
    )]
    Node,
}

impl Related<super::nodes::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Node.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
