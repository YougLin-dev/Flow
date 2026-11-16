//! Demo document seeding.

use std::collections::BTreeMap;

use sea_orm::{
    ActiveValue::{Set, Unchanged},
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
};

use super::support::node_row;
use super::tx::edges::{connect_edge_tx, edge_summary};
use super::tx::finish_tx;
use super::tx::nodes::{find_node_opt_tx, find_node_tx, insert_node_tx};
use super::tx::runs::{insert_result_item_tx, insert_running_batch_tx, settle_batch_tx};
use crate::clock::now_ms;
use crate::document;
use crate::entity::nodes as node_rows;
use crate::types::ChangeSet;

/// Writes the demo seed in one transaction. It refuses a document that has
/// already seeded or holds any node, so it can never duplicate a project.
/// The flag reports whether it wrote, so a no-op seed leaves history alone.
pub fn seed_document(
    conn: &DatabaseConnection,
    input: crate::types::SeedDocumentInput,
) -> Result<(ChangeSet, bool), String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let document = document::current(txn)?;
        if document.demo_seeded != 0 {
            return Ok((empty_change_tx(txn)?, false));
        }
        if document.node_count != 0 || document.edge_count != 0 {
            return Err(DbErr::Custom(
                "the document is not empty; seed needs a new project".to_owned(),
            ));
        }
        if input.nodes.is_empty() {
            return Err(DbErr::Custom("a seed needs at least one node".to_owned()));
        }
        if input.batch.is_some() != input.item.is_some() {
            return Err(DbErr::Custom(
                "a seed's manual batch and item come together".to_owned(),
            ));
        }

        let mut changed: BTreeMap<String, node_rows::Model> = BTreeMap::new();
        for node in &input.nodes {
            let row = insert_node_tx(txn, node)?;
            let model = find_node_tx(txn, &row.id)?;
            changed.insert(model.id.clone(), model);
        }

        if let (Some(batch), Some(item)) = (&input.batch, &input.item) {
            if batch.status != "done" {
                return Err(DbErr::Custom(
                    "a seed's manual batch must be done".to_owned(),
                ));
            }
            insert_running_batch_tx(txn, batch)?;
            insert_result_item_tx(txn, &batch.id, item)?;
            settle_batch_tx(txn, &batch.id, &batch.status, batch.error.as_deref())?;
            let node = find_node_tx(txn, &batch.node_id)?;
            let updated = node_rows::Entity::update(node_rows::ActiveModel {
                seq: Unchanged(node.seq),
                body: Set(item.text.clone()),
                status: Set("done".to_owned()),
                output_batch_id: Set(Some(batch.id.clone())),
                rev: Set(node.rev + 1),
                updated_at: Set(now_ms()),
                ..Default::default()
            })
            .exec(txn)?;
            changed.insert(updated.id.clone(), updated);
        }

        let mut edges_changed = Vec::new();
        for edge in &input.edges {
            let connected = connect_edge_tx(txn, edge)?;
            edges_changed.push(edge_summary(
                &connected.edge,
                &connected.source,
                &connected.target,
            ));
        }
        if !input.edges.is_empty() {
            for edge in &input.edges {
                if let Some(node) = find_node_opt_tx(txn, &edge.to_id)? {
                    changed.insert(node.id.clone(), node);
                }
            }
        }

        // The marker makes the seed a one-time event: deleting every node and
        // reopening does not reseed; only a new project or a reset does.
        crate::entity::document::Entity::update(crate::entity::document::ActiveModel {
            id: Unchanged(document::ROW_ID),
            demo_seeded: Set(1),
            updated_at: Set(now_ms()),
            ..Default::default()
        })
        .exec(txn)?;

        let rev = finish_tx(txn)?;
        Ok((
            ChangeSet {
                rev: rev as f64,
                changed: changed
                    .into_values()
                    .map(|row| node_row(&row).summary())
                    .collect(),
                removed: Vec::new(),
                edges_changed,
                edges_removed: Vec::new(),
            },
            true,
        ))
    })
    .map_err(|error| error.to_string())
}

fn empty_change_tx(txn: &DatabaseTransaction) -> Result<ChangeSet, DbErr> {
    Ok(ChangeSet {
        rev: document::current_rev(txn)? as f64,
        changed: Vec::new(),
        removed: Vec::new(),
        edges_changed: Vec::new(),
        edges_removed: Vec::new(),
    })
}
