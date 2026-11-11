# Plan 016: Apply the small database, viewport and camera-read optimizations

> **Executor instructions**: Perform A preview reads, B startup, C resize,
> D grid, then E scale reads. Each is a separate commit with its own gate.
> Stop on the conditions below instead of changing a neighboring subsystem.
> Update `plans/README.md` when all five parts are complete, unless the
> reviewer dispatched you and owns the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/native/src/detail.rs src/native/src/db.rs src/native/src/lib.rs src/native/src/schema.rs src/native/src/constants.rs src/flow/document-session.ts src/flow/viewport-controller.ts src/flow/viewport-controller.test.ts src/flow/grid.ts src/components/GridBackground.tsx src/components/SelectionFrame.tsx src/components/SelectionPluses.tsx src/flow/camera.ts src/flow/camera.test.ts src/native.test.ts docs/plans/rust-core.md CHANGELOG.md plans/README.md`
> Expected dependency changes: 009 (benchmark/fixture docs), 010/011
> (single-flight/read-budget viewport controller), 011/012 (db.rs), **004**
> (CanvasCamera moving flag + changed() + idempotent dispose and
> ViewportController.camera()?.dispose), and 014 (docs/card files only).
> Plan 015 was **REJECTED** before any code landed, so `db.rs`/`search.rs`
> have no rank-first changes and the index chain is
> `004, 007, 009, 010, 011, 012` (004 for E, 007 for read suppression,
> 010/011 for C viewport). **007 does not supply SelectionFrame geometry**:
> leave its preview-target/same-summary optimizer in scope only as behavior
> to preserve. `plans/README.md` is maintained by the advisor; only a
> delegated executor updates the plan's own status row.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (independent steps; new persisted indexes need migration tests)
- **Depends on**: plans 004, 007, 009, 010, 011, 012. Viewport chain is
  `004 → 010 → 011 → 016` (007 never modifies viewport-controller). Plan 015
  was rejected without code changes; it is not a code dependency. Index row
  `004, 007, 009, 010, 011, 012` (advisor-maintained).
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `b8ee38a`, 2026-11-11 — plans 004, 007, 009–012
  and 014 landed; plan 015 was rejected (its docs-only finding is `b8ee38a`).
  The preview/startup/grid/scale
  premises still match the code; line references below are refreshed. The
  resize step is rewritten around the controller plan 010 actually left:
  a single-flight `refresh()`/`runReads()` drain and an existing five-test
  `src/flow/viewport-controller.test.ts` that this plan extends, not creates.
  It uses one `pendingFitGeneration` token instead of the old text's
  `fitRequested` flag, and keeps the zoom-percent announcement on an automatic
  fit (`fitToDocument(true, false, token)`); the old `false, false` would have
  dropped the resize zoom update.
- **Execution note (2026-11-11)**: implemented on
  `advisor/016-small-cleanups` as `3f669d6` (A), `dedc691` (B), `0ad95ee` (C),
  `94d88e9` (D), `6d48a36` (E) and `f08e675` (measured records), based on
  `b8ee38a`. Gates: `bun run check`, `bun run test` (394 tests),
  `bun run test:bench`, `bun run test:host` (12 tests) and the real-host
  `bun run test:100k` smoke all pass. Accepted deviations: A's named test is a
  green characterization/equivalence test because the old reader already
  returned `take(4)` (the ignored paired benchmark is the performance
  evidence); SeaQuery 1.0.2's installed `expr_window_as(expr, window, alias)`
  is the required spelling and existence reads use `.into_tuple::<i32>()`;
  B's edge-only fixture is impossible because `sea-orm-sync` enables foreign
  keys and the edge relations cascade, so the test is now
  `deleting_the_last_node_cascades_its_edges` and production keeps both
  `has_nodes` and `has_edges` as defense in depth. Measured on the unchanged
  100k fixture: preview reader 261.12 → 254.55 ms avg (only 2.5% because every
  batch already has four items and one asset; the structural cap is pinned by
  fixtures), startup emptiness 3.79 → 0.16 ms avg (4.37 → 0.22 p95), recovery
  16.66 ms avg after the two partial indexes, and the grid hand-pan trace fell
  from 8/9 to 3/4 mount items. One `--exact` plan command lacked the
  `db::tests::` prefix; the full-path command passes.

## Why this matters

Preview reads deserialize whole nodes and every result item, then reread the
same assets once per image card. Startup counts every node and edge before
learning whether the database is empty, and running-work recovery has no
status index. Window resize events can start many full-document bounds reads.
Finally, panning rewrites every grid tile's position and the scale-dependent
selection overlays. These five narrow changes retain identical displayed
previews, selection geometry, restore semantics and scene content.

## Current state

### A. Preview rows and assets

`src/native/src/detail.rs:15-16` has `CHUNK = 400` and `PREVIEW_ITEMS = 4`.
`previews()` at 40–80 reads complete `nodes::Model` rows, and
`read_items_for_batches()` at 250–267 reads all items for all result batches.
The per-node loop at 64–76 creates one asset map for every preview:

```rust
let items = items_by_batch.remove(&batch_id).unwrap_or_default();
let asset_map = asset_map(conn, &items)?;
let preview_items = items
    .iter()
    .take(PREVIEW_ITEMS)
    .map(|item| item_summary(item, &asset_map))
    .collect();
