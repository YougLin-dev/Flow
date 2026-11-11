# Plan 012: Write each moved card and each connector box once per gesture commit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/native/src/mutation.rs src/native/src/edge_index.rs src/native/src/db.rs src/native/src/lib.rs src/native/Cargo.toml docs/plans/rust-core.md`
> This plan depends on plans 009 and 011. Confirm each dependency's row is
> DONE in `plans/README.md`. Changes made by these plans are expected:
> 009 extends the 100k bench inside `db.rs`; 011 threads `max_cards`
> through `Document.scene` and may add a `FarEndpoint` struct next to
> `scene.rs`. Compare only the excerpts this plan edits. A mismatch NOT
> explained by a dependency plan is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/009-bench-coverage.md, plans/011-scene-read-budget.md
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `498f81e`, 2026-11-11 — plans 009 and 011 landed.
  `mutation.rs` and `edge_index.rs` are unchanged; `db.rs`'s scene tests moved
  down, and `Database::scene` now takes a third `max_cards: u64` argument, so
  this plan's new test reads pass `crate::viewport::NODE_LIMIT`. `scene.rs`'s
  `EDGE_CHUNK` is at line 21.
- **Executed at**: commit `3031d1c`, 2026-11-11. The Step 5 red-first premise
  did not hold: the old per-card path already commits a correct final box
  because the last moved endpoint's sync re-reads the already-updated row.
  All three new tests passed on the old code and remain as RTree-consistency
  regressions; the benchmark (~514 → ~250 ms commit, ~499 → ~219 ms undo,
  ~531 → ~245 ms redo) proves the reduced write work. Do not force those
  tests red later.

## Why this matters

Releasing a drag or resize calls `Document.set_node_bounds(...)` once with
the moved cards' new rects. Today that one call lands as a cascade of tiny
statements that, for an 11-card/26-connector select-all drag, runs ≈290 SQL
statements where ≈50 would do. Breakdown of the waste:

- For each moved card, `mutation::set_node_bounds` (`src/native/src/mutation.rs:106-149`) calls `find_node_tx` (one
  SELECT), then `update_bounds_tx` (`mutation.rs:1262-1294`), which runs:
  - one `UPDATE`, plus SeaORM's own re-`SELECT` of the updated row (the
    crate is built with `default-features = false` on `sea-orm-sync` and
    `sqlite-use-returning-for-3_35` is NOT enabled — see
    `src/native/Cargo.toml:13-17`),
  - one `DELETE FROM nodes_rtree` and one `INSERT INTO nodes_rtree`,
  - one call into `edge_index::sync_node_edges(txn, &updated.id)`
    (`edge_index.rs:100-129`), which re-reads the moved node, loads its
    incident edges, per edge finds the far node, selects the edge rowid,
    then `DELETE` + `INSERT`s one `edges_rtree` row.
- A connector whose BOTH cards were moved runs that whole cycle twice — the
  first time with a stale far end that the second write has to overwrite.
- `bump_document_rev` (`mutation.rs:1749-1763`) adds a SELECT + UPDATE.

The same helpers are reused by `apply_ops`'s `Bounds` arm
(`mutation.rs:989-999`), so undo/redo of the same drag pays the same cost
again.

When this lands, a gesture commit does:

1. One chunked `IN` query to load all `before` rows.
2. One `UPDATE` per moved card (no re-select) for its new geometry.
3. One batched RTree update per node (`DELETE`+`INSERT` for the seq).
4. ONE batch: the union of incident edges, resolved against the new rects
   plus one narrow `IN` query for the far ends not in the moved set,
   written as one DELETE and one INSERT per edge box.

The `Mutation`'s change set (rev, changed NodeSummary rows with `rev + 1`,
`updated_at`, all other fields) MUST be identical to today's, because TSX
`applyChangeSet` reads it.

## Current state

### The entry point

`src/native/src/mutation.rs:106-149`:

