//! The frozen release schema and the project-file open guard.
//!
//! `v1` owns the literal DDL file, the identity check and the only DDL
//! writer. The live open path runs that guard on the production connection;
//! SQLite's FTS5 and RTree tables are declared in the frozen file with their
//! triggers, so no schema is generated from entity definitions.

pub(crate) mod maintenance;
pub mod v1;