found.push(NodePreview {
    node_id,
    item_count: items.len() as f64,
    items: preview_items,
});
```

`previews()` obtains and orders batches via a `BTreeMap`; item order is
`position ASC, id ASC`. Preserve that node order, item order, and exact count.
`NodePreview { node_id, item_count, items }` at
`src/native/src/types.rs:242-249` and `ResultItemSummary` remain public API.
Preserve the current `batch_id -> node_id` BTreeMap relationship. Each node
has one output batch; there is no new many-batches-per-node result list.
`read_batch` is composer-specific and intentionally includes every item in
the output/current and latest batches, not in previews.

The dependency pins are real: `Cargo.lock:2086-2089` locks SeaQuery **1.0.2**
through native `sea-orm-sync` **2.0.4** (`src/native/Cargo.toml:13`; no new
dependency is needed). Its installed source at
`E:\cache\cargo\registry\src\index.crates.io-1949cf8c6b5b557f\sea-query-1.0.2\`
shows `query/select.rs:868-874`'s `.expr_window_as` signature and
`query/window.rs:96-113,219-221`'s `.partition_by`/`.order_by` builder. `WindowStatement` is
consumed by value (known from `expr_window_as` above), so construct
`let mut window = WindowStatement::partition_by(result_items::Column::BatchId);
window.order_by(result_items::Column::Position, sea_orm::Order::Asc).order_by
(result_items::Column::Id, sea_orm::Order::Asc);` then `inner.expr_window_as
(Expr::cust("ROW_NUMBER()").over(window), Alias::new("preview_row_number"))`.
The addendum's shorthand `.expr_window_as(..., ...partition_by...)` misses
`over(window)`; this spelling is the required interface on exactly this
version. `Expr::cust("ROW_NUMBER()")` supplies only the runtime-independent
function name, never values. SQLite supports capped ROW_NUMBER query this
way; no handwritten/correlated count query is permitted. Precompile a
builder local helper with no type inference hazard and pass it to the ORM
`ConnectionTrait`, rather than SQL literals. Returned bound parameters only
IDs and constants required by query. "Ordinary database work uses SeaORM entities
and SeaQuery in `src/native/`; handwritten SQL is limited to the FTS5/RTree
virtual-table adapters ... and migrations." Raw SQL for previews is therefore
out of scope. Never interpolate a value into a query.

### B. Startup emptiness and partial indexes

```ts
// src/flow/document-session.ts:17-22
const document = await Document.open(path);
try {
  await document.recoverRuns();
  if ((await document.count()) === 0 && (await document.edgeCount()) === 0) {
    await seedDocument(document);
  }
```

`db.rs:383-397` computes two COUNT(*)s. `Database` exposes them at 284-290,
and `Document` forwards them at `lib.rs:321-327`. `seedDocument()` is at
`flow/data.ts:68-96`. Keep recovery before seeding, its error disposal, and
all undo/seed behavior. Keep `count()` and `edgeCount()` public for existing
callers.

`src/native/src/mutation.rs:924-952` filters `nodes.document_id = 'default'
AND nodes.status = 'running'`, then updates `result_batches` whose status is
`running`. DO NOT modify that recovery work; index it. `constants.rs:6` is
`SCHEMA_VERSION = 3`, `schema.rs:19` has `MIGRATIONS = &[1, 2, 3]`, and
`apply_migration` at 82–104 executes versions in transactions. Migration 3 at
136–142 is a current example to copy for version 4. Existing migration tests
at 300–446 include the legacy table failure and migration-3 backfill.

### C. Resize fitting under the existing throttle

`ViewportController` already coalesces scene reads: `refresh()` returns the
active drain promise, marks `dirty` for a follow-up and `runReads()` performs
at most one trailing read for the newest rect
(`src/flow/viewport-controller.ts:62-127`). Plan 010 added that single-flight
loop and `src/flow/viewport-controller.test.ts` (five tests); this plan
extends that file, it does not create it. Plan 011 added the `maxCards`
budget at line 96; preserve it.

The resize path still starts one full bounds read per resize: `onResize`
(162-166) calls `fitToDocument()` immediately, and
`fitToDocument(announce, schedule)` (134-151) awaits `document.bounds()`,
fits, then calls `schedule()`; two resizes inside the 80 ms throttle therefore
queue two independent fits and bounds reads. `schedule()` (54-60) uses the
global `setTimeout` directly, and `dispose()` (187-192) clears it.

The required behavior: a resize on an automatic camera sets one pending fit
token (the newest), wakes the existing 80 ms timer, and the drain applies the
newest fit before its scene read. A user-moved camera never fits on resize;
an explicit fit clears any pending automatic fit and invalidates one already
awaiting bounds. The fit keeps the current zoom-percent publication
(`announce`) and does not start a second timer for its own scene read.

There is no second timer or effect-synchronized snapshot: the pending token is
drained by the same `runReads()` loop that plan 010 and plan 011 already own.
**After plan 004**, the camera already supplies `CanvasCamera.moving()` and
`changed()`; don't recreate/remove them at this owner. No timer feature
duplicate.

### D. One moving grid container

`src/components/GridBackground.tsx:41-47` produces static row/column tile
coordinates with `gridLayout`. `flow/grid.ts:13-20` computes one extra row
and column; `grid.test.ts:4-9` expects four by three for 1920×1080×640 tiles.
The current tile loop at 68–81 makes each image a camera reader:

```tsx
<Image
  src={source()}
  style={{
    position: "absolute",
    left: wrap(props.camera.x) - TILE + tile().column * TILE,
    top: wrap(props.camera.y) - TILE + tile().row * TILE,
    width: TILE,
    height: TILE,
  }}
/>
```

Keep the screen-space grid outside the world view, the existing source/theme
watch, Each key and static tile size. No grid scaling or token changes.

### E. Scale-only overlay reads

`src/flow/camera.ts:64-211` owns one logical `view` signal (line 69);
`get scale()` at 100 reads it, `panBy` at 133 changes only x/y, and
`zoomAround`/`fit`/`set` write through `changed()`. The
`SelectionFrame.tsx:31-35` currently has five `props.camera.scale` reads:
left/top padding, width/height padding and borderWidth. `SelectionPluses.tsx:27`
has its own existing `frame()` closure containing another `props.camera.scale`.
**007 does not change these accessors or SelectionFrame geometry**. This plan
replaces exactly those six reads with `scaleView()` (new CanvasCamera scale
accessor), and preserves the surrounding multiFrame()/scene.selectionBounds,
frameZ/framePlusZ/follow calculations. It does NOT invent a centralized
SelectionFrame geometry memo or any selection-bounds provider. Each formula
shape stays the same after this dependency-only swap.
For ownerless cameras in pure tests, an explicit signal is safer than an
unowned computed. Standards §6.2 requires values to use `computed` or a cheap
closure, and forbids an effect that synchronizes a second signal. This plan
uses the explicit fallback, centralized in the one camera write path. No
effect is introduced, and no duplicate writable state escapes the camera.

## Commands you will need

| Purpose                         | Command                                                                                                                                                                            | Expected on success                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Native unit tests               | `cargo test --manifest-path src/native/Cargo.toml`                                                                                                                                 | all non-ignored tests pass                               |
| New preview fixtures            | `cargo test --manifest-path src/native/Cargo.toml preview -- --nocapture`                                                                                                          | all preview cases pass                                   |
| Migration & edge-empty fixtures | `cargo test --manifest-path src/native/Cargo.toml db::tests::<case> -- --exact --nocapture`                                                                                        | selected Rust test passes                                |
| FFI/headless                    | `nsh test src/native.test.ts --filter "empty document"`                                                                                                                            | new API case passes                                      |
| Viewport timing                 | `nsh test src/flow/viewport-controller.test.ts`                                                                                                                                    | all resize/single-flight cases pass                      |
| Camera reads                    | `nsh test src/flow/camera.test.ts`                                                                                                                                                 | existing/new work-count tests pass                       |
| Grid behavior                   | `nsh test src/flow/grid.test.ts` and `nsh test src/App.test.tsx --filter "zooms with the keyboard"`                                                                                | existing tests pass                                      |
| Selection behavior              | `nsh test src/flow/canvas-controller.test.ts --filter "box-selects only the cards the marquee covers"` and `nsh test src/App.test.tsx --filter "clears the selection with Escape"` | named controller/app cases pass                          |
| Release benchmark               | `bun run test:bench`                                                                                                                                                               | exit 0; new preview/emptiness/query-plan evidence prints |
| Full gate                       | `bun run check` and `bun run test`                                                                                                                                                 | exit 0, all tests pass                                   |

Run Rust paths through Cargo, not `nsh test <rust-file>`.

## Scope

**In scope** (only files needed by these steps):

- `src/native/src/detail.rs`, `db.rs`, `lib.rs`, `schema.rs`, `constants.rs`
- `src/flow/document-session.ts`, `viewport-controller.ts`,
  `viewport-controller.test.ts` (extend plan 010's five tests)
- `src/flow/grid.ts`, `grid.test.ts`
- `src/components/GridBackground.tsx`, `SelectionFrame.tsx`,
  `SelectionPluses.tsx`
- `src/flow/camera.ts`, `camera.test.ts`
- `src/native.test.ts`, `docs/plans/rust-core.md`, `CHANGELOG.md`

**Out of scope**:

- `src/.nsh/` declarations: generated only, never manually edited.
- `src/native/src/types.rs`, `lib.rs` other APIs, `mutation.rs` recovery
  semantics, old migration bodies, `search.rs`, scene/viewport algorithms.
- `src/App.test.tsx`, `src/App.host.test.tsx`, other components,
  `FlowPage.tsx` and the rest of the controller/react stacks. Existing tests
  provide the behavior evidence; no component test harness is introduced.
- **What this plan does NOT change**: 007 supplies preview-loader identity,
  never SelectionFrame geometry or viewport-controller code. 010 owns the
  single-flight refresh and 011 owns scene/card limits; do not discard their
  joined readers or those algorithms while fitting. Plan 004 camera motion
  behavior stays intact, including changed() and camera.dispose ownership.
- SQL for ordinary queries in `detail.rs`, eviction, new crates, migration
  resets, new assets, per-node FFI calls or second render loops.

## Git workflow

- Branch: `git switch -c advisor/016-small-cleanups` from main.
- One commit per A–E and one final documentation commit. Suggested subjects
  (with explanatory bodies): `perf: bound each preview's item read`,
  `perf: use existence reads and running-work indexes on startup`,
  `perf: coalesce automatic fits across resize events`,
  `perf: move the dot grid as one container`,
  `perf: give selection overlays a scale-only camera reader`,
  `bench: record preview and startup read costs`.
- Match lower-case imperative Conventional Commits, e.g.
  `feat: show the app's frame rate on the canvas` (`3489486`). Include no
  AI attribution and no "Generated with..." trailer. Do not push or open PRs.
- At completion update the index and run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step A: Read no more than four preview items per batch

In `detail.rs`, for every chunk of 400 IDs:

1. Query only `(id, output_batch_id)` from nodes with SeaORM `.select_only()
   .column(...)` and `.into_model::<PreviewNodeRow>()`, preserving
   DOCUMENT_ID and `BTreeMap<batch_id,node_id>` (only nonnull output ids).
2. Build the capped `result_items` inner with all ordinary entity columns
   and this exact SeaQuery construction at the **locked SeaQuery 1.0.2**:
   ```rust
   let mut window = WindowStatement::partition_by(result_items::Column::BatchId);
   window.order_by(result_items::Column::Position, sea_orm::Order::Asc);
   window.order_by(result_items::Column::Id, sea_orm::Order::Asc);
   inner.expr_window_as(
       Expr::cust("ROW_NUMBER()"),
       window,
       Alias::new("preview_row_number"),
   );
   ```
   The actual installed sources are
   `E:\cache\cargo\registry\src\index.crates.io-1949cf8c6b5b557f\sea-query-1.0.2\src\query\select.rs:868-874`
   and `.../window.rs:96-113,219-221`; on this exact version
   `expr_window_as(expr, window, alias)` applies `.over(window)` itself, so do
   not call `.over(window)` separately (it consumes the WindowStatement).
   `Expr::cust("ROW_NUMBER()")` names
   the built-in safe function only, never interpolates a user ID; `.is_in`
   keeps normal bound values. Use `SqliteQueryBuilder/.to_string` to inspect
   generated statement has inner window + outer `<=4` condition, no raw SQL.
   Use `from_subquery` and filter `preview_row_number <= PREVIEW_ITEMS` in
   the outer query. Decode each row as `result_items::Model` with
   `FromQueryResult::from_query_result` after `connection.query_all` (the
   pattern at `search.rs:146-158`).
   Use the `ids` in a SeaQuery `.is_in` with chunking as today.
   `_row_number`/`preview_row_number` are adapter-only projection columns;
   they are not public models or migration columns. No VALUES string may
   contain a user ID.
3. Run a different SeaORM grouped query for `batch_id, COUNT(*) AS item_count`
   for those batch IDs: `.column(BatchId)`, `.expr_as(Func::count(...),
   Alias::new("item_count"))`, `.group_by(BatchId)`. Decode it with
   `FromQueryResult`; its separate row map contains the full count including
   hidden fifth/sixth/etc. items. Zero-item current batches still return an
   empty preview with `item_count = 0`.
4. Collect all selected items' asset IDs into one `BTreeSet` across this
   chunk (so repeated images cause one query). Call `assets_by_id` exactly
   once for that chunk, then build `ResultItemSummary` using the existing
   `item_summary`. Keep per-batch item counts separate from bounded item
   maps. Preserve the existing `asset_map()` helper if composer detail still
   calls it; only the previews loop changes query ownership.

Add `#[cfg(test)]` old/reference helpers if necessary to compare old/new
queries on one fixture, but no second production path or SQL-enabled test.
Each of these has its own Rust test in `db.rs`, modeled after
`node(...)` at 478–495 and batch creation at 1918–1937:
`preview_items_stay_bounded_without_losing_total_count` (0,1,6 items and a
sixth distinct item excluded with count 6);
`preview_items_keep_position_then_id_order` (same position, ID tie);
`previews_batch_chunks_and_share_assets` (401 image nodes with at least one
batch on either side of the CHUNK boundary and repeated assets);
`previews_keep_the_old_node_and_item_summaries` (at least two image nodes and
missing/duplicate assets, exact `NodePreview` vector equality; `PartialEq`
already exists on public types). Include a missing asset must become None
without removing that item.

Step A also adds paired before/after timing (2,000 image IDs after plan 009)
in the already ignored fixture: `old_preview_reader` vs
`bounded_preview_reader`, equal returned vectors required on both sides.
No per-call benchmark hard budget. Read the 009 fixture's unique IDs from
existing calls; if it keeps fewer than 2,000 images, record precisely what
actual size it has, do not silently claim 2,000.

Every new test runs before committing A (and all remain in ordinary cargo
suite). For one shared deterministic fixture make `node("shared",
"Shared","body", &[], 0.,0.)`, then `save_run` with batch/id `preview-shared`
and status `"done"`, with its returned `node_detail`. Read actual
`output_batch_id` back, never reference an unused/existing random batch id.
`save_run` successful variant assigns `output_batch_id`, so `db.previews
(vec!["shared"])` becomes nonempty. For exact exhaustive 0,1,6 item
comparisons save deterministic items for that real shared batch; old
reader/reference runs on this same fixture and strict `assert_eq!` on
NodePreview vector (item count 6 + four bounded returned items).
Tie items (`position=1, id="a"` vs `"b"` plus a later rank item same
duplicate position) must be full vector order `a,b,position then id` as
already `read_items_for_batches`; negative test id lexicographic variation
can't claim production LOCALE sorting. Fourth/fifth/sixth deliberate IDs
show boundary with total count 6 not return len. Zero-item batch still
returns `[]/0`; one returns exactly 1. `previews_batch_chunks_and_share_assets`
puts 401 explicitly created IDs across CHUNK 400 and repeated asset hash;
all requested IDs in known shared BTreeMap order returned, queried selected
IDs are not cross-chunk omitted. `previews_keep_the_old_node_and_item_summaries`
compares old/new including missing/duplicate assets (missing asset leaves
`asset:None`; does not drop item). Each covers its named distinct behavior.

Expose old **reference reader** only as `#[cfg(test)] pub(crate) fn
previews_reference` (or preserve `read_items_for_batches` cfg test through
detail old helper), not `old_preview_reader` public production path. Same IO
only old-reading test reference meant for a failing-first comparison. Bench
`old_preview_reader` and `bounded_preview_reader` names are allowed as
`#[cfg(test)] #[ignore]` functions within existing `hundred_thousand_nodes_benchmark`;
`009` supplies 2,000 **image-node IDs** (its Step 2 explicitly says the
first 2,000). Request only the fixture's deterministic image-node vector,
not arbitrary current batches as node IDs; if its helper's list name differs
read that plan's collection, never borrow a random native.test.ts batch ID.
`previews` then resolves actual output batch IDs in DB. Require nonempty
`found` vectors plus four items/count four for this 009 fixture; raw time
would otherwise time zero work. At fewer IDs **fall back deterministically
to 2,000 plain image nodes in a clone of this ignored benchmark fixture**:
create nodes with `kind:"image"`/IDs starting `preview-0`, `save_run` with
4-item done batches for every node (unique explicit IDs), and measure on
this separately cloned file. Report the original N and fallback path/hash;
never claim measuring original fixture 2k if fallback used. No alternate
benchmark database used for regular suite, only ignored bench.

Before swapping production preview reader, create failing red test calling
`preview_items_stay_bounded_without_losing_total_count` (all six already
return current old output). It MUST assert `items.len()<=4` and count 6, so
reference reading fails not production writer fails due missing function.
Only after bounded query implemented green all four; **Do not retain two
complete read paths in production**, old stays cfg(test). Replace ordinary
`read_items_for_batches` preview use, NOT composer `read_batch`; composer
retains full items. No raw SQL, per-node asset maps or batched IDs dropped.
Query verifier must ensure WINDOW appears inside `select` and outer filter
row_number <= 4 literal safe constant (not dynamic user ID). If builder
emission can't map `result_items::Model` without hidden row number then
`FromQueryResult::from_query_result(row, "")` known pattern uses only known
fields; test explicit failure. Unknown version override stops A, not
handwritten correlated subquery/raw SQL.

> **Execution note (2026-11-11):** the named test is a green
> characterization/equivalence test, not a failing-first one. The old
> `previews()` already returned only `take(4)` items; the change is that it no
> longer reads every item. The ignored paired `old_preview_reader` /
> `bounded_preview_reader` benchmark is the performance evidence. This was
> confirmed by the executor and accepted.

**Verify**: these four exact commands (no filter substring collisions) run
independently; then `bun run check` each commit:

- `cargo test --manifest-path src/native/Cargo.toml db::tests::preview_items_stay_bounded_without_losing_total_count -- --exact --nocapture`
- `cargo test --manifest-path src/native/Cargo.toml db::tests::preview_items_keep_position_then_id_order -- --exact --nocapture`
- `cargo test --manifest-path src/native/Cargo.toml db::tests::previews_batch_chunks_and_share_assets -- --exact --nocapture`
- `cargo test --manifest-path src/native/Cargo.toml db::tests::previews_keep_the_old_node_and_item_summaries -- --exact --nocapture`
  Then `cargo test --manifest-path src/native/Cargo.toml preview -- --nocapture`
  for ordinary preview coverage. `git diff --check` returns no whitespace
  issues; `bun run check` proves full boundary/500 nonblank/noncomment code
  line limit after detail/db additions. Each is actual run, not a recorded
  unexecuted claim. No test modifies external repos. Commit A with permitted
  Rust/db files and ignored measurement only.

### Step B: Use one startup emptiness read and indexed running work

1. Add `Database::is_empty() -> Result<bool, String>` in `db.rs`. Factor
   worker-local functions `has_nodes(conn) -> Result<bool, String>` and
   `has_edges` using SeaORM
   `.select_only().expr(Expr::val(1)).one(conn)?.is_some()` with the
   existing DOCUMENT_ID predicates (SQL LIMIT 1, no COUNT). One
   `self.run(move |conn| Ok(!has_nodes(conn)? && !has_edges(conn)?))` returns
   the predicate. Do not compute totals, replace the worker or open a new
   connection. Local helpers allow direct same-DB fixture testing of the
   predicate separately from the asynchronous TSX export.
   `Document.is_empty` should become `document.isEmpty(): Promise<boolean>`;
   existing generated conventions prove this conversion, e.g.
   `set_node_bounds` becomes `setNodeBounds` at
   `src/.nsh/types/@flow/native.d.ts:288` and `edge_count` becomes
   `edgeCount` at 306.
2. Add `Document.is_empty()` in `lib.rs` beside `count/edge_count`, using the
   identical `off_thread(move || db.is_empty()).await` pattern. Run the
   normal NSH build/check afterward to regenerate the `isEmpty` declaration.
   If the NSH macro names it differently than `isEmpty`, STOP for an API
   decision rather than manually editing declarations or adding a second
   facade method.
3. Replace only the conditional in `document-session.ts:20` with
   `if (await document.isEmpty()) await seedDocument(document);`. Preserve
   recover-before-seed, try/catch and document disposal lines. This replaces
   two FFI count reads with one FFI/DB-worker call.
4. Bump `SCHEMA_VERSION` to 4, append 4 to `MIGRATIONS`, and add migration_4
   containing two static migration statements executed in schema.rs:

```sql
CREATE INDEX IF NOT EXISTS nodes_running
  ON nodes(document_id, status) WHERE status = 'running'
CREATE INDEX IF NOT EXISTS result_batches_running
  ON result_batches(status) WHERE status = 'running'
```

No data interpolated; these are static DDL strings. Never edit earlier
migrations or delete existing data. Migration 4 controls both old upgrades
and brand-new installs through the normal migration sequence.

Add `migration_4_adds_running_work_indexes_once` beside the other schema
migration tests in **`schema.rs::tests`** (`schema::tests`, not db::tests):
create schema_migrations, run helper migrations 1 and 3, insert a simple
document, two normal nodes, connecting edge and result_items across two
batches through existing helpers; call `db.save_run` for owned matching
batches/items end, read node detail vector before migrating to actual v4.
The helpers may take owned `ResultBatchInput/ResultItemInput` from public
`mutation` test execution fixture, not random UUID from seedDocument. Record
versions 1/2/3, verify index names absent, then `migrate()` twice. Assert one
version-4 row and both node/edge/preview rows equal expected contents. PRAGMA
SeaORM `Statement` handles test-only PRAGMA reads. Do not call the
destructive migration 2 on a v3 fixture.

Also add `running_work_queries_use_partial_indexes` constructing an
`EXPLAIN QUERY PLAN` for each runtime query with its exact filters
(`nodes.document_id`, status and `result_batches.status`). Produce plan rows
as data for benchmarking, then assert their combined text contains the
corresponding index name; no brittle whole-plan equality is necessary.
Existing `recovering_runs_marks_running_nodes_interrupted` at
`db.rs:2540-2569` must stay green because no recovery semantics changes.

Add `empty_document_has_no_nodes_or_edges` with synchronous
`open_connection(":memory:")` and worker-local `has_nodes/has_edges`.
First empty=true; insert two nodes, then expect false.

The edge-only state is unreachable under the runtime schema: `sea-orm-sync`
enables `PRAGMA foreign_keys = ON` when it opens the connection, and
`src/native/src/entity/edges.rs` declares `on_delete = "Cascade"` for both
node relations, so deleting the last endpoint deletes its edges. Do NOT
disable foreign keys, insert a dangling edge, or weaken the predicate to force
the old `edge_only_document_is_not_empty` case. Instead add
`deleting_the_last_node_cascades_its_edges`: insert two nodes and an edge,
delete both nodes, expect zero nodes, zero edges and `is_empty() == true`, and
comment that `has_edges` remains in the predicate as defense in depth if the
schema or FK behavior changes. If a future change stops cascading, this test
fails and the edge-only branch must be re-proven.

`src/native.test.ts` new `empty document` case opens `:memory:`, expects
`await document.isEmpty()` true, inserts node by native.test.ts:11-23, expects
false, disposes its Document per existing first test lifecycle. This one
predicate deliberately excludes assets (no "asset-only" startup rule change).

Call/print both the historical `(count==0 && edge_count==0)` and new
`is_empty` on the same unmodified seeded database. For recoverRuns, use a
fresh copied fixture for each A/B call or a fair empty-running set in paired
reads. Never compare populated-running cost to already-recovered-clean cost.
Record actual average/p95 plus the exact fixture and state transitions.

`document.recoverRuns()` is benchmarked via `db.recover_runs`, and
`document.isEmpty` translates `db.is_empty` so timestamps/facade side prepare
separately outside CPU timing. For counts' A/B derive known fixture revision,
each fresh copy has same row-output batches/running progress before matching
calls so recovered-clean second compare never hides earlier cost. Use a
per-case reproducible path only supplied by 009's ignored native fixture
(auto async db handles normal `is_empty` test coverage from TS). Record actual
mean/p95 and fixture conversion paths plus matched before/after states.

**Verify** (these paths are decided from Scope):

- `cargo test --manifest-path src/native/Cargo.toml schema::tests::migration_4_adds_running_work_indexes_once -- --exact --nocapture` passes and proves both persisted partial indexes/data stays same;
- `cargo test --manifest-path src/native/Cargo.toml db::tests::running_work_queries_use_partial_indexes -- --exact --nocapture` shows exact recovery filters use `nodes_running`, `result_batches_running`;
- `cargo test --manifest-path src/native/Cargo.toml empty_document -- --nocapture` covers empty=true and node-only=false;
- `cargo test --manifest-path src/native/Cargo.toml deleting_the_last_node_cascades_its_edges -- --exact --nocapture` pins the FK cascade that makes edge-only unreachable;
- `nsh test src/native.test.ts --filter "empty document"` shows `isEmpty`
  works through generated bindings after Document.open->recover->seed.
- Keep/recheck `cargo test --manifest-path src/native/Cargo.toml db::tests::recovering_runs_marks_running_nodes_interrupted -- --exact --nocapture`
  proving running status semantics wasn't changed. `bun run check` must exit
  clean (explicitly generated isEmpty declaration, all types, max-lines),
  `bun run test` after commit B too (here possible global test during each
  part by step). No `src/nsh.json` or app SQL/command is needed. Commit B
  only when all named paths have passed and independently inspected output.

### Step C: Coalesce automatic fits and retain single-flight reads

Add a scheduler injection and one pending-fit token to `ViewportController`;
do not add a second timer or a second read path.

1. Add near `ViewportHost`:

   ```ts
   export interface ViewportScheduler {
     setTimeout(callback: () => void, delay: number): number;
     clearTimeout(id: number): void;
   }

   const SYSTEM_SCHEDULER: ViewportScheduler = {
     setTimeout: (callback, delay) => setTimeout(callback, delay),
     clearTimeout: (id) => clearTimeout(id),
   };
   ```

   Use `constructor(private readonly host: ViewportHost, private readonly
   scheduler: ViewportScheduler = SYSTEM_SCHEDULER) {}`. Production
   construction (`new ViewportController(host)`) stays unchanged. Change the
   `timer` field to `number | null` and use the scheduler for the existing
   80 ms timer and its cleanup. The scheduler is a typed interface, not a
   loophole for new timers.

2. Add `private fitGeneration = 0;` and
   `private pendingFitGeneration: number | null = null;`. In `userMoved()`,
   after incrementing `cameraGeneration`, also bump `fitGeneration` and clear
   `pendingFitGeneration`, so a pan or zoom cancels an automatic fit waiting
   for the timer or for bounds.

3. `onResize(width, height)` keeps `setSize` synchronous. If `userCamera` is
   true, only call `schedule()`. Otherwise bump `fitGeneration`, store it in
   `pendingFitGeneration`, and wake the drain: if `inFlight !== null` set
   `dirty = true`; else call `schedule()`. Repeated resizes before the timer
   replace the pending token, so they cause one bounds read at the newest
   size.

4. `runReads()` starts each iteration by capturing and clearing
   `pendingFitGeneration` (after clearing `dirty`). If it is non-null and
   `userCamera` is false, `await this.fitToDocument(true, false, token)`
   before computing `visibleRect()`. The `true` keeps the zoom-percent
   publication; `false` avoids a second timer because this drain immediately
   reads the scene. After the scene read, if `pendingFitGeneration` is
   non-null (a resize arrived during the read), set `dirty = true` so the
   loop applies the newest fit before `finishReads()` resolves joined
   callers. Respect disposal after every await.

5. Extend
   `fitToDocument(announce = true, schedule = true, expectedFit: number | null = null)`:
   capture `cameraGeneration` before awaiting bounds as today; after the
   await return on disposal or a changed `cameraGeneration`; if
   `expectedFit !== null`, also return when
   `expectedFit !== this.fitGeneration || this.userCamera`. An explicit call
   (`expectedFit === null`) bumps `fitGeneration` and clears
   `pendingFitGeneration` so the user's fit supersedes an automatic one.
   Keep `userCamera = false` and the existing fit/announce/schedule flow.

6. `dispose()` clears `pendingFitGeneration` and uses
   `this.scheduler.clearTimeout`; it keeps canceling the zoom frame and
   camera disposal exactly as today.

7. Extend `src/flow/viewport-controller.test.ts`; keep its five plan-010
   tests unchanged and green. Add a fake `ViewportScheduler` (record
   callbacks by numeric id, `runDue()` executes the armed callbacks,
   `clearTimeout` removes one) and give `stubDocument` an optional
   `bounds()` that pushes into a `DeferredBounds[]`. The fake document is
   still created through `unknown as Document` on a recorded object; no
   `any`.

   Add these four one-behavior cases:

   - `coalesces automatic fits into the newest stage size`: two `onResize`
     calls before the timer (800×600 then 1024×700) leave one armed timer;
     run the drain (or `runDue()`), resolve one bounds read, then one scene
     read; assert exactly one `bounds()` call and a camera fit computed from
     1024×700.
   - `a manually moved camera does not refit on resize`: call
     `controller.userMoved()`, resize, run the drain; assert zero `bounds()`
     calls and one ordinary scene read.
   - `a pending fit cannot apply stale bounds`: with the first bounds read
     deferred, resize again; resolve the old bounds and assert its scale is
     not applied; resolve the newest bounds and scene read; assert the camera
     holds the newest fit and both joined callers settle only after it.
   - `disposal cancels a pending automatic fit`: arm a resize, dispose, run
     the scheduler callback, resolve any held read; assert no `bounds()`, no
     camera write and no scene read after disposal.

   Do not wait 80 ms in a test; drive the fake scheduler directly. Keep the
   existing fake document's `scene` deferreds and the two-microtask
   `flushRead()` helper.

**Verify** each newly named case separately from repo root (names preserved
without option-growing indefinite suffix):

- `nsh test src/flow/viewport-controller.test.ts --filter "coalesces automatic fits into the newest stage size"`
- `nsh test src/flow/viewport-controller.test.ts --filter "a manually moved camera does not refit on resize"`
- `nsh test src/flow/viewport-controller.test.ts --filter "a pending fit cannot apply stale bounds"`
- `nsh test src/flow/viewport-controller.test.ts --filter "disposal cancels a pending automatic fit"`
  Then `nsh test src/flow/viewport-controller.test.ts` (retained 010
  single-flight plus known 011 maxCards test cases), and `nsh test
  src/App.test.tsx --filter "fits with the keyboard"` existing at
  App.test.tsx:178-189. Record actual `bounds()` number and dimensions (800×600
  should be superseded by only last 1024×700), and disposal doesn't late
  camera document apply. `bun run check` after scene/viewport add assures no
  line-length cap violations including tests and guard dependencies. No new
  timer/FFI bound/data-layer fix allowed fitting. Commit C only then with
  test file + viewport only.

### Step D: Move only the grid wrapper on camera pans

In `GridBackground.tsx`, retain outer layout and tile-scheme logic. Replace
its current direct Each-child usage with a single
`<Each of={tiles()} ...>` nested in a moving container, not a second loop:

```tsx
const gridOffset = (value: number): number => wrap(value) - TILE;
<View
  style={{
    position: "absolute",
    left: gridOffset(props.camera.x),
    top: gridOffset(props.camera.y),
    width: 0,
    height: 0,
    overflow: "visible",
    pointerEvents: "none",
  }}
>
  <Each of={tiles()} key={(tile) => `${tile.column}-${tile.row}`}>
    {(tile) => (
      <Image
        src={source()}
        style={{
          position: "absolute",
          left: tile().column * TILE,
          top: tile().row * TILE,
          width: TILE,
          height: TILE,
        }}
      />
    )}
  </Each>
</View>;
```

The math equivalence is fixed by the previous formula: old tile origins are
`(wrap(camera)-TILE) + tileOffset`, i.e. wrapper origin + tileOffset. Camera
scale never participates. Keep all tokens/theme source and full outer
layout/pointer settings. There are only two camera-to-grid style reads,
replacing up to 24 on a 12-tile stage.

Move `wrap` verbatim to a documented pure `wrappedGridOffset(value, tile)`
helper in `flow/grid.ts`:

```ts
export function wrappedGridOffset(value: number, tile: number): number {
  if (!Number.isFinite(tile) || tile <= 0) return 0;
  return ((value % tile) + tile) % tile;
}
```

The wrapper must subtract TILE from both calls; do not return `wrap()-TILE`
from the helper, since its name means the wrapped offset. Add tests named
`wrapped grid offsets preserve the previous tile origins` (camera values -1,
641 and columns 0–3 recompute the old position exactly) and
`invalid tile sizes keep a zero wrapped offset` (0,-1,NaN,Infinity produce 0).
These match `gridLayout`'s existing finite positive tile guard at line 13.

**Verify** new unit cases first: `nsh test src/flow/grid.test.ts --filter
"wrapped grid offsets preserve the previous tile origins"` and `nsh test
src/flow/grid.test.ts --filter "invalid tile sizes keep a zero wrapped offset"`;
then full pure file `nsh test src/flow/grid.test.ts` unchanged layout tests
included. App case `nsh test src/App.test.tsx --filter "zooms with the keyboard"`
proves 1.2/undo exact ratio without other App test edits. `bun run check`
mandatory after commit's changes (line cap included) and commit D separately.
Manual BEFORE/AFTER trace using same `--trace` exact existing test above:
drag/pan trace isn't emitted by this keyboard-zoom case, but matching scale
invalidates the moving container transform only in scale none; records only
wrapper x/y/computed static tile rows and no per-tile left/top camera styles.
For real pan samples use `nsh test src/App.test.tsx --filter "clears the
selection with Escape" --trace` before/after; identify separate Hand press
pan `drag(id:flow-canvas,0pt,20pt)` from selection Marquee drag
`drag(id:flow-canvas,negative-scaled)` and record actual nsh::perf mount item
count difference. No absolute timing threshold is a test. Grid uses same
tokens/theme; never replace stylesheet with raw color values or per-effect
camera state.

### Step E: Centralize view publication and give overlays a scale-only reader

Use a separate **private** signal inside `CanvasCamera`, per the explicit
fallback in the advisor specification (no unowned computed or effect).
Construct private `scaleValue = signal(1)` and expose an `Accessor<number>`
named `scaleView` constructed as `() => this.scaleValue()`, with `import type
{ Accessor }` and `batch`, `signal` from "nsh". Keep `get scale()` as the
existing finite-fallback read of this accessor instead of duplicating reads
of full view; public `view` remains the single logical camera record.

Replace direct writes at the current `panBy`/`zoomAround`/`fit` plus private
`set` with one `private publish(next: CameraView): void` called by EVERY real
mutation. `set(next: Partial<CameraView>)` still resolves validated complete
x/y/scale, returns no-op on identical values, and routes to `publish`; pan
early-return 0/0 stays before any publication. `zoomAround` still rejects
nonfinite/nonpositive factors, no-op and reversed clamps; returns true only
after a real publish. `fit` `[...] .every(Number.isFinite)` and positive sizes
checks remain, returns this.scale on invalid; otherwise valid calculated view
is routed through `set`/`publish`, and its return equals resulting scale.
Private view record validation stays a guard of `publish`; **when no actual
view change** publish does ZERO writes, ZERO `changed()` invocations and does
not move/extend plan 004's moving flag. A rejected write cannot arm motion.

Exact order inside publish:

```ts
const current = this.view();
if (current.x === next.x && current.y === next.y && current.scale === next.scale) return;
batch(() => {
  this.view.set(next);
  if (next.scale !== this.scaleValue()) this.scaleValue.set(next.scale);
  this.changed(); // exactly once, AFTER both values are stored in same batch
});
```

`changed()` is the existing CanvasCamera private method **introduced by plan
004 Step 1**; it sets camera.moving and arms/cancels only 004's timer. It is
not a ViewportController callback. Preserve its owner, moving accessor,
`CameraScheduler` test seam, and dispose contract. The view publicly remains
logical record; scaleValue is private explicit projection with `readonly
scaleView: Accessor<number> = () => this.scaleValue()`; `get scale()` returns
the finite positive fallback from `scaleView()` (no separate full-view read).
Use type `Accessor` plus `batch`, `signal` from "nsh"; no duplicate writable
public signal leaves Camera. One record update per mutation remains. The
`batch` also keeps a joint effect seeing matching view.scale and scaleValue.
`changed()` fires exactly once per real publication and within the same
batch—not per view/scale field, not for no-ops. Since 004 owns camera motion
and its timer, preserve all Step 1 tests as forward regression tests (before
editing E run full `nsh test src/flow/camera.test.ts`, and after edit run it
again; require these cases unchanged and green):

1. real pan sets moving true; another write replaces one settle timer whose
   delay = `CAMERA_MOVE_SETTLE_MS` 150; latest settle callback makes false;
2. direct x/y/scale, a real zoom and real fit each start moving;
3. zero pan, nonfinite values, clamped no-op zoom, invalid fit and equal
   camera assignment do not start moving nor extend an existing timer;
4. dispose cancels the single timer, prevents a retained canceled callback
   doing later work and can be called twice safely;
5. once settle fired, the next real camera write re-arms correctly.
   004's **CanvasCamera** `changed` no-op/contact origin is deliberately preserved,
   not a viewport-side duplicate. 004's moving tests prove rejected writes and
   no-ops produce no motion, and batched publisher guard preserves that even
   when the next scale equals current but x/y changed. The new effects below
   add precisely one zoom wake, not move-field wake for scale-only readers.

Plan 004's `dispose()` on `CanvasCamera` remains idempotent, cancels a stale
settle timer, marks moving false and blocks late callback work. Cleanup
ownership is explicit:
ViewportController owns camera cleanup by its existing dispose implementation
from 004: preserve **`this.host.camera()?.dispose()` inside
`ViewportController.dispose`**, after cancelAnimationFrame/timer cleanup.
Do not remove/re-add it while merging A–E or duplicate it on FlowPage. Step
C's pending-fit disposal must complement that camera lifetime, not supersede
it. Plan 004 OWNERSHIP is explicitly not reworked here.

The five exact props.camera.scale usages in SelectionFrame (left/top,
width/height, borderWidth) plus one in SelectionPluses's `frame` closure all
become `props.camera.scaleView()` as a DROP-IN dependency swap; no
SelectionFrame geometry memo is a prerequisite nor created by this plan. It
keeps scene selectionBounds/multiFrame/follow/frameZ/PlusZ reader behavior.
No FlowCanvas world transform change; it wants x/y/scale too. This is six
scale-only overlays formula sites rather than every component getter.
Add `camera.test.ts` cases following the existing native `effect` pattern
and `card-geometry.test.ts:32-44`:
`scale-only readers do not wake on pan` (one effect reading scaleView;
pan produces no extra run, `camera.scale` unchanged);
`one zoom publishes view and scale together` (single `effect` reading both
view and scaleView; `zoomAround` at another origin -> exactly +1 run and both
change before run; no inconsistent stale zoom);
`all camera writes keep scale in sync` (x/y setters, direct scale setter,
`fit`, `zoomAround`, pan changing y x) assert `camera.scale ===
camera.view().scale` after each, with expected exact finite values from
previous tests (`fit` example given camera.test.ts:100-112); another covers
rejected nonfinite/negative values leaving both unchanged, copying values
from camera.test.ts:131-142; a clamped `zoomAround(1000,..)` produces MAX_SCALE
without stale scale. No need to import components into foundation tests.
Repeat `nsh test src/flow/canvas-controller.test.ts` to ensure no gestures'
behavior/updates changed by batched camera writes; if its expectations change
STOP rather than lowering counts.

**Verify** `nsh test src/flow/camera.test.ts` immediately before and after E;
004's five explicit fake-scheduler tests in Step E above must _all_ remain
green (this publisher invokes changed() once only after view/scale writes),
publish/no-ops stable. Focused new cases:

- `nsh test src/flow/camera.test.ts --filter "scale-only readers do not wake on pan"` passes with reader starts 1, panBy changing x/y leaves at 1.
- `nsh test src/flow/camera.test.ts --filter "one zoom publishes view and scale together"` exactly one second effect run with both scale updated.
- `nsh test src/flow/camera.test.ts --filter "all camera writes keep scale in sync"` covers direct setters (x/y/scale), fit, zoomAround, panBy, invalid/clamped path sync.
- `nsh test src/flow/canvas-controller.test.ts` remains unchanged;
  `nsh test src/flow/canvas-controller.test.ts --filter "box-selects only the
  cards the marquee covers"` explicitly validates named test at current :164.
- `nsh test src/App.test.tsx --filter "clears the selection with Escape"`, plus
  `nsh test src/App.host.test.tsx --filter "box-selects a card"` via
- Preserve 010 awaited-read semantics, 011 budget tests, 004 motion tests
  and existing selection API unchanged. `nsh test src/flow/canvas-controller.test.ts`
  remains required unchanged; no new evidence-only host test needed.
- The optional manual trace only uses already exact
  `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace`;
  no nonexistent mount budget. Record actual nsh::perf items/commit durations
  optional not CIs any tables. Completing E must run `bun run check` to guard
  `max-lines` across all changed foundation modules, and `bun run test` as
  part of each commit accepted gate. This whole plan is fully native canvas
  existing Flow, no second engine; no 007 invention.
  SelectionGeometry helpers since no 007 geometry accessor exists.

## Test plan

- Preview: all four listed cases (bounded count; deterministic tie; second
  chunk/deduplicated assets; old/new full vector equality). Rust `db.rs`
  test fixtures explicitly named and modeled after existing `save_run` and
  `assets` cases; no `native.test.ts` change for this native internal logic.
- Startup: migration-4 idempotence AND both partial indexes; exact query
  plans; `recovering_runs` remains unchanged; FFI `empty document` starts
  empty/after insertion not; the DB fixture pins the FK cascade (deleting the
  last node deletes its edges), so `is_empty` is true after the last node goes
  and the edge-only state is documented as unreachable.
- Resize: four deterministic promise/timer cases listed in C, no sleeps,
  injection required, no new queue/module surface unless otherwise blocked.
- Grid: new pure helper cases for negative offsets and static tile shift;
  existing geometry counts and App zoom coverage; identical geometry
  confirmed by manual trace, not a screenshot assert.
- Scale: all listed camera effect cases and original camera/controller
  suites; test never requires pixel position or mount event count absolute
  as correctness. `nsh test src/flow/camera.test.ts` must pass including at
  least the three new scale-read cases plus guards.
- Final: `bun run check`, `bun run test`, `bun run test:bench` all exit 0.
  No host-only test is required for these nonplatform changes; record any
  App trace/startup window separately as manual.

## Done criteria

- [ ] `previews()` loads a narrow node projection, capped four selected
      items/batch, grouped exact count and one deduplicated asset map per chunk.
      Four named Rust test cases prove geometry/count/order/output unchanged,
      including tie and second chunk.
- [ ] `Document.isEmpty` runs one worker job using existence reads, startup
      uses it after recovery; deleting the last node cascades its edges and
      `is_empty` then returns true (edge-only is unreachable under the runtime
      schema). Legacy count/edge-count remains.
- [ ] Version 4 creates two partial running indexes and idempotent
      migrations query plan proves each applies on the exact recovery filters.
      Migration 4 exercises version 4 data preservation via an existing v3
      populated fixture, not destructive schema reset.
- [ ] Resize unit test proves two pre-timer resizes produce exactly one
      `bounds()` read at last dimensions; user camera and disposal cannot be
      overwritten by late async results, all 010 single-flight tests pass.
- [ ] `GridBackground` tiles have only static positions; wrapper contains
      camera x/y; pure helper cases pass and trace drops per-tile updates.
- [ ] `! grep -n "props.camera.scale" src/components/SelectionFrame.tsx src/components/SelectionPluses.tsx` exits 0 (no
      camera.scale direct matches); every camera write funnels through one
      real public(view next publish including 004 changed() under batch).
- [ ] Exact `nsh test src/flow/camera.test.ts`,
      `canvas-controller.test.ts`, `viewport-controller.test.ts`, App filters
      and `cargo test --manifest-path src/native/Cargo.toml` all pass.
- [ ] `bun run check`, `bun run test`, `bun run test:bench` exit 0;
      measured numbers/provenance, changelog, and index status exist.
- [ ] No edits outside Scope except `plans/README.md`; no generated file
      manually edited; no AI attribution, push, or PR.

## STOP conditions

- Expected dependency work is missing or unrelated drift affects these exact
  functions, especially namespace generation for isEmpty and plan 009's
  referenced preview-timings. Report rather than implementing it here.
- SeaQuery's inner/outer window query cannot be decoded safely with bound
  inputs and exact counts/order; never substitute raw correlated SQL or
  per-node FFI to pass a test. SQL Query builder shape must be built first.
- A preview outputs only count of the selected 4, silently drops no-asset
  items, changes result order, or loader sees types/API incompatible with
  the original public fields.
- `isEmpty` generates anything other than the primary camelCase method;
  first attempt at standard NSH declaration regeneration is required.
- Migration_4 alters old migrations, creates an unbounded index, or drops
  data. Edge-only test setup is impossible due actual FK cascade: report,
  do not fake it or weaken the boolean condition.
- Any plan-010 refresh/latest-rect await behavior is broken, resize fit
  requires a second independent timer, or pending bounds can apply before a
  valid later fit request has superseded it.
- Camera has to abandon one publisher or mirror scale from an effect; don't
  leave a direct `view.set` bypass or fake no-notification test assertions.
- Any step's verification fails twice after a targeted repair, or completion
  requires edits outside explicit scope. Do not silently merge A–E failures
  into a new broad performance patch.

## Maintenance notes

- `read_items_for_batches` semantics are special to previews; composer detail
  must continue to read all items. Future preview ITEM count changes need
  both bounded window terms and count tests changed, not projection count.
- Keep one worker call for isEmpty; if more entities are considered part of
  emptiness in future, add them inside the same worker job after preserving
  no-data vs assets/non-node semantics deliberately — an asset-only doc is
  not necessarily empty content.
- Recovery partial-index columns/predicates exactly mirror filters. Update
  both only through a new migration if status/document predicates change.
- Resizes are ordinary scheduled work with an attached _optional_ fit intent.
  A direct user zoom/fit marks generation appropriately; future shortcut
  fitting must not accidentally turn userCamera=false under a stale refresh.
- Run release/headless benchmarks on the measured host, with local provenance.
  Nobody should turn SHOULD tail ms budgets into CI assertions. Benchmarks
  must stay ignored, single harness (bun run test:bench), A/B within one DB.
- This stand-alone scale derivation uses one central publisher and one
  explicit private projection per spec's ownerless signal fallback.
  There is no unowned computed in this plan: supervisors should review new
  direct camera view setters vigilantly. If NSH later offers a supported
  scoped selector, use a new plan instead of changing this working fallback
  ad hoc. Future grid properties must not re-add per-tile x/y reads.