```rust
pub fn set_node_bounds(
    conn: &DatabaseConnection,
    bounds: Vec<NodeBounds>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let mut changed = Vec::with_capacity(bounds.len());
        let mut forward = Vec::with_capacity(bounds.len());
        let mut inverse = Vec::with_capacity(bounds.len());

        for next in &bounds {
            let before = find_node_tx(txn, &next.id)?;
            let row = update_bounds_tx(txn, &before, next.x, next.y, next.width, next.height)?;
            changed.push(row.summary());
            forward.push(HistoryOp::Bounds { ... });
            inverse.push(HistoryOp::Bounds { ... });
        }

        let rev = bump_document_rev(txn)?;
        Ok(Mutation { changes: ChangeSet { rev, changed, .. }, forward, inverse })
    })
    .map_err(|error| error.to_string())
}
```

### The per-card helper

`src/native/src/mutation.rs:1262-1294`:

```rust
fn update_bounds_tx(
    txn: &DatabaseTransaction,
    before: &nodes::Model,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<NodeRow, DbErr> {
    let updated = nodes::Entity::update(nodes::ActiveModel {
        seq: Unchanged(before.seq),
        x: Set(x),
        y: Set(y),
        width: Set(width),
        height: Set(height),
        rev: Set(before.rev + 1),
        updated_at: Set(now_ms()),
        ..Default::default()
    })
    .exec(txn)?;

    nodes_rtree::Entity::delete_by_id(updated.seq).exec(txn)?;
    nodes_rtree::Entity::insert(nodes_rtree::ActiveModel {
        id: Set(updated.seq),
        min_x: Set(updated.x),
        max_x: Set(updated.x + updated.width),
        min_y: Set(updated.y),
        max_y: Set(updated.y + updated.height),
    })
    .exec(txn)?;
    edge_index::sync_node_edges(txn, &updated.id)?;

    Ok(node_row(&updated))
}
```

The `nodes::Entity::update(active).exec(txn)` call is what emits the
re-`SELECT`: SeaORM, without `sqlite-use-returning-for-3_35`, defaults to
emitting UPDATE then SELECT-by-primary-key.

### The edge sync walk

`src/native/src/edge_index.rs:100-129`:

```rust
pub fn sync_node_edges(conn: &impl ConnectionTrait, node_id: &str) -> Result<(), DbErr> {
    let Some(node) = find_node(conn, node_id)? else {
        return Ok(());
    };
    let rows = edges::Entity::find()
        .filter(edges::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(
            Condition::any()
                .add(edges::Column::FromId.eq(node_id))
                .add(edges::Column::ToId.eq(node_id)),
        )
        .all(conn)?;
    for edge in rows {
        let from = if edge.from_id == node_id {
            Some(node.clone())
        } else {
            find_node(conn, &edge.from_id)?
        };
        let to = if edge.to_id == node_id {
            Some(node.clone())
        } else {
            find_node(conn, &edge.to_id)?
        };
        match (from, to) {
            (Some(from), Some(to)) => write_bounds(conn, &edge, &from, &to)?,
            _ => remove_edge(conn, &edge.id)?,
        }
    }
    Ok(())
}
```

Plus the per-edge `edge_rowid` lookup
(`edge_index.rs:191-200`) and the DELETE+INSERT
(`edge_index.rs:166-174`).

### Undo path

`src/native/src/mutation.rs:989-999` — the `apply_ops` `Bounds` arm calls
`update_bounds_tx` once per op.

### Why SeaORM is built without RETURNING

`src/native/Cargo.toml:13-17`:

```toml
sea-orm-sync = { version = "2.0.4", default-features = false, features = [
  "sync",
  "macros",
  "rusqlite",
] }
```

We do NOT enable `sqlite-use-returning-for-3_35` in this plan: that is a
global behaviour change across every SeaORM write in the crate, and the
brief keeps it out of scope. Note it in your commit body as a follow-up
consideration.

### Conventions that apply

- CLAUDE.md "Database access is ORM-first": ordinary tables
  (`nodes`, `edges`) go through SeaORM/SeaQuery entities; raw SQL is
  allowed only in the FTS5/RTree adapter (`edge_index.rs`) and migrations.
  The node-side RTree mutations (`nodes_rtree`) are modelled as a SeaORM
  entity too — use its `delete_by_id` and `insert`, not raw SQL.
- §8.2 of `docs/standards.md` (lines 373-384): frame budgets are SHOULD
  targets; no CI assertions.
- §9 (lines 433-475): a reproducible perf fix adds a regression test that
  fails before and passes after. For this plan, correctness regressions
  are the concern — the test is on RTree consistency after the refactor.
