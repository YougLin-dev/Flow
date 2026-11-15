//! SeaORM entities for the frozen v1 document schema.
//!
//! Ordinary tables map one-to-one to entities. `nodes_rtree`, `edges_rtree`
//! and `nodes_fts` are SQLite virtual tables: they are mapped for typed
//! reads, but their DDL, triggers and SQLite-only ranking/match expressions
//! live in `schema/v1.sql`, `search.rs` and `edge_index.rs`.

pub mod assets;
pub mod document;
pub mod edges;
pub mod edges_rtree;
pub mod node_inputs;
pub mod nodes;
pub mod nodes_fts;
pub mod nodes_rtree;
pub mod result_batches;
pub mod result_items;
