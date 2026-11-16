//! Helpers shared by every command transaction.

pub(in crate::mutation) mod edges;
pub(in crate::mutation) mod inputs;
pub(in crate::mutation) mod nodes;
pub(in crate::mutation) mod runs;

use sea_orm::{DatabaseTransaction, DbErr};

use crate::document;
use crate::edge_index;
use crate::types::ChangeSet;

use super::Mutation;

/// The end of every command transaction: rebuild the boxes of connectors
/// whose endpoint moved, then bump the document revision.
pub(in crate::mutation) fn finish_tx(txn: &DatabaseTransaction) -> Result<i64, DbErr> {
    edge_index::flush_geometry_tx(txn)?;
    document::bump_rev(txn)
}

pub(in crate::mutation) fn no_op(txn: &DatabaseTransaction) -> Result<Mutation, DbErr> {
    Ok(Mutation::commit(
        ChangeSet::empty(document::current_rev(txn)? as f64),
        Vec::new(),
        Vec::new(),
    ))
}