- Chunked `IN` queries: `EDGE_CHUNK = 400` in `scene.rs:21` is the
  pattern. `find_node_tx` is one id at a time today; introduce a chunked
  helper and route both old and new paths through it.

### Existing tests to keep green

The off-screen-connector invariant tests in `db.rs`:

- `a_scene_reads_the_far_port_of_an_edge_to_an_off_screen_card`
  (`db.rs:939-985`),
- `a_scene_reads_a_connector_between_two_off_screen_cards`
  (`db.rs:1021-1052`),
- `moving_a_card_moves_its_connector_in_the_edge_index`
  (`db.rs:1108-1138`),
- `deleting_and_undoing_edges_keeps_the_edge_index_in_step`
  (`db.rs:1140-1181`).

The undo tests for `set_node_bounds` — find them by grep:
`grep -n "set_node_bounds\|Bounds\s*{" src/native/src/db.rs src/native/src/mutation.rs`.

## Commands you will need

| Purpose                                  | Command                                                          | Expected on success    |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Run all Rust unit tests                  | `bun run test`                                                   | exit 0                 |
| Run only the native crate                | `cargo test --manifest-path src/native/Cargo.toml`               | exit 0                 |
| Filter a Rust test by name               | `cargo test --manifest-path src/native/Cargo.toml moving_a_card` | matching tests pass    |
| Run the ignored 100k benchmark (release) | `bun run test:bench`                                             | exit 0, prints timings |
| Full gate (clippy + fmt + tsc + lint)    | `bun run check`                                                  | exit 0                 |
| Format check on a Rust file              | `cargo fmt --manifest-path src/native/Cargo.toml -- --check`     | exit 0                 |

## Scope

**In scope** (the only files you should modify):

- `src/native/src/mutation.rs` (the batched helper; set_node_bounds and the
  apply_ops Bounds arm both route through it)
- `src/native/src/edge_index.rs` (a batched `sync_edges_for_nodes`; chunk
  helper for the incident-edge union)
