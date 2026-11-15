use sea_orm::entity::prelude::*;

/// The singleton `document` row of a project package. It carries the stable
/// project identity, the undo-independent revision, the trigger-maintained
/// counts and bounds, the saved camera and the lifecycle flags. v1 has
/// exactly one row, `id = 1`, and the row is never deleted or replaced.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "document")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i32,
    pub project_id: String,
    pub title: String,
    pub rev: i64,
    pub node_count: i64,
    pub edge_count: i64,
    pub demo_seeded: i64,
    pub clean_shutdown: i64,
    pub min_x: Option<f64>,
    pub max_x: Option<f64>,
    pub min_y: Option<f64>,
    pub max_y: Option<f64>,
    pub bounds_exact: i64,
    pub camera_x: f64,
    pub camera_y: f64,
    pub camera_zoom: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
