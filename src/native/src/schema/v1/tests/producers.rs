use super::*;

#[test]
fn result_items_and_inputs_enforce_positions_and_producer_shape() {
    let conn = memory();
    create(&conn, "Inputs").expect("create v1");
    insert_node(&conn, "n1", "source");
    insert_node(&conn, "n2", "target");
    let source_seq: i64 = query_one(&conn, "SELECT seq FROM nodes WHERE id = 'n1'", vec![])
        .expect("read source seq")
        .try_get_by_index(0)
        .expect("source seq");
    execute(
        &conn,
        "INSERT INTO result_batches (id, node_id, node_seq, trigger, status, created_at) \
         VALUES ('b1', 'n1', ?1, 'run', 'running', 0)",
        vec![source_seq.into()],
    )
    .expect("insert a running batch");
    execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i1', 'b1', 0, 'out', 'text', 'hello')",
        vec![],
    )
    .expect("insert an item");
    execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i2', 'b1', 0, 'out2', 'text', 'other port')",
        vec![],
    )
    .expect("same position on another port");
    let duplicate_item = execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i3', 'b1', 0, 'out', 'text', 'duplicate')",
        vec![],
    );
    assert!(duplicate_item.is_err(), "duplicate item position must fail");
    let duplicate_other_port = execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i4', 'b1', 0, 'out2', 'text', 'duplicate')",
        vec![],
    );
    assert!(
        duplicate_other_port.is_err(),
        "duplicate position on another port must fail"
    );
    execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i5', 'b1', 1, 'out', 'text', 'second position')",
        vec![],
    )
    .expect("next position on the same port");
    let duplicate_second_position = execute(
        &conn,
        "INSERT INTO result_items (id, batch_id, position, port_id, kind, text) \
         VALUES ('i6', 'b1', 1, 'out', 'text', 'duplicate')",
        vec![],
    );
    assert!(
        duplicate_second_position.is_err(),
        "duplicate second position must fail"
    );
    execute(
        &conn,
        "UPDATE result_batches SET status = 'done', finished_at = 0 WHERE id = 'b1'",
        vec![],
    )
    .expect("settle the batch");
    let item_update = execute(
        &conn,
        "UPDATE result_items SET text = 'changed' WHERE id = 'i1'",
        vec![],
    );
    assert!(item_update.is_err(), "result items are immutable");
    let item_delete = execute(&conn, "DELETE FROM result_items WHERE id = 'i1'", vec![]);
    assert!(item_delete.is_err(), "settled item delete must fail");
    let terminal_update = execute(
        &conn,
        "UPDATE result_batches SET status = 'failed' WHERE id = 'b1'",
        vec![],
    );
    assert!(terminal_update.is_err(), "terminal batch update must fail");
    let wrong_count = execute(
        &conn,
        "UPDATE result_batches SET item_count = 5 WHERE id = 'b1'",
        vec![],
    );
    assert!(wrong_count.is_err(), "item_count must stay derived");

    insert_edge(&conn, "e1", "n1", "n2");
    execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in1', 'n2', 'in', 0, 'text', 'edge', 'e1', 'i1', 'hello', 0)",
        vec![],
    )
    .expect("insert a matching edge input");
    execute(
        &conn,
        "INSERT INTO edges \
         (id, from_id, to_id, from_port, to_port, port_kind, from_offset, to_offset) \
         VALUES ('e2', 'n1', 'n2', 'out', 'in2', 'text', 0, 0)",
        vec![],
    )
    .expect("insert a second input port edge");
    execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in2', 'n2', 'in2', 0, 'text', 'edge', 'e2', 'i1', 'hello', 0)",
        vec![],
    )
    .expect("same position on another port");
    let duplicate_input = execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in-dup', 'n2', 'in', 0, 'text', 'edge', 'e1', 'i1', 'hello', 0)",
        vec![],
    );
    assert!(
        duplicate_input.is_err(),
        "duplicate input position must fail"
    );
    let duplicate_other_port = execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in-dup2', 'n2', 'in2', 0, 'text', 'edge', 'e2', 'i1', 'hello', 0)",
        vec![],
    );
    assert!(
        duplicate_other_port.is_err(),
        "duplicate position on another port must fail"
    );
    execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in3', 'n2', 'in', 1, 'text', 'edge', 'e1', 'i1', 'hello', 0)",
        vec![],
    )
    .expect("next position on the same port");
    let duplicate_second_position = execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in-dup3', 'n2', 'in', 1, 'text', 'edge', 'e1', 'i1', 'hello', 0)",
        vec![],
    );
    assert!(
        duplicate_second_position.is_err(),
        "duplicate second input position must fail"
    );
    let wrong_text = execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in-bad-text', 'n2', 'in', 2, 'text', 'edge', 'e1', 'i1', 'wrong', 0)",
        vec![],
    );
    assert!(wrong_text.is_err(), "producer text mismatch must fail");
    let wrong_port = execute(
        &conn,
        "INSERT INTO node_inputs \
         (id, node_id, port_id, position, kind, origin, edge_id, item_id, text, created_at) \
         VALUES ('in4', 'n2', 'other', 1, 'text', 'edge', 'e1', 'i1', 'hello', 0)",
        vec![],
    );
    assert!(wrong_port.is_err(), "producer port mismatch must fail");
    let wrong_update = execute(
        &conn,
        "UPDATE node_inputs SET text = 'wrong' WHERE id = 'in1'",
        vec![],
    );
    assert!(wrong_update.is_err(), "producer update mismatch must fail");
    let wrong_port_update = execute(
        &conn,
        "UPDATE node_inputs SET port_id = 'other' WHERE id = 'in1'",
        vec![],
    );
    assert!(
        wrong_port_update.is_err(),
        "producer port update mismatch must fail"
    );
}