- `src/native/src/db.rs` (new regression tests; hook into the bench)
- `docs/plans/rust-core.md` (before/after bench numbers for setNodeBounds)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/native/src/viewport.rs`, `src/native/src/scene.rs`,
  `src/native/src/lib.rs` — plan 011 owns those.
- `src/native/Cargo.toml` — DO NOT enable `sqlite-use-returning-for-3_35`
  here. The brief explicitly defers it; changing the feature set would
  affect every SeaORM write and is a separate review.
- `src/native/src/history.rs` — the `HistoryOp::Bounds` shape is unchanged.
- `src/native/src/types.rs` — `ChangeSet`, `NodeBounds`, `NodeSummary`
  shapes are unchanged.
- `src/flow/` — TSX callers and `applyChangeSet` semantics are unchanged.

## Git workflow

- Branch: `git switch -c advisor/012-gesture-commit-sql`
- Commit per logical step (capture baseline; batched helper; set_node_bounds
  routes through it; apply_ops Bounds routes through it; regression tests;
  bench deltas).
- Conventional Commits with a lower-case imperative subject and an
  explanatory body, matching `git log` — e.g.
  `perf: keep canvas gestures to one update per moved card` (1956ebb),
  `feat: keep a single-card box selection a normal selection` (a8c7884).
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Capture a baseline for `set_node_bounds`

Plan 009's extended bench must already print a `setNodeBounds` timing for
1 000 nodes plus its undo and redo. Run:

```sh
bun run test:bench
```

Copy those three numbers (avg over the runs the bench prints) into a new
"before 012" line in `docs/plans/rust-core.md`, dated, labelled with the
build config.

**Verify**: `bun run test:bench` exits 0; the "before 012" block is in
`docs/plans/rust-core.md`.

### Step 2: A batched edge-index sync helper

In `src/native/src/edge_index.rs`, add a new public function:

```rust
pub fn sync_edges_for_nodes(
    conn: &impl ConnectionTrait,
    nodes_by_id: &std::collections::HashMap<String, nodes::Model>,
) -> Result<(), DbErr>
```

Semantics:

1. If `nodes_by_id.is_empty()`, return Ok.
2. Load the union of incident edges in chunks: build one
   `edges::Entity::find()` with `Condition::any()` over
   `FromId.is_in(chunk)` / `ToId.is_in(chunk)` per 400-id chunk of
   `nodes_by_id.keys()`. Collect into a `BTreeMap<String, edges::Model>`
   (so the same edge coming in via the from-side and the to-side chunk ends
   up as one row; set the BTreeMap key to the edge id).
3. Resolve each edge's far endpoint: look in `nodes_by_id` first; collect
   the ids that are missing into a `BTreeSet`. Chunk-query those ids (400
   per chunk) through SeaORM `nodes::Entity::find()` with
   `Id.is_in(chunk)`, collecting into a separate map. (Nodes in this second
   map have NOT been moved, so their stored x/y/w/h match the current row.)
4. For each unique edge in the BTreeMap, look up its from-node and to-node
   in the combined endpoints map. If both are present, call `write_bounds`
   once per edge. If either is missing (mid-undo), call `remove_edge` once
   per edge — mirroring the old `sync_node_edges` semantics.

Note: `write_bounds` already does the `edge_rowid` lookup and DELETE+INSERT
on `edges_rtree` (`edge_index.rs:153-176`). Keep that as-is — the batched
helper buys us the UNION of edges (no double-write when both ends moved),
the avoidance of the per-edge `find_node` round-trips, and a chunkable
shape whose `edge_rowid` lookups happen once per edge and not twice.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml edge_index`
passes (the existing box tests stay green; no new tests for this step yet
since it's not wired in).

### Step 3: A batched `set_node_bounds` body

In `src/native/src/mutation.rs`, add a private helper:

```rust
fn set_node_bounds_batched(
    txn: &DatabaseTransaction,
    bounds: &[NodeBounds],
) -> Result<(Vec<NodeRow>, Vec<(NodeRow, NodeBounds)>), DbErr>
```

Returns the `changed` rows in input order plus a list of `(before, after)` pairs
for building forward/inverse history ops. Implementation:

1. Build `ids: Vec<String>` from `bounds`. Chunk-load every `before` row
   via SeaORM `find().filter(Id.is_in(chunk))` in chunks of 400. If any id
   is missing, return `DbErr::RecordNotFound(format!("node {id} was not
   found"))`, matching the existing `find_node_tx` behaviour.
2. Build `nodes_by_id: HashMap<String, nodes::Model>` from the `before`
   rows.
3. For each entry in `bounds`, do the geometry math:
   `let before = &nodes_by_id[&next.id]; let new_rev = before.rev + 1; let now = now_ms();`
4. Issue ONE SeaORM `UPDATE` per row using `nodes::Entity::update_many()`
   with `col_expr` for x, y, width, height, rev, updated_at, filtering
   by `Seq.eq(before.seq)`. Do NOT use `nodes::Entity::update(active)`
   — that triggers the re-SELECT. `update_many` does not.
5. Build each `NodeRow` by calling the existing `node_row(&before)` helper
   (currently `mutation.rs:1765-1785`), then mutate **only** its `x`, `y`,
   `width`, `height`, `rev = before.rev + 1`, and `updated_at = now` fields.
   This preserves `created_at` and every non-geometry field; do not rebuild a
   long field-by-field `NodeRow` literal. The public `Mutation` receives the
   `NodeRow.summary()` rows in input order, preserving the existing
   `tags_json` deserialization through `node_row`.
6. For each entry, `nodes_rtree::Entity::delete_by_id(before.seq).exec(txn)?`
   then `nodes_rtree::Entity::insert(...)`. Same shape as today.
7. Call `edge_index::sync_edges_for_nodes(txn, &nodes_by_id_UPDATED)` where
   the map's `nodes::Model` is a clone of `before` with x/y/width/height
   replaced and rev/updated_at updated. Build this updated-model map as you
   go so the edge-index helper sees the post-move geometry, mirroring what
   `update_bounds_tx` used to pass to `sync_node_edges`.

The public `set_node_bounds` in `mutation.rs:106-149` then becomes:

```rust
pub fn set_node_bounds(
    conn: &DatabaseConnection,
    bounds: Vec<NodeBounds>,
) -> Result<Mutation, String> {
    conn.transaction::<_, _, DbErr>(|txn| {
        let (changed_rows, pairs) = set_node_bounds_batched(txn, &bounds)?;
        let changed = changed_rows.iter().map(|row| row.summary()).collect();
        let mut forward = Vec::with_capacity(pairs.len());
        let mut inverse = Vec::with_capacity(pairs.len());
        for (before, after_bounds) in &pairs {
            forward.push(HistoryOp::Bounds {
                id: after_bounds.id.clone(),
                x: after_bounds.x, y: after_bounds.y,
                width: after_bounds.width, height: after_bounds.height,
            });
            inverse.push(HistoryOp::Bounds {
                id: before.id.clone(),
                x: before.x, y: before.y,
                width: before.width, height: before.height,
            });
        }
        let rev = bump_document_rev(txn)?;
        Ok(Mutation { changes: ChangeSet { rev: rev as f64, changed, .. }, forward, inverse })
    })
    .map_err(|error| error.to_string())
}
```

The old `update_bounds_tx` can stay temporarily (it's still used by the
apply_ops Bounds arm in step 4). Remove it (or leave a thin shim that calls
into `set_node_bounds_batched(txn, &[one])` and returns the changed row) in
step 4 once both call sites are routed.

**Verify**: `bun run test` exits 0; the off-screen-connector and undo tests
pass.

### Step 4: Route the apply_ops Bounds arm through the batched helper (coalesced per undo/redo)

In `src/native/src/mutation.rs:989-999` (inside `apply_ops`'s `for op in ops`
loop), each `HistoryOp::Bounds { .. }` op is currently applied alone. The
same **stale-far-end bug** lives there: undo/redo of a both-ends-moved drag
replays one Bounds op per moved card, so `update_bounds_tx` (and even
`set_node_bounds_batched(&[one])`) would still see a half-applied geometry
set on the second card.

Therefore this step MUST coalesce the inverse `Bounds` ops of the run into a
single call. Do two things:

1. Before the loop, collect every `HistoryOp::Bounds { id, x, y, width,
   height }` in the run into one `Vec<NodeBounds>` (preserving the inverse
   order; duplicates of the same id must collapse to the last op's rect for
   that id — `HistoryOp::Bounds` is recorded in per-card inverse order for
   undo and forward order for redo, and within one undo/redo run a given card
   appears at most once per gesture it belongs to).
2. Replace the body of the `HistoryOp::Bounds { .. }` arm with a no-op:
   each Bounds op contributes its `NodeBounds` to the collected vec and
   otherwise does not run.
3. Immediately after the loop, when the collected vec is non-empty, call
   `set_node_bounds_batched(txn, &collected)` ONCE and push each row's
   `summary()` into `changed`.
4. **Preserve order for mixed runs.** Coalescing is safe only when every op
   in the run is `HistoryOp::Bounds` (the gesture case). If the run contains
   any non-Bounds op, do not move the Bounds work to the end: apply each
   `Bounds` op at its position with `set_node_bounds_batched(txn, &[one])`
   and keep the surrounding ops in their recorded order. Never reorder a
   mixed undo/redo run to gain batching.

This is what makes the new both-ends regression test actually meaningful for
undo: on undo, the final left and right rects of the original drag are both
passed to `set_node_bounds_batched` together, so the index rewrites each
edge exactly once against the final pair. The plan's review finding — that
per-op traversal of the inverse Bounds ops would still produce a stale far
end — is resolved by this coalescing, not by the per-op routing the previous
revision suggested.

Once no caller of `update_bounds_tx` remains (the public `set_node_bounds`
is already routed by step 2, and the `apply_ops` Bounds arm is now routed
through the coalesced helper), delete the function.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml undo` and
`redo` tests pass (find them by `grep -n "fn.*undo\|fn.*redo" src/native/src/db.rs`);
`bun run test` exits 0.

### Step 5: Regression tests for the new path

Add tests in `src/native/src/db.rs` next to the existing index tests:

1. `moving_both_ends_of_a_connector_in_one_command_writes_its_box_once` —
   use two nodes and one connector with distinct old and new crossing regions
   (the pattern is `a_scene_reads_a_connector_between_two_off_screen_cards`,
   currently `db.rs:1021-1052`):

   - Insert `left` at (-5000, 0) and `right` at (5000, 0) with the ordinary
     text fixture's 200×84 size and z=0; call `connect(&db, "left-right",
     "left", "right")`. Both old port points are (-4800, 42) and (5000, 42).
   - Move **both** in one `db.set_node_bounds` call: `left = (-4000, 2000,
     200, 84)`, `right = (6000, 2000, 200, 84)`. Expected new ports, using
     existing `EdgePoint` semantics, are `EdgePoint::output(-4000, 2000,
     200, 84) == EdgePoint { x: -3800, y: 2042 }` and
     `EdgePoint::input(6000, 2000, 84) == EdgePoint { x: 6000, y: 2042 }`.
   - Query the public read `db.scene(Viewport { x: -4000, y: 1500,
     width: 10200, height: 2000 }, 2000.0, crate::viewport::NODE_LIMIT)`.
     Find the edge with id
     `left-right` (exactly one), and assert its `from_point`/`to_point` equal
     the expected values above. Find `left` and `right` in `scene.nodes` and
     verify they carry the NEW geometry: the ports must be based on these new
     rects, not a stale far-node row.
   - Assert `db.scene(Viewport { x: 0, y: 0, width: 800, height: 600 },
     0.0, crate::viewport::NODE_LIMIT)?.edges.iter().all(|edge| edge.id !=
     "left-right")`. **Margin must
     be 0 here**, not the new-region fixture's 2000. A 2000-unit margin would
     include the moved left card at y=2000 and legitimately return its edge
     through the node-touching half, even with a correct edge index. The old
     rect itself intersects the old edge box but neither moved card nor the
     new edge box. Only absence of `left-right` is asserted.
   - The stale-far-end discriminator is a fixed **left-of-the-moved-cards**
     probe `{ x: -3500, y: 1000, width: 500, height: 300 }`. Assert:

     ```rust
     let stale_probe = Viewport {
         x: -3_500.0,
         y: 1_000.0,
         width: 500.0,
         height: 300.0,
     };
     let after = db
         .scene(stale_probe, 0.0, crate::viewport::NODE_LIMIT)
         .expect("stale-endpoint probe");
     assert!(after.nodes.is_empty());
     assert!(after.edges.iter().all(|edge| edge.id != "left-right"));
     ```

     `connection_bounds((-3800,2042), (5000,42))` (the stale new-left/
     OLD-right state written by the per-card path) meets this band, while the
     true OLD box `(-4800,5000,42,42)` and NEW box
     `(-3800,6000,2042,2042)` do not. The band's x range -3500..-3000 excludes
     all four cards: new left is -4000..-3800, new right starts at 6000, and
     both original cards x<=-4800 or x>=5000 are far away. Hence no touching
     node can promote this edge; the public scene sees only an indexed box.

   - Never assert `connection_bounds` on `edge_index::viewport`'s
     `edges::Model`: that model has only edge id/document/endpoints/ports/
     kind/data fields, not RTree min/max coordinates. Do not add a production
     accessor or raw SQL just to inspect its private storage. Use the public
     `db.scene` port assertions and empty stale-probe scene above.

2. `undo_of_a_two_end_move_restores_both_rtree_boxes` — repeat the exact
   test-1 setup and command, then `db.undo()`. Read the OLD crossing viewport
   with **margin 0**; assert there are no returned nodes (both originals are
   outside), and `left-right` has original EdgePoints
   `Some(EdgePoint { x: -4800.0, y: 42.0 })` and `Some(EdgePoint {
   x: 5000.0, y: 42.0 })`. Do not use the new-region margin 2000 here: it
   would include old left at y=0 and return a touching card for a different
   reason. Assert test 1's new-region scene contains no `left-right`.
   Then use the same `stale_probe` with margin 0 and assert the edge is absent.
   That band also intersects the undo path's stale box from ORIGINAL-left
   (-4800,42) to NEW-right (6000,2042), but it intersects neither original
   node nor the actual old edge. This is the old per-card undo regression.
   Finish with `db.redo()` and all of test-1's public endpoint, old-region,
   and stale-probe assertions. No RTree row/field access is needed.
3. `set_node_bounds_change_set_shape_matches_baseline` — insert nodes with
   non-default kind/title/body/status/output_batch_id. The native Rust
   `db.set_node_bounds` returns `Mutation` via `run_mutation`; its
   `changes: ChangeSet` and `forward`/`inverse: Vec<HistoryOp>` are public.
   Read the result, and assert its `changes.rev = previous_rev + 1`, changed
   node `rev = before_rev + 1`, `updated_at >= before.updated_at` (equal is
   allowed within one millisecond), tags round-trip, `data_json`,
   `settings_json`, `status`, `output_batch_id` and every non-geometry field
   equal the before summary. Pattern-match `result.forward.as_slice()` to a
   **single-item slice** (there is no `Option` around `forward`) and assert
   `HistoryOp::Bounds { id, x, y, width, height }` equals the target with
   `matches!` plus explicit field assertions; `HistoryOp` needs no new
   `PartialEq` implementation. Compare `result.inverse` with the original
   geometry in the same way.
   Only then call public `db.undo()`/`db.redo()` to verify their change sets
   restore/reapply the target. This is the native API used in this test; the
   `Document.setNodeBounds` FFI wrapper separately discards history and is
   not this test's surface.

> **Execution note (2026-11-11):** the red-first premise below was disproved
> when this plan ran. Both tests passed on the old per-card path because the
> second moved endpoint's sync re-reads the first updated row, so the
> committed box is correct. The defect is redundant SQL work, not a stale
> final box. Keep these tests as RTree-consistency regressions and use the
> benchmark as the proof of one write per connector.

Test 1 and test 2 must be run against the unmodified per-card implementation
first (or with the final `set_node_bounds` call AND the `apply_ops` coalescing
disabled, each routed through the old per-card loop while retaining test
fixture helpers). Record the specific stale-box assertion failures before
implementing either the batched helper or the coalescing:

- test 1 must fail because `db.set_node_bounds` itself writes two stale far
  ends per connector.
- test 2 must fail because `db.undo()` runs the inverse ops one-by-one and
  leaves `left-right` indexed under a stale old-left / NEW-right box.
  This is the load-bearing red flag the fix in step 4 is designed to remove;
  if `db.undo()` already passes without coalescing, step 4 is wrong.
  If these public reads pass on the old path, the test does not prove the
  one-box-per-gesture defect and must be corrected before proceeding; do not
  rename it to imply a failure that was never observed.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml moving_both_ends`,
`cargo test --manifest-path src/native/Cargo.toml undo_of_a_two_end_move`,
`cargo test --manifest-path src/native/Cargo.toml set_node_bounds_change_set_shape_matches_baseline`,
and `bun run test` exit 0.

### Step 6: Record bench deltas

```sh
bun run test:bench
```

Add the "after 012" `setNodeBounds` and undo/redo numbers to
`docs/plans/rust-core.md`. No assertions on the numbers (§8.2).

**Verify**: `bun run test:bench` exits 0; the after-012 block is in
`docs/plans/rust-core.md`.

## Test plan

- Three new tests in `src/native/src/db.rs`, listed in step 5:
  `moving_both_ends_of_a_connector_in_one_command_writes_its_box_once`,
  `undo_of_a_two_end_move_restores_both_rtree_boxes`,
  `set_node_bounds_change_set_shape_matches_baseline`.
- Pattern: model after `a_scene_reads_a_connector_between_two_off_screen_cards`
  (`db.rs:1021-1052`) for the **public `db.scene` assertion style** and the
  test-name-first layout. The new stale-endpoint probe is a
  `Viewport { x: -3500, y: 1000, width: 500, height: 300 }` with margin 0; it
  excludes all node cards and the genuine old/new connector box. Test 1 and 2
  assert that per-card transient boxes no longer make that public scene return
  `left-right`; the full new/old reads assert its final `EdgePoint`s instead.
- Existing tests that MUST stay green on every step:
  - `moving_a_card_moves_its_connector_in_the_edge_index`
    (`db.rs:1108-1138`),
  - `deleting_and_undoing_edges_keeps_the_edge_index_in_step`
    (`db.rs:1140-1181`),
  - the `set_node_bounds` fixture/undo tests found by
    `grep -n "set_node_bounds\|Bounds\s*{" src/native/src/db.rs`.
- Verification: `bun run test` exits 0; the three new tests pass, with the
  both-ends-moved case failing if you revert step 3 to a per-card loop.

## Done criteria

- [ ] `bun run check` exits 0 (incl. clippy + fmt).
- [ ] `bun run test` exits 0.
- [ ] Remove the old per-card helper. Command (absence exits 0 on success):
      `! grep -n 'fn update_bounds_tx' src/native/src/mutation.rs`. This is the
      preferred DONE path.
- [ ] **Alternative only if the shim is required**: a documented compatibility
      `update_bounds_tx` of at most 10 code lines marshals one `NodeBounds`,
      calls `set_node_bounds_batched(txn, &[one])`, and returns the changed row
      plus before/after pair. Record which option was taken, and why a shim is
      necessary, in the commit body. Do not simultaneously require no symbol and
      a retained symbol; after choosing this fallback change the
      removal criterion to `grep -n -A 12 'fn update_bounds_tx'
  src/native/src/mutation.rs` and verify the ≤ 10-line shim and body-recorded
      reason before commit. Do not keep the original long per-card helper under a
      compatibility name.
- [ ] `grep -n "sync_edges_for_nodes" src/native/src/edge_index.rs src/native/src/mutation.rs` shows the new batched helper plus its call site.
- [ ] The three new tests pass with the new batched code. The original
      "reverting step 3 fails" expectation was disproved at execution (see the
      Status note): the old path also commits a correct final box, so the
      tests are consistency regressions and the benchmark proves the reduced
      write work. All regression assertions use public `db.scene` and
      `db.undo`/`db.redo`; no test reads a nonexistent
      `edges::Model.connection_bounds`.
- [ ] The existing tests in Test plan pass (both connector-index fixture
      tests plus every `set_node_bounds` fixture/undo test located by the grep).
- [ ] `docs/plans/rust-core.md` contains both the "before 012" and "after
      012" blocks with the bench timings.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The `ChangeSet`'s `changed` NodeSummary rows from the batched path
  diverge from the per-card path on any non-geometry field — re-audit how
  `node_row` builds the row from `nodes::Model` and ensure the batched
  constructor matches it byte-for-byte.
- A test relying on the OLD per-card `update_bounds_tx` semantics fails
  and you can't see how to preserve the behaviour through the batched
  helper. In particular, watch for any caller that depends on SeaORM's
  re-SELECT returning a fresh `nodes::Model` via internal state.
- `apply_ops` contains a `Bounds` op for an id whose row was deleted in
  an earlier op in the same transaction. The old per-card path
  short-circuits via `find_node_tx`'s `RecordNotFound`. Verify the new
  batched path also returns `RecordNotFound` for that case (it should,
  but please confirm).
- You discover you need to enable `sqlite-use-returning-for-3_35` to
  meet the perf target — that's a separate plan, STOP.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The chunked `IN` literal `400` is duplicated between `scene.rs:21
  (EDGE_CHUNK)` and the new helpers. Consider lifting it to a shared
  `pub(crate) const IN_CHUNK: usize = 400;` in a follow-up rather than in
  this plan — out of scope here.
- Future writers who add a `HistoryOp::Bounds` batch form (e.g.
  `Bounds` on a `Vec<...>`) should reuse `set_node_bounds_batched`
  directly; it's the one place where chunked reads and bulk RTree writes
  are wired together correctly.
- The batched helper writes SeaORM `UPDATE`s but never reads the just-
  updated row back. This is correct because every field other than the
  four geometry fields is unchanged, and `rev`/`updated_at` are explicit.
  If a future change adds a column whose value defaults differently than
  "copy from before," audit this helper.
- A reviewer should scrutinize: (a) the both-ends-moved test really does
  fail under the OLD code; (b) `bump_document_rev` ordering — it MUST run
  AFTER the batched writes so the rev in the change set reflects the new
  state; (c) the `HashMap<String, nodes::Model>` clone-before-update dance
  preserves `before.rev` for the history op while passing
  `before.rev + 1` to the DB write.
- Deferred deliberately: enabling `sqlite-use-returning-for-3_35`
  globally; consolidating the `nodes_rtree` DELETE+INSERT into a single
  `UPDATE ... WHERE id = ?` if SQLite's RTree allows it; adding batch
  multi-`INSERT` for `nodes_rtree` to remove the per-card overhead
  further. These are collar-bone optimisations, not load-bearing.
