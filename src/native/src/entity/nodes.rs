use sea_orm::entity::prelude::*;

/// A canvas node. `seq` is the immutable SQLite key used by the node RTree,
/// the trigger-maintained FTS index and the batch ownership chain; `id` is
/// the stable identifier the UI uses. `tags` is the canonical newline-joined
/// form (no leading, trailing or doubled newline).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "nodes")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub seq: i64,
    #[sea_orm(unique)]
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tags: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    pub data_json: String,
    /// The kind's opaque settings (prompt, model, aspect, …).
    pub settings_json: String,
    /// idle / running / done / failed / cancelled / stale / interrupted.
    pub status: String,
    /// The batch this node currently shows, if it has ever produced one.
    pub output_batch_id: Option<String>,
    pub rev: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
