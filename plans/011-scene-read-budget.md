# Plan 011: Read only the cards and connectors the canvas will keep

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/native/src/viewport.rs src/native/src/scene.rs src/native/src/edge_index.rs src/native/src/db.rs src/native/src/lib.rs src/native/src/types.rs src/native/Cargo.toml src/flow/viewport-controller.ts src/flow/scene.ts src/.nsh/types/@flow/native.d.ts docs/plans/rust-core.md`
> This plan depends on plans 009, 010, 007. Confirm each dependency's row is
> DONE in `plans/README.md`. Changes made by these plans are expected:
> 007 changes `scene.ts`; it does **not** edit
> `src/flow/viewport-controller.ts` (its preview changes are in
> `src/flow/preview-loader.ts`). Both 010 (single-flight) and this plan
> (per-read `maxCards`) edit the viewport controller, sequentially. The
> dependency chain is **004 (camera dispose) → 010 → 011 → 016**; do not
> treat 007 as a viewport-controller provider. In this plan's flow files,
> 010 changes `viewport-controller.ts`; 009 adds the 100k bench inside
> `db.rs`. Compare only the excerpts this plan edits. A mismatch NOT
> explained by a dependency plan is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/009-bench-coverage.md, plans/010-one-read-in-flight.md, plans/007-reads-wake-only-changes.md
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `300227c`, 2026-11-11 — plans 009 and 010 landed.
  The viewport call site now lives in `runReads()`
  (`src/flow/viewport-controller.ts:84-116`); the 100k bench and its helper
  functions are at the `db.rs` lines below; the Rust scene tests shifted by a
  few lines after plan 009.

## Why this matters

On a large, dense board the current scene read pulls far more data across the
FFI than the canvas will draw. Three concrete costs:

1. The node read (`src/native/src/viewport.rs`) selects all 14 columns of
   every row in rect+margin (body, `data_json`, `settings_json` included),
   sorts them, and returns up to `NODE_LIMIT = 2000`. The UI then keeps only
   300 cards below 15 % zoom, 800 below 40 %, and 2 000 otherwise
   (`src/flow/viewport-controller.ts:103-105`), slicing AFTER those rows have
   crossed the FFI (`src/flow/scene.ts:73-75`). At Fit over a large board we
   ship ~85 % dead bytes.
2. The connector half (`src/native/src/scene.rs:103-175`) unions "every
   connector touching ANY returned node" with "every connector whose curve
   box meets rect+margin" with no `LIMIT`, and the RTree half
   (`src/native/src/edge_index.rs:36-46`) returns full `edges::Model` rows.
   At Fit over a large, densely connected document this is tens of thousands
   of connectors.
3. The far-endpoint lookup (`src/native/src/scene.rs:157-169`) selects every
   column of `nodes` for the ids whose ports we need, even though we use only
   x,y,width,height.

When this lands the canvas keeps the same visual sample with a much smaller
FFI payload; the worker thread does less serialisation work and the QuickJS
engine allocates smaller arrays per read.

## Current state

### TSX side: caller, slicer and host types

`src/flow/viewport-controller.ts:90-106` — inside plan 010's `runReads()`
drain loop, which issues this once per actual read:

```ts
const { rect, margin } = this.visibleRect();
const generation = ++this.generation;
try {
  // ...
  const snapshot = await document.scene(rect, margin);
  if (
    !this.host.isDisposed() &&
    generation === this.generation &&
    snapshot.rev >= this.lastRev
  ) {
    this.lastRev = snapshot.rev;
    const camera = this.host.camera();
    const scale = camera?.scale ?? 1;
    const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
    scene.apply(snapshot, { maxCards });
```

`src/flow/scene.ts:69-75` — plan 007 added the surrounding `batch` and
record-identity work; the slicer is unchanged:

```ts
apply(snapshot: SceneSnapshot, options: { maxCards?: number } = {}): void {
  // ...
  const maxCards = options.maxCards ?? Number.POSITIVE_INFINITY;
  const nodes =
    snapshot.nodes.length > maxCards ? snapshot.nodes.slice(0, maxCards) : snapshot.nodes;
```

The generated TS type for `Document.scene` is in
`src/.nsh/types/@flow/native.d.ts:296`:

```ts
scene(rect: Viewport, margin: number): Promise<SceneSnapshot>;
```

This file is generated — never edit it by hand; it refreshes through the
normal build (`bun run check` triggers it).

### Rust side: `scene()` and the viewport read

`src/native/src/lib.rs:286-294`:

```rust
/// Everything the canvas needs for `rect`: visible nodes and their edges.
pub async fn scene(
    this: Instance<Self>,
    rect: Viewport,
    margin: f64,
) -> Result<SceneSnapshot, String> {
    let db = this.with(|document| document.db.clone());
    off_thread(move || db.scene(rect, margin)).await
}
```

`src/native/src/db.rs:258-260`:

```rust
pub fn scene(&self, rect: Viewport, margin: f64) -> Result<SceneSnapshot, String> {
    self.run(move |conn| scene::snapshot(conn, rect, margin))
}
```

`src/native/src/scene.rs:22-36`:

```rust
pub fn snapshot(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
) -> Result<SceneSnapshot, String> {
    let nodes = viewport::viewport(conn, rect.clone(), margin)?;
    let edges = edges_for_scene(conn, &nodes, &rect, margin)?;
    let rev = document::current_rev(conn).map_err(|error| error.to_string())?;
    ...
}
```

`src/native/src/viewport.rs:11-13`:

```rust
pub const NODE_LIMIT: u64 = 2_000;
```

The statement builder at `src/native/src/viewport.rs:67-137` selects fourteen
columns, sorts by in-view-then-z-then-hash-then-id, and applies
`.limit(NODE_LIMIT)`.

### The connector budgets and the off-screen-connector test

`src/native/src/scene.rs:133-137` — the RTree half that catches connectors
whose BOTH endpoints are off-screen but whose curve crosses the viewport:

```rust
// Edges whose curve crosses the viewport while both of their cards are
// outside the node read. The curve's box, not its endpoints, decides.
for row in edge_index::viewport(conn, &rect, margin).map_err(|error| error.to_string())? {
    found.insert(row.id.clone(), row);
}
```

`src/native/src/edge_index.rs:36-79` builds this query with no `LIMIT`.

The behavioural invariant that MUST keep working is the off-screen-connector
test `a_scene_reads_a_connector_between_two_off_screen_cards` at
`src/native/src/db.rs:953-983`, plus its neighbours
`moving_a_card_moves_its_connector_in_the_edge_index` (`db.rs:986-1011`) and
`deleting_and_undoing_edges_keeps_the_edge_index_in_step` (`db.rs:1014-1045`).
These verify that even when the viewport would skip both cards, the
connector that crosses is still drawn. NEVER change that semantics for a
rect+margin that contains fewer cards than the budget — only when the read
is capped does the connector half become a sample (see step 4).

### Far-endpoint lookup

`src/native/src/scene.rs:157-169`:

```rust
for chunk in missing.chunks(EDGE_CHUNK) {
    let rows = nodes::Entity::find()
        .filter(nodes::Column::DocumentId.eq(DOCUMENT_ID))
        .filter(nodes::Column::Id.is_in(chunk.to_vec()))
        .all(conn)
        .map_err(|error| error.to_string())?;
    for row in rows {
        ports.insert(
            row.id.clone(),
            node_ports(row.x, row.y, row.width, row.height),
        );
    }
}
```

Full `nodes::Model` rows (19 columns); used for two floats.

### Conventions that apply

- CLAUDE.md "Database access is ORM-first": "Use the SeaORM entities and
  SeaQuery in `src/native/`; handwritten SQL is limited to the FTS5/RTree
  virtual-table adapter and migrations. Never interpolate values into a
  query." `edge_index.rs` is the RTree adapter and is allowed to contain raw
  SQL via `Statement::from_sql_and_values`; `viewport.rs` and `scene.rs`
  are ordinary tables and MUST stay in SeaQuery.
- §8.2 of `docs/standards.md` (lines 373-384): frame budgets are SHOULD
  targets, measured manually; never assert them in CI.
- File naming: tests live next to the subject; fixture tests inside
  `db.rs` already cover the off-screen-connector rule.
- The 100k bench is `#[ignore]`: `benchmark_nodes` at `db.rs:2033`,
  `seed_benchmark_database` at `db.rs:2945-2970`,
  `hundred_thousand_nodes_benchmark` at `db.rs:2972-3068`, with helpers
  `scene_request` at `db.rs:2481`, `measure_scene` at `db.rs:2536-2575` and
  `validate_moved_connectors` at `db.rs:2640-2749`. Plan 009 already seeds
  edges, images and the Fit/0.15/0.40 scene reads; treat that extended bench
  as present.

## Commands you will need

| Purpose                                  | Command                                                              | Expected on success                         |
| ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| Run all Rust unit tests                  | `bun run test`                                                       | exit 0                                      |
| Run only the native crate                | `cargo test --manifest-path src/native/Cargo.toml`                   | exit 0                                      |
| Filter a Rust test by name               | `cargo test --manifest-path src/native/Cargo.toml a_scene_reads`     | matching tests pass                         |
| Run the ignored 100k benchmark (release) | `bun run test:bench` (records via `println!`)                        | exit 0, prints timings                      |
| Full gate (clippy + fmt + tsc + lint)    | `bun run check`                                                      | exit 0                                      |
| Format check on a Rust file              | `cargo fmt --manifest-path src/native/Cargo.toml -- --check`         | exit 0                                      |
| Format check on a TSX file               | `./node_modules/.bin/vp fmt --check src/flow/viewport-controller.ts` | "All matched files use the correct format." |

## Scope

**In scope** (the only files you should modify):

- `src/native/src/viewport.rs`
- `src/native/src/scene.rs`
- `src/native/src/db.rs` (signature updates + new tests)
- `src/native/src/lib.rs` (the `scene` extern signature)
- `src/native/src/schema.rs` (only the version-3 migration test's direct
  `crate::scene::snapshot` call)
- `src/native/src/types.rs` (only if a small port-only summary struct belongs
  there and not ad hoc in `scene.rs`; default keep that struct in `scene.rs`)
- `src/flow/viewport-controller.ts` (compute and pass `maxCards` after 010's drain loop)
- `src/native.test.ts` (update the two full-scene `document.scene` test calls)
- `src/flow/node-session.native.test.ts` (update its full-scene test call)
- `docs/plans/rust-core.md` (record before/after bench numbers)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, except as noted):

- `src/.nsh/types/@flow/native.d.ts` — this is **generated by
  `bun run check`; never edit by hand**. At HEAD `git check-ignore -v` confirms
  it is ignored by `.gitignore:2:.nsh/`, so it must neither be in the in-scope
  diff list nor in the commit.

- `src/native/src/mutation.rs`, `src/native/src/edge_index.rs` — plan 012
  changes those for gesture commits; do not bundle here. EDGE_CHUNK stays 400.
- `src/native/Cargo.toml` — DON'T add SeaORM features (e.g.
  `sqlite-use-returning-for-3_35`); plan 012 explicitly notes that change as
  deferred. Leave features alone.
- `src/flow/scene.ts` — the slicer logic stays. Once the Rust cap is in
  place, `snapshot.nodes.length > maxCards` is false in the common case but
  the slicer still catches the pinned-selected-card path; leave it.
- NodeSummary's `dataJson` / `settingsJson` columns: required today by
  `NodeDetail.node` and `composer-state`. Do NOT drop them in this plan;
  note as deferred.

## Git workflow

- Branch: `git switch -c advisor/011-scene-read-budget`
- Commit per step (or per pair: signature change + callsite; two-phase
  refactor; RTree-half gate; narrow far-endpoint query; bench numbers).
- Conventional Commits with a lower-case imperative subject and an
  explanatory body — e.g.
  `perf: keep canvas gestures to one update per moved card` (1956ebb),
  `feat: keep a single-card box selection a normal selection` (a8c7884).
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Capture a bench baseline before any code change

Plan 009 has already extended `hundred_thousand_nodes_benchmark` to seed
edges + images and time the same scene reads the canvas issues. Run it now
and record the printed timings in `docs/plans/rust-core.md` under a new
"before 011" line so we can compare after.

```sh
bun run test:bench
```

Copy the full `legacy viewport scale=1.0000`, `legacy scene scale=1.0000`,
`scene fit=…`, `scene scale=0.15` and `scene scale=0.40` stats lines
(avg/p95 and their `nodes=`/`edges=` counts) into `docs/plans/rust-core.md`,
dated, labelled with the build config (release) and "before 011".

**Verify**: `bun run test:bench` exits 0; the new baseline block is in
`docs/plans/rust-core.md` (grep for "before 011").

### Step 2: Thread `max_cards` through `Document.scene`

In `src/native/src/lib.rs:286-294` add `max_cards: u64` as a third positional
argument to `scene`. Mirror it into `db.rs:258-260` and into
`scene::snapshot`. At Step 2, keep `edges_for_scene(conn, &nodes, &rect,
margin)` unchanged; do **not** introduce its Step-4 `capped` argument yet.
Only Step 4 computes the cap and passes the boolean into that helper. Step 2's
`scene::snapshot` structure is:

```rust
pub fn snapshot(
    conn: &DatabaseConnection,
    rect: Viewport,
    margin: f64,
    max_cards: u64,
) -> Result<SceneSnapshot, String> {
    let nodes = viewport::viewport(conn, rect.clone(), margin, max_cards)?;
    let edges = edges_for_scene(conn, &nodes, &rect, margin)?;
    ...
}
```

(`NODE_LIMIT` is the existing constant in `viewport.rs`.)

`Database::viewport` (`src/native/src/db.rs:254-256`) also calls
`viewport::viewport(conn, rect, margin)`; pass `viewport::NODE_LIMIT` there so
the public `Document.viewport` FFI, its `src/native.test.ts:50` caller and the
bench's `measure_viewport` keep their existing behavior. Do not add a
`max_cards` argument to `Document.viewport`/`db.viewport` in this plan.

In `src/native/src/viewport.rs`, change `viewport()` and `viewport_statement()` to take `limit: u64`. The statement builder uses `.limit(limit.min(NODE_LIMIT))` instead of `.limit(NODE_LIMIT)`. Keep the in-view/z/hash sample order identical.

Plan 010 has replaced a single awaited read with the `runReads()` loop at
`src/flow/viewport-controller.ts:84-116`; apply this change **inside each
actual read iteration**. Update that call site to compute the budget
synchronously before each await (§8.1):

```ts
const camera = this.host.camera();
const scale = camera?.scale ?? 1;
const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
const snapshot = await document.scene(rect, margin, maxCards);
```

Remove the now-duplicated scale lookup further down. `scene.apply(snapshot, { maxCards })` keeps its existing client-side slicer; it's a belt-and-suspenders now.

Update every existing native scene call site, not only the UI caller:

1. In `src/native/src/db.rs`, update every direct `.scene(...)` call:
   `a_scene_reads_the_far_port_of_an_edge_to_an_off_screen_card` (call at
   `db.rs:899`); `measure_scene` (`db.rs:2544`/`2553`), which must compute the
   app's budget from its `scale` argument (`scale < 0.15 ? 300 : scale < 0.4 ?
   800 : 2_000`) and pass it, so the Fit/0.15/0.40 rows show the reduced
   payload; and `validate_moved_connectors` (`db.rs:2661-2670`/`2713-2722`),
   which passes `NODE_LIMIT` for its full-scene probes.
2. Change the `scene_between` helper (`db.rs:939-950`) to accept a final
   `max_cards: u64` and forward it to `db.scene`. Update all of its callers
   explicitly: `a_scene_reads_a_connector_between_two_off_screen_cards`
   (`db.rs:964`), `moving_a_card_moves_its_connector_in_the_edge_index`
   (`db.rs:1000-1001`),
   `deleting_and_undoing_edges_keeps_the_edge_index_in_step` (`db.rs:1025`,
   `1044`), and `undoing_a_node_delete_restores_the_connector_index`
   (`db.rs:1058`, `1063`). Existing callers pass `crate::viewport::NODE_LIMIT`
   (or the existing `viewport` binding's `NODE_LIMIT`); do not hide a default
   cap in production code.
3. Add the `max_cards` argument to the new capped test in Step 4 and the dense
   ordering test in Step 3; fresh full-scene test calls otherwise use
   `NODE_LIMIT`. The one direct `crate::scene::snapshot` caller outside the
   `db.rs` wrapper is the version-3 migration test at `schema.rs:371`; pass
   `crate::viewport::NODE_LIMIT` there.
4. Pass `2000` at the two `document.scene(...)` calls in `src/native.test.ts`
   (initial and restored scene in "serves viewport scenes, bounds, edges and
   undo") and at the full-scene call in
   `src/flow/node-session.native.test.ts` ("connects several sources in one
   undo step", or the uniquely named test found by
   `grep -n "document.scene" src/flow/node-session.native.test.ts`).
5. Run `grep -rn "document.scene(" src/` and inspect Rust `.scene(` callsites
   to verify no caller omits the new third argument. The UI caller is the
   `runReads` line in `viewport-controller.ts`; the headless calls are the two
   in `src/native.test.ts` and the one in
   `src/flow/node-session.native.test.ts`. In scope Rust callers,
   `NODE_LIMIT` preserves the old behavior; `viewport::viewport(conn, rect,
   margin, NODE_LIMIT)` likewise preserves standalone viewport reads.

The generated `src/.nsh/types/@flow/native.d.ts` will be regenerated by
`bun run check`; never edit it manually and never add the ignored file to a
commit.

**Verify**: `bun run check` exit 0; `bun run test` exit 0; `cargo test --manifest-path src/native/Cargo.toml viewport` passes.

### Step 3: Two-phase node read

Before changing the production read, add a `#[cfg(test)] pub(crate)` helper
`viewport_statement_reference(rect: Viewport, margin: f64, limit: u64) ->
SelectStatement` in `viewport.rs`. It builds the legacy single-statement
SeaQuery with the same 14 selected columns, RTree-first `CROSS JOIN`, WHERE,
in-view/z/hash/id ordering, and `.limit(limit.min(NODE_LIMIT))`, in the shape
of the existing `viewport_statement_cross_joins_the_rtree_first` test. For
this refactor's dense oracle pass 5. Build it from Step 2's unchanged legacy
`viewport_statement(rect, margin, limit)` **before** renaming/selecting the
production phase-1 seq statement; move the full 14-column legacy builder to
the test-only reference unchanged. This means both production and reference
SQL originate from exactly the same statement code, avoiding a drift-prone
duplicated ordering expression. Then introduce a separate production
`viewport_seq_statement(rect, margin, limit)` for Phase 1. This helper is
**only** an ordered-result oracle for the dense fixture, not a second API for
production reads.

Then split the read into:

1. **Phase 1** — select only `nodes.seq` with the same `WHERE`, `ORDER BY`
   (`in_view ASC, z ASC, sample_order ASC, id ASC`) and the `limit` from
   Step 2. Emit via SeaQuery (`Query::select()` over the same `CROSS JOIN`).
   Collect the ordered `Vec<i32>` of seqs.
2. **Phase 2** — fetch the 14 `ViewportRow` fields from `nodes`, excluding
   internal `seq`, for those seqs via ordinary SeaORM/SeaQuery, in chunks of 400
   (`IN` chunks, on this ordinary table; no raw SQL). Restore the chunk results into phase-1 order using a
   `HashMap<i32, usize>` keyed by seq, or collect all rows and sort once by the
   phase-1 position before mapping them to `NodeSummary`.

   ```rust
   for chunk in seqs.chunks(400) {
       // SeaQuery SELECT …14 columns… FROM nodes WHERE seq IN (?, ?, …)
       // Join those rows against phase-1 order, not their IN-return order.
   }
   ```

   Concatenate the chunks in phase-1 order. Phase 2 must return rows whose
   data matches what the old single-statement query returned. Guard `seqs`
   being empty before issuing an `IN` query.

Keep the existing `viewport_statement_cross_joins_the_rtree_first` assertion
on the production phase-1 statement (plus its existing `limit` update), and
add a separate mirror test for the legacy reference helper as needed so both
have explicitly asserted ordering clauses.

Add exactly one dense fixture test in `db.rs`, beside
`viewport_prefers_nodes_inside_the_rect_over_the_margin` (`db.rs:853`), named
`two_phase_scene_matches_the_single_statement_reference`:

1. Insert 12 deterministic nodes `dense-00` through `dense-11` inside the
   same `{ x: 0, y: 0, width: 800, height: 600 }` rect, with explicit varied
   z/positions/ids and `margin = 0`, so the hash/id path participates.
2. Get the production result via `db.scene(rect.clone(), 0.0, 5)`.
3. Obtain the reference through the worker so its SQLite RTree/order uses the
   same connection as the production read. Expose a test-only
   `pub(crate) fn rows_from_statement(conn, statement)` in `viewport.rs` that
   executes `conn.query_all`, decodes `ViewportRow`, and maps `NodeSummary`
   exactly as production does. Then use:

   ```rust
   let reference = db.run(move |conn| {
       let statement = viewport::viewport_statement_reference(rect, 0.0, 5);
       viewport::rows_from_statement(conn, &statement)
   }).expect("legacy reference read");
   ```

   `db.run` is private to `Database` but its child `tests` module can call it
   (the existing tests also use the test-only `db.apply_ops`). `viewport` is
   the existing module import in `db.rs`; `rows_from_statement` exists only
   under `#[cfg(test)]`, not as a production API. Do not open a second DB
   connection or compare against a self-built in-memory sorted vector.

4. Assert both vectors have five entries and their `(id, z, rev)` tuples are
   **exactly equal in order**; include both id lists in the failure message so
   an ordering change is diagnosable. The 3+ interior-card capped test in
   Step 4 independently guards the cap-bound edge case; this test is the
   ordering/data-equivalence oracle.

Run EXPLAIN QUERY PLAN on the new phase-1 statement at Fit scale and read the
output — it should still hit the RTree as a virtual table. If phase 2 is NOT
faster on the plan-009 bench, revert Step 3 (including the reference-only test
and production two-phase split) and keep only Step 2, per the spec; record in
`docs/plans/rust-core.md` that two-phase didn't pay. Preserve the Step 2
statement-shape test and `max_cards` API when doing this revert.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml viewport` passes
and `cargo test --manifest-path src/native/Cargo.toml two_phase_scene_matches`
passes; `bun run test` exits 0.

### Step 4: Gate the RTree half on the node-read cap

In `src/native/src/scene.rs`, change `edges_for_scene` to take a `capped: bool`
argument. When `capped` is `false`, behave exactly as today (this is the
path the off-screen-connector invariant depends on). When `capped` is `true`,
skip the `edge_index::viewport` call and return only connectors touching the
returned nodes.

The cap predicate is explicitly:

```rust
let kept_limit = max_cards.min(NODE_LIMIT);
let capped = kept_limit == 0 || nodes.len() as u64 >= kept_limit;
```

Thus reaching the cap is exactly `>=`, not `>`; a defensive cap of zero never
takes the uncapped RTree path even if no rows are returned. In normal app calls
`maxCards` is 300, 800, or 2000. The RTree half runs only when
`capped == false`; `edges_for_scene` must preserve its uncapped behavior
byte-for-byte.

Add a new test in `db.rs` next to
`a_scene_reads_a_connector_between_two_off_screen_cards` (`db.rs:953`):

- `a_capped_scene_read_does_not_return_uncrossable_offscreen_connectors`: seed
  the same `left/right` long connector and **three deterministic interior
  cards**, for example `interior-0`, `interior-1`, `interior-2`, at distinct
  positions inside the query rect. Put `left` and `right` at `z = -1`, and all
  interior cards at `z = 0`; the in-view-first ordering therefore cannot
  promote either far card into a one-card sample regardless of hash order.
  Before the read, also assert none of those three cards touches the long
  connector: the `connect` helper connects only `left → right`; no additional
  edge inputs are needed for this invariant.
- Call `db.scene(...same rect and margin as the existing off-screen test...,
  1)` with `max_cards = 1`. Assert `scene.nodes.len() == 1` and that the id is
  one of the three interior cards, not `left`/`right` (no hash must be chosen
  to make this test pass). Assert
  `scene.edges.iter().all(|edge| edge.id != "left-right")` rather than
  `scene.edges.is_empty()`: the goal is only the RTree-promoted cross-view
  connector being omitted, not unrelated touching edges. Assert equality
  against `false` with `assert!(!scene.edges.iter().any(...))` only if the
  project style requires it; the required predicate is the negation of the
  `left-right` id, not an empty entire scene.
- Verify the same scene with `max_cards = 3` still only returns connectors
  touching selected cards; `capped` is true when **three** kept rows meet the
  cap even though no fourth interior card exists. This makes the explicitly
  named `>=` predicate and the in-view ordering both load-bearing.

Confirm the existing unbounded test still passes: when
`max_cards = NODE_LIMIT` and the read returns NO nodes (`scene_between`)
the cap cannot bind, so the RTree half still runs and `left-right` is
still found.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml a_scene_reads`
and `cargo test --manifest-path src/native/Cargo.toml a_capped_scene_read` both
pass; `bun run test` exits 0.

### Step 5: Narrow the far-endpoint query

In `src/native/src/scene.rs`, replace the full-`nodes::Model` fetch at
`scene.rs:157-169` with a SeaQuery select over only `id`, `x`, `y`, `width`,
`height`. Use a small `#[derive(FromQueryResult)]` struct
(`FarEndpoint { id, x, y, width, height }`) defined in `scene.rs`. For each
id-chunk, `conn.query_all(&statement)` and map via
`FarEndpoint::from_query_result(row, "")`. Keep the
`node_ports(x, y, width, height)` helper call.

This stays in SeaQuery — the `nodes` table is not a virtual table, so the
ORM-first rule applies.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml a_scene_reads_the_far_port`
still passes; `bun run test` exits 0.

### Step 6: Record bench deltas

Re-run the 100k bench:

```sh
bun run test:bench
```

Add an "after 011" block to `docs/plans/rust-core.md` with the same five
`legacy viewport` / `legacy scene` / `scene fit=…` / `scene scale=0.15` /
`scene scale=0.40` stats lines and their `nodes=`/`edges=` counts as Step 1.
Do NOT insert budget assertions (§8.2).

**Verify**: `bun run test:bench` exits 0; the after-011 block is in
`docs/plans/rust-core.md`.

## Test plan

- New unit test in `src/native/src/viewport.rs` — the phase-1 statement
  still contains the `CROSS JOIN`, `CASE WHEN`, `ORDER BY (CASE`, and
  `"nodes"."z" ASC`. Pattern after the existing
  `viewport_statement_cross_joins_the_rtree_first`.
- New fixture test in `src/native/src/db.rs` beside the existing
  `viewport_prefers_nodes_inside_the_rect_over_the_margin`:
  `two_phase_scene_matches_the_single_statement_reference` (`db.rs:853`
  neighbourhood) with 12 nodes in a dense rect, `max_cards = 5`, and exact
  ordered `(id, z, rev)` equality
  against `viewport_statement_reference(rect, margin, limit)` (decoded by the
  test-only `rows_from_statement`; never use the two-phase path as both sides).
- New test in `src/native/src/db.rs` beside
  `a_scene_reads_a_connector_between_two_off_screen_cards`:
  `a_capped_scene_read_does_not_return_uncrossable_offscreen_connectors`.
- Existing tests that must stay green on every step:
  - `a_scene_reads_the_far_port_of_an_edge_to_an_off_screen_card`
    (`db.rs:880-921`)
  - `a_scene_reads_a_connector_between_two_off_screen_cards` (`db.rs:953-983`)
  - `moving_a_card_moves_its_connector_in_the_edge_index` (`db.rs:986-1011`)
  - `deleting_and_undoing_edges_keeps_the_edge_index_in_step`
    (`db.rs:1014-1045`)
  - `viewport_statement_cross_joins_the_rtree_first`
  - `undoing_a_node_delete_restores_the_connector_index`
  - `viewport_prefers_nodes_inside_the_rect_over_the_margin`
- Verification: `bun run test` exits 0; the gated RTree test fails before
  step 4 and passes after (revert step 4 mentally to confirm).

## Done criteria

- [ ] `bun run check` exits 0 (incl. clippy + fmt + generated types).
- [ ] `bun run test` exits 0.
- [ ] `grep -n "max_cards" src/native/src/lib.rs src/native/src/db.rs src/native/src/scene.rs` and
      `grep -n "limit: u64" src/native/src/viewport.rs` show the threaded budget at each layer
      (viewport.rs names it `limit`, as Step 2 specifies).
- [ ] `grep -n "document.scene(rect, margin, maxCards)" src/flow/viewport-controller.ts` shows the callsite.
- [ ] The six existing tests named in Test plan pass.
- [ ] The three new tests pass: one phase-1/reference statement test in
      `viewport.rs`, `two_phase_scene_matches_the_single_statement_reference` in
      `db.rs`, and the gated off-screen connector test in `db.rs` (1 + 2 = 3).
- [ ] `git status --short --ignored src/.nsh/types/@flow/native.d.ts` identifies
      it as ignored (`!!`); `git diff --cached --name-only` excludes it. The file is
      generated only by `bun run check` and is never hand-edited or committed.
- [ ] `docs/plans/rust-core.md` contains both the "before 011" and "after 011" bench blocks.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated; formatter rerun on it.

## STOP conditions

Stop and report (do not improvise) if:

- The `Document.scene` change breaks a caller beyond the explicit registration
  in Step 2: the one UI `runReads()` call, the three full-scene headless TS
  calls (two in `src/native.test.ts`, one in
  `src/flow/node-session.native.test.ts`), and the enumerated Rust test/bench
  calls, plus the direct `crate::scene::snapshot` call in `schema.rs`. Re-run `grep -rn "document.scene(" src/` and update all valid calls
  with the new argument; `FlowScene.apply` calls are unrelated and must not be
  counted as native reads. If a production TS caller other than 010's read loop
  appears (for example an older `refresh()` awaiting a scene read), STOP, name
  its file, and get its ownership added to this plan before editing.
- Step 3's phase-1+phase-2 path returns a different ordering than the old
  single statement on the dense fixture in the step-3 test — figure out the
  discrepancy before going further; a kind-by-kind difference usually means
  a floating-point sampling-hash mismatch.
- Plan 009's extended bench is not actually present; you can't measure
  before/after. In that case do the refactor but record explicitly in
  `docs/plans/rust-core.md` that the comparison is blocked on plan 009.
- EXPLAIN QUERY PLAN on the new phase-1 statement no longer hits the RTree
  as a virtual table (e.g. it falls back to a scan of `nodes`). That kills
  the perf win; STOP and report.
- After step 4, any of the six pre-existing tests in Test plan fail.
- Plan 007 or 010 has not actually landed (the row in `plans/README.md` is
  not DONE) — this plan composes with those changes and the drift would be
  unbounded.

## Maintenance notes

- Future changes that touch the node read ordering (`viewport.rs`) must
  re-run the dense-fixture test in step 3; ordering hash drift between
  phase 1 and phase 2 is the most likely regression vector.
- A reviewer should scrutinize: (a) `capped = true` semantic — the rule is
  "fewer rows than the cap → run the RTree half; cap was hit → sample only
  connectors touching kept cards", never "uncapped reads always skip the
  RTree half"; (b) the budget math is `nodes.len() as u64 >= max_cards.min(NODE_LIMIT)` not `>`.
- Deferred explicitly out of this plan: dropping `dataJson` / `settingsJson`
  from `NodeSummary` (forces a NodeDetail + composer-state refactor);
  switching SeaORM's `sqlite-use-returning-for-3_35` feature on for
  `set_node_bounds` (plan 012 notes the same deferral); adding an `IN
  ... LIMIT ...` WHERE to the chunked phase-2 fetch (it doesn't help the
  sort order — keep it simple).
- Plan 016 step (a) scales the per-chunk previews lookup; it composes with
  the budget cap because previews is already targeted at what's on screen.
