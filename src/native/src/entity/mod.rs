//! SeaORM entities for the document database.
//!
//! Ordinary tables are mapped one-to-one to entities and are created from
//! these definitions. `nodes_rtree`, `nodes_fts` and `assets_fts` are SQLite
//! virtual tables: they are mapped for typed reads and writes, but their DDL
//! and the SQLite-only ranking/match expressions live in `search.rs`.

pub mod assets;
// The asset index is created now so the library search can land in P1.
#[allow(dead_code)]
pub mod assets_fts;
pub mod documents;
pub mod edges;
pub mod node_assets;
pub mod node_inputs;
pub mod nodes;
pub mod nodes_fts;
pub mod nodes_rtree;
pub mod result_batches;
pub mod result_items;
pub mod schema_migrations;
