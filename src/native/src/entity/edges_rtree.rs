use sea_orm::entity::prelude::*;

/// The RTree view of a connector's world-space curve bounds. Its `id` is the
/// edge's SQLite rowid: `edges.id` is a string, and an RTree key must be an
/// integer. See `edge_index.rs` for the bounds and their maintenance.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "edges_rtree")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
