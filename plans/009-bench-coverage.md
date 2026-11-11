# Plan 009: Benchmark the 100k paths that grow

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/native/src/db.rs scripts/smoke-100k.mjs docs/plans/rust-core.md docs/testing.md CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (`plans/001-measure-in-release.md` is recommended for host profiling, not required)
- **Category**: tests
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `6ea781f`, 2026-11-11 — plan 001 landed and rewrote
  `docs/testing.md` (+116 lines, adding `## Measuring performance` at line
  61). `src/native/src/db.rs`, `scripts/smoke-100k.mjs` and
  `docs/plans/rust-core.md` are unchanged since `1956ebb`; Step 7's
  `docs/testing.md` references are updated below.

## Why this matters

The existing 100k release benchmark measures a node-only, in-memory fixture
and a scale-1 viewport. It cannot show how connector reads, Fit/low zoom,
image preview joins, large gesture commits, undo/redo, or file reopen behave
at the document sizes the canvas must support. Establish a materialized,
real-shape baseline now so subsequent read, write, preview, and startup
optimizations can be compared against it without guessing their workloads.

## Current state

### Existing benchmark and required conventions

- `src/native/src/db.rs:2030-2048` builds 1,000-node chunks with
  `benchmark_nodes`; every node has `kind: "text"` through the helper at
  lines 470-485:

  ```rust
  fn benchmark_nodes(chunk: usize) -> Vec<NodeInput> {
      (0..1000)
          .map(|offset| {
              let i = chunk * 1000 + offset;
              node(
                  &format!("n{i}"),
                  &format!("Node {i} image generator"),
                  // ...
                  (i % 100) as f64 * 220.0,
                  (i / 100) as f64 * 140.0,
              )
          })
          .collect()
  }
  ```

- `db.rs:2050-2071` exposes ignored `seed_benchmark_database`, controlled by
  `FLOW_BENCH_DB`, and checks only `count == 100_000`. The ignored
  `hundred_thousand_nodes_benchmark` at lines 2073-2193 uses
  `Database::open(":memory:")`, measures `viewport`/`scene` on a 1920×1080
  world rect with 120 world-unit margin, and repeats common-term search.
  It has zero edges, result batches, or assets. It computes an average and
  an index-based p95, prints at the end, and never commits/undoes a move.
- `scripts/smoke-100k.mjs:26-41` calls the same ignored seed and lines
  43-64 run pan, zoom, search/reveal, Fit, a 6% zoom, and screenshots. Its
  `nsh test` spawn at lines 66-70 does not include `--trace` or wall-time
  instrumentation; the benchmark database/seeding is separate from the
  release commands, as `db.rs` confirms.
- `docs/plans/rust-core.md:358-370` gives non-CI performance targets,
  including file-open under 300 ms, 1,000-node move and undo each under 50 ms.
  Lines 409-411 explicitly say these are **not printed by the benchmark yet**:

  > File-open, 1,000-node commit and undo timings at 100k are not printed by
  > the benchmark yet; the reopen test covers persistence and schema creation
  > with a small document.

  Preserve these as reported targets, not assertions. The existing measured
  table says its build was in-memory: extend the document with a new
  file-backed enriched-fixture subsection/table instead of rewriting old
  P0 measurements as though identical.

- The existing ordinary reopen test to copy for temp-file ownership is
  `db.rs:1122-1155` `persists_across_reopen`: it uses a process/timestamped
  path inside `std::env::temp_dir()`, scopes `Database`, then removes `""`,
  `"-wal"`, and `"-shm"` files. `db.rs:1158-1179` shows a directory with
  spaces. The crate has no `tempfile` dev-dependency: do not add one merely
  for this benchmark.
- `docs/standards.md:373-384`, §8.2, requires per-frame work to be
  proportional to visible cards and says:

  > Frame budgets (about 10 ms of app work and 16.7 ms per frame at 60 Hz,
  > 50 ms input-to-feedback) are SHOULD targets measured manually on the
  > reference host; they MUST NOT be asserted in CI without a stable
  > benchmark.

  Rust operation timing assertions, automatic target failures, or promoting
  either ignored test to `bun run test` would violate this plan's intent.

- `package.json:22-23` already provides
  `test:bench = cargo test --manifest-path src/native/Cargo.toml --release -- --ignored --nocapture`
  and `test:100k = bun scripts/smoke-100k.mjs`. Do not add dependencies or
  move these ignored tests into the ordinary gate.

### Actual APIs the fixture and measurements must use

- `src/native/src/types.rs:14-30`: `NodeInput` has public `id`, `kind`,
  `title`, `body`, `tags`, `x`, `y`, `width`, `height`, `z`, optional
  `data_json`, `settings_json`; use the existing `node` test helper and set
  `kind` only for designated image nodes.
- `types.rs:51-61`: `EdgeInput` needs id/from/to/kind and optional port/data
  fields. For grid index `i`, if `i % 100 < 99`, link `n{i}` → `n{i+1}`;
  `i % 100 == 99` is that row's right edge and has no right-neighbor edge.
  Each edge stays on its row, 220 world units apart: neighboring rows form
  independent 100-card chains instead of unintended cross-row spans.
  There are exactly **99,000 connectors** (99 per row × 1,000 rows). For
  example `i = 0, 1, ..., 98` creates `e0` through `e98`; skip `i = 99`.
  Use `EdgeInput { id: format!("e{i}"), from_id: format!("n{i}"),
  to_id: format!("n{}", i + 1), from_port: None, to_port: None,
  kind: "flow".to_owned(), data_json: None }`.
- `db.rs:188-190` `insert_edges` invokes the ordinary
  `mutation::insert_edges` path. Unlike `connect_edges`, it does **not** clone
  source result items into targets. This is the app's explicit "Inserts edges
  whose endpoints already exist" path (`src/native/src/lib.rs:261-268`) and
  maintains the edge RTree through the normal insert helper. Do not use
  `connect_edges`, which would duplicate all 2,000 images' four-item batches
  as edge snapshots and change the fixture unintentionally.
- `types.rs:114-124,150-163` defines `AssetInput` and `ResultBatchInput`.
  `db.rs:170-173` imports bytes content-addressed to disk;
  `src/native/src/asset.rs:19-35` derives `<db-directory>/assets` for a file
  database, and `asset.rs:104-123` writes unique hashes. Use a small PNG
  fixture (the same bytes may intentionally deduplicate, matching current
  asset tests) with valid pixels and distinct ids per image batch item. A
  tiny valid 1x1 PNG would cause repeated identical pixels for thousands of
  images; instead vary the per-asset `meta_json` only if you deliberately
  elect metadata variation, while still testing byte dedup. For the
  deliberately host-mounted portion choose a small distinct ordinary RGB PNG;
  commit its Rust test-only bytes (or a generator that uses no new image
  crate). Avoid enormous file bytes or data: URL construction in the smoke.
- `db.rs:142-149` `save_run` accepts `ResultBatchInput` plus item vec and the
  running/success variants persist nodes/batches. `mutation.rs:836-893` shows
  `mutation.rs:836-893` covers both variants: `done` assigns output selection
  and can mark downstream nodes stale at 874-881; `running` sets node status
  while preserving its existing output selection and skips downstream staleness.
  The explicit
  text-only sink selection in Step 5 (no image fixtures, no outgoing edges)
  keeps recovery isolated. Keep recovery batches distinct from preview fixture
  output. Call `db.save_run` with a per-sample unique running batch id; no
  separate `db.set_node_status` call is needed because `save_run` writes
  `status = "running"` and leaves output selection intact in the same
  transaction. Leave setup outside measured open/recovery timings. `db.rs:155-158`
  separately exposes `set_node_status` and `recover_runs`, but the former is
  not used for this fixture.
- `types.rs:139-148`: each `ResultItemInput` takes id, position, kind, text,
  optional `asset_id`, `meta_json`. Give every designated image node one
  successful four-item `"image"` batch and `output_batch_id` through
  `db.save_run`. Deterministic ids should include image-node index, batch,
  item, and asset identifiers to avoid collisions.
- `db.rs:184-186` `set_node_bounds` takes `Vec<NodeBounds>` and returns a
  `Mutation`; `types.rs:104-112` is just id/x/y/width/height. `db.rs:204-245`
  implements public undo and redo, so call `db.undo()` and `db.redo()`; do
  not time internal `apply_ops` as a substitute. `db.clear_history()` resets
  the seed's history so exactly one measured large move is undone.
- `db.rs:51-71` waits until startup initialization completes before
  `Database::open` returns; `open_connection` configures WAL/cache and runs
  `schema::migrate` (`db.rs:326-358,433-440`). `recover_runs` is separate
  (`db.rs:155-158`) and can find whole-table running status
  (`mutation.rs:925-956`). Measurements must not call recovery on only an
  already-open handle and call that "open" if they intend to include opening.
- `db.rs:254-264` exposes `viewport`, `scene`, and `bounds`.
  `src/native/src/scene.rs:22-35` returns nodes **and edges**; scene also
  looks up far endpoint geometry for connectors at `scene.rs:103-174`, so
  asserting only nonempty nodes would miss broken/misleading baselines.
- `detail.rs:15-16` uses 400-id chunks and `PREVIEW_ITEMS = 4`;
  `detail.rs:40-80` shows `previews` follows batches/items/assets rather than
  image geometry. Times must include returned row counts and validate image
  item counts and asset linkage, not just total elapsed time.
- `src/flow/viewport-controller.ts:10` uses `VIEWPORT_MARGIN = 0.25`;
  its `visibleRect` calculation at lines 144-149 adds
  `max(rect.width, rect.height) * 0.25` world units. Mirror that exact
  formula, not 25% of a single dimension.
- `src/flow/camera.ts:81-90` maps screen to world with
  `x_world = (x_screen - camera.x) / scale`. To place document bounds at the
  middle of a 1920×1080 stage, camera x/y are
  `stage/2 - (bounds.origin + bounds.size/2) * scale`. Expand this helper's
  viewport rectangle if needed to include the camera `padding = 48` in Fit:

  ```rust
  fn scene_request(bounds: &Viewport, scale: f64) -> (Viewport, f64) {
      let padding = 48.0;
      let camera_x = 960.0 - (bounds.x + bounds.width / 2.0) * scale;
      let camera_y = 540.0 - (bounds.y + bounds.height / 2.0) * scale;
      // Begin at apparent stage origin (-padding,-padding) and end at
      // (1920+padding,1080+padding), using one clamped camera center.
      let x = (-padding - camera_x) / scale;
      let y = (-padding - camera_y) / scale;
      let width = (1920.0 + padding - camera_x) / scale - x;
      let height = (1080.0 + padding - camera_y) / scale - y;
      let margin = width.max(height) * 0.25;
      (Viewport { x, y, width, height }, margin)
  }
  ```

  Function `camera.fit` at `camera.ts:115-137` uses
  `(1920-96)/bounds.width` and `(1080-96)/bounds.height`, caps at 1, and
  clamps minimum to 0.05. For the unchanged grid, actual min fits are around
  0.0451–0.0457 depending on the exact bounds extents, clamped to 0.05.
  Benchmark scales should be the computed/clamped Fit value, 0.15, and 0.40.
  Use the real `db.bounds()` result in the formula. Its width/height are
  exactly `max(x+width)-min(x)` / `max(y+height)-min(y)`; pass those returned
  values directly into `scene_request` and do not recompute the extents or
  assume a fixed card width.

## Commands you will need

| Purpose                         | Command                                                                                                                                                                         | Expected on success                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Build/run ordinary native tests | `cargo test --manifest-path src/native/Cargo.toml --lib`                                                                                                                        | all nonignored tests pass                                                                |
| Full release 100k benchmark     | `cargo test --manifest-path src/native/Cargo.toml --release db::tests::hundred_thousand_nodes_benchmark -- --ignored --nocapture --test-threads=1`                              | prints all measurements and fixture/row counts, exits 0                                  |
| Seed the real-host 100k fixture | `FLOW_BENCH_DB=.nsh/bench/flow-100k.db cargo test --manifest-path src/native/Cargo.toml --release db::tests::seed_benchmark_database -- --ignored --nocapture --test-threads=1` | deterministic counts printed; PowerShell uses `$env:FLOW_BENCH_DB=...`                   |
| Real-host scenario              | `bun run test:100k`                                                                                                                                                             | seeds edge-rich no-image graph, steps complete with trace/time logs, screenshots written |
| Full repo gate                  | `bun run check`                                                                                                                                                                 | exit 0, no warnings                                                                      |
| Full ordinary tests             | `bun run test`                                                                                                                                                                  | exit 0, ignored benchmarks excluded                                                      |
| Rust changed-file format        | `cargo fmt --manifest-path src/native/Cargo.toml -- --check`                                                                                                                    | exit 0                                                                                   |

`bun run test:bench` remains the documented run-all-ignored command; use the
single-test command above when iterating to avoid unrelated ignored work.
Do not run the benchmark and UI smoke concurrently against the same path.

## Scope

**In scope** (the only files you should modify):

- `src/native/src/db.rs`
- `scripts/smoke-100k.mjs`
- `docs/plans/rust-core.md`
- `docs/testing.md` — update the obsolete fixture/capability descriptions
- `CHANGELOG.md` — note the richer benchmarking/smoke coverage

**Out of scope** (do NOT touch, even though they look related):

- `src/native/src/viewport.rs`, `scene.rs`, `detail.rs`, `mutation.rs`,
  `search.rs`, `edge_index.rs`, `schema.rs`, `history.rs`, entity definitions,
  and public FFI classes/types — this plan measures, not optimizes.
- `package.json`, `src/native/Cargo.toml`, lockfiles, or new helper crates —
  the necessary commands/type shapes exist.
- `src/flow/**`, `src/components/**`, `src/pages/**` — no view/gesture edits.
- `E:\code\mine\nsh-pr` — read host sources only; do not change NSH trace.
- `scripts/dev.mjs`, `src/nsh.json`, sandbox/capabilities, release workflow.
- `.nsh/bench/**`, temp databases, asset bytes, screenshots, and generated
  `.nsh` output — evidence only, never commit.
- Any latency target or timing assertion. Do not change `NODE_LIMIT`, preview
  sizes, viewport margins, DB schema, query behavior, or existing P0 targets.
- No new module unless `db.rs` would exceed the 500-**code**-line lint cap;
  if that occurs, STOP rather than widening scope to redesign native tests.

## Git workflow

- Branch from `main`: `git switch -c advisor/009-bench-coverage`.
- Commit per logical unit: richer fixture, timing/reporting coverage, UI smoke
  instrumentation, measured-doc update. Conventional Commits with lower-case
  imperative subjects and explanatory bodies; follow existing
  `perf: keep canvas gestures to one update per moved card` (`1956ebb`).
- Never add AI attribution: no `Co-Authored-By:` trailer naming an AI and no
  "Generated with ..." line.
- Do not push and do not open a PR.
- Later updates to this fixture must retain a versioned description in
  `docs/plans/rust-core.md`; subsequent comparisons cannot conflate the old
  node-only table with this fixture.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md` (the Markdown formatter
  realigns tables). This required status row is the sole source-file
  exception beyond the Scope list.

## Steps

### Step 1: Refactor the common deterministic seeded fixture without timing it

Inside `db.rs`'s existing `#[cfg(test)] mod tests`, replace direct loops over
`benchmark_nodes` with a small private fixture builder/seeder. Preserve
`benchmark_nodes(chunk)` and all body/search/grid values byte-for-byte so
legacy search/bounds comparisons remain understandable.

Define the enriched fixture as version **"100k-grid-edges-images-v1"**:

- 100,000 nodes in the same 100×1,000 grid; exactly 2,000 image nodes where
  `i % 50 == 0` (0, 50, ..., 99,950); others remain text.
- Exactly 99,000 right-neighbor edges via **`db.insert_edges`** in bounded
  batches (1,000 or another explicit chunk ≤ an ordinary operation's memory /
  SQL limits). Because all endpoints have been inserted first, ordinary edge
  insertion resolves their ports and maintains the edge index.
- Every image node gets one four-item image result batch through `save_run`.
  Asset ids must be attached to `ResultItemInput.asset_id`; text fields and
  metadata remain valid, with positions 0–3. The asset itself uses **one
  small deterministic PNG** whose pixel shape changes by image index, created
  as in-memory bytes before `import_asset`; a literal byte-for-byte duplicate
  is allowed to dedup while distinct image input hashes differ. A tiny
  2×2-pixel PNG is adequate for actual `<Image>` mounts. Precompute/commit
  the static byte strings in the test module, or (if generation truly needed
  and missing a tiny no-dependency PNG approach) report why an external helper
  would be needed; don't add an image crate or runtime dependency to the
  benchmark. Do not use SVG as the smoke fixture without verifying renderer
  support. Eight thousand image `ResultItemInput`s link to these PNGs. The
  preview path (`src/flow/previews.ts:20-33`) passes URLs from `AssetUrls` to
  NSH `<Image>`; with real assets the image host actually parses/loads them.
  Asset/source ids unique per image node and item. Do not individually time
  fixture creation.
- Seed during construction without counting history; call `clear_history()`
  immediately before benchmarking mutations. Structure scopes so reopen
  measurements get a freshly opened history.
- Keep the common builder returning a typed `BenchmarkFixture` summary with
  explicit `include_images` behavior: true for both benchmark and seed would
  cause unnecessary real photo-mount work in UI step tests. Use a clearly
  named inner `seed_grid(db, include_images: bool)`, with public ignored
  wrappers `seed_benchmark_database` (false) and the full benchmark (true).
  Include no image batches in the smoke variant; never silently set false
  in the default path and then only assert text node counts. Explicit
  constants and printed summary must distinguish them. This is an advisor
  deviation for real host asset behavior, not a smaller claim.

Factor common file lifecycle into a safe test-only owner or function with
explicit cleanup:

1. Create a unique directory inside `std::env::temp_dir()`, not the repo,
   incorporating process id and existing `now_ms()` (if extra uniqueness is
   needed, use a local counter as `asset.rs` already does). Include the
   fixture-version label and do not accept a shared arbitrary path for the
   timed benchmark.
2. Keep the database path as `dir.join("flow-100k.db")` and assets under
   `dir.join("assets")`, matching the real core. Remove files and directories
   only within the directory made by this test. On failure cleanup is
   best-effort; report the retained path so evidence is not silently lost.
3. Keep `seed_benchmark_database` and its explicit `FLOW_BENCH_DB` deletion
   behavior, because the smoke intentionally reuses `.nsh/bench/flow-100k.db`.
   Document in both code and docs that this destructive re-seed is only for a
   dedicated bench file; never delete an ordinary `FLOW_DB_PATH`.
4. Make seeding idempotent for a fresh path and assert
   `count == 100_000`, `edge_count == 99_000`, previews have 2,000 rows across
   all image ids, every preview has `item_count == 4`, each preview item has
   `kind == "image"` and `asset.is_some()`, and first `assert_eq` failure
   identifies the aspect that broke. Print a fixture metadata line containing
   version, logical counts, and database path used for a persistent seed.

Keep the existing `hundred_thousand_nodes_benchmark` ignored; switch it to
the same file-backed enriched seeder rather than its own divergent in-memory
fixture. Retain legacy viewport bounds fit `Viewport { 0,0,1920,1080 }` with
120 margin as an additional labeled read for rough continuity, but no longer
use it as the only `scene` measurement. Separate initial seed timing from
later operation timings, and do not mix asset/store setup or reopen into
scene percentiles.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml --lib` → all ordinary tests exit 0; `cargo fmt --manifest-path src/native/Cargo.toml -- --check` → exit 0; code constructs 99,000 edges and 2,000 four-item image batches and `db.rs` has no unignored new 100k test.

### Step 2: Add a reusable statistics formatter and truthful repeated samples

Within the existing private test module, add a `BenchStats`/`Samples` helper
that records `Duration` samples and prints human-readable:

- scenario name, sample count, average ms, nearest-rank p95 ms, maximum ms;
- node rows, edge/preview rows, or operation count as relevant;
- the viewport scale, margin, and request rect for scene readings.

Prefer a `struct Stats { avg_ms: f64, p95_ms: f64, max_ms: f64 }` plus one
`print_stats(label, &mut Vec<f64>, ...)` to separate statistics from output.
Sort finite samples using `partial_cmp(...).unwrap()` consistent with current
test code or `total_cmp` (no `any`, no extra production dependency). Average
must divide by actual sample count. With `n` samples, nearest-rank p95 is
`sorted[((n * 95 + 99) / 100 - 1).min(n - 1)]` for integer arithmetic (ceil of
`0.95n`), avoiding out-of-range indexing. Print raw durations too only if it
makes comparisons clearer, not in place of explicit ms and row counts.

Use at least **one warmup and five timed samples** per scene zoom and preview;
at least **three measured move→undo→redo cycles** to reveal history/index
costs. Retain existing search coverage (`generator`, `Node 99999`, `图片`,
`生成器`), keep enough repeats for its prior p95 (normally 20 as today), and
show result counts for every query. Document when a path is warmed by earlier
reads and whether timing covers only the direct synchronous database method.
This is a local benchmark, not statistically rigorous benchmarking
infrastructure; do not pretend broader timing guarantees.

**Verify**: `cargo clippy --manifest-path src/native/Cargo.toml --all-targets -- -D warnings` → no warnings, including helper naming/numeric conversions; a small deterministic unit test of p95 ceil and row-summary formatting is strongly preferred but optional unless you introduce a general helper module. It must not add sleeps.

### Step 3: Measure fitted scene reads at three scales and previews

Call `db.bounds()` once before scene measurements (and record it separately
for provenance), then calculate Fit with the actual camera rules shown above.
For each of Fit (explicitly print computed scale and whether clamped), 0.15,
and 0.40:

1. Compute the centered area formula above and margin `0.25*max`.
2. Warm once outside samples.
3. Call `db.scene(rect, margin)` on each measurement.
4. Accumulate both `snapshot.nodes.len()` and `snapshot.edges.len()`, assert
   the same row counts across repeated identical reads (or record why the
   document changed, if made intentionally), and include rows in every print.
   Because the UI later applies card budgets, these are **native read rows**,
   not the mounted card count.

Do not add a scale-budget/rows ceiling as an optimization decision: this
plan's purpose is exposing that native currently returns up to the node read
limit and all relevant connectors, not fixing that behavior. Print Fit row
counts even if large. Include the existing scale-1 `viewport` and `scene` read
under their own label, explicitly noting it is a legacy reference (now with
edges and images).

For previews, pass all 2,000 image node ids in a realistic call (five
400-id internal chunks, independent of your input shape), warmup once and
sample at least five times. Print returned preview rows and item/asset counts,
assert each preview still has four items, asset metadata exists for all four,
and no requested image id is missing. Never make seed shorter to mask the
expense.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml --release db::tests::hundred_thousand_nodes_benchmark -- --ignored --nocapture --test-threads=1` → output identifies `scene fit=0.05...`, `scene scale=0.15`, `scene scale=0.40`, their explicitly calculated margins/rects, both node and edge rows, and `previews images=2000` with returned preview/items/assets; all passes without time thresholds.

### Step 4: Measure the large gesture commit and its inverse through public history

Select 1,000 **contiguous grid nodes** (for example n49000…n49999, if within
range), not disjoint rows that turn the command into a different workload.
Read their original summaries before the cycle to create expected
`NodeBounds`. For each of at least three cycles:

1. Call `set_node_bounds` with all 1,000 rectangles at an explicit new
   translation (`x + 30`, `y + 20`) and time it. Assert exactly 1,000 changed
   summaries; compare old/new geometry and ensure connector endpoints still
   reflect the moved cards in a focused follow-up scene or `get_node`, not as
   part of the timed section.
2. Immediately time `db.undo()` and assert the changed count / restored
   geometry. Then time `db.redo()` and assert reapplied geometry. Print all
   three independently with the same sample index.
3. Do not assert a particular connector-batch `edges_changed.len()`:
   `mutation::set_node_bounds` currently returns `edges_changed: Vec::new()`;
   important edge-index maintenance must still be evidenced separately once
   visual read finds moved endpoints. Use `get_node` / `scene` after timing
   to check both moved and far endpoint geometry, not timer samples.
4. Warm up on a separate offset and complete its undo **before** timing the
   three identical-shape samples. Each sample sequence must be:

   1. Read current rects for the 1,000 nodes and build `before`.
   2. Call and time absolute `set_node_bounds` of every rect to
      `offset_before + (30 + c, 20)` where c=1,2,3. Assert 1,000 changed
      records; `scene` endpoints after timed call are separate validation.
   3. Call and time `db.undo()`; assert restored `before` via `get_node`.
   4. Call and time `db.redo()`; assert target via `get_node`.
   5. Reset to `before` using explicit `set_node_bounds` **outside timing**
      (one reset sample's overhead is not conflated with any of the three).
      Redo remains on history, so next cycle's initial absolute-change push
      correctly truncates it; optionally `clear_history` after this outside-
      sample reset to deliberately keep cycle history shape equal, document
      in output if done.

   Use integer translations exactly `(31, 20)`, `(32, 20)`, `(33, 20)` for
   samples 1-3 as seen from each start, after reset. Every cycle has the same
   original geometry, so endpoint and history workloads differ only in
   measured sample index. No accidental same-value commits or empty undo.
   Final reset leaves original document layout and no intended unaccounted
   translation before recovery setup.

5. Keep fixture-builder geometry/other fields consistent and do not call `db.clear_history` during a move→undo→redo sample.

No scene/preview validation call should be included in a setNodeBounds sample
unless printed separately. Query checks can run after timing. Preserve the
public `db.undo` / `db.redo` calls so history bookkeeping is actually covered.

**Verify**: the single-test release command from Step 3 emits `setNodeBounds moved=1000 ... avg/p95/max`, then separately `undo`, `redo`, with ≥3 cycle values; shape/geometry assertions pass and no `db.apply_ops` is used in place of a public history timing.

### Step 5: Measure temp-file reopen and outstanding-run recovery

Treat `Database::open` as a fresh app-owned worker/connection/migration on a
file the OS/cache just saw seeding, not an OS process or page-cache cold
start. Mark `warm-file reopen` (not "cold") in printed labels. Drop the current `Database` handle in an explicit scope
before each measured reopen: the worker belongs to the scoped handle, closing
when its job sender drops. File contents therefore must be the seeded state
from the earlier scope, not an empty in-memory or first-creation benchmark.
`Database::open` runs connect/migrate again without destroying existing
nodes. The initial `Database::open` after seeding is a building prerequisite,
not a timed case; its fixture seed timing is labeled separately.

Create a deliberately small, deterministic set of outstanding work on **100
sink nodes (targets with no outgoing edge)** with ids `n49999, n50999,
n51999, ..., n148999`. At row-end `i % 100 == 99` each has no outgoing
right-neighbor edge, so neither a running nor a successful `save_run` can
mark downstream neighbors stale. A running `save_run` sets the node's status
and preserves its existing `output_batch_id`, so do not call
`db.set_node_status` separately. `40199 + 1000*k` integer formula is not
needed; just use `(0..100).map(|k| 49_999 + k*1000)` in code. All these are
odd and never multiple of 50, hence text, not image nodes; assert `kind ==
"text"` and each id ends with `99`. This yields 100 selected nodes; separate
image status from recovery warm-up without changing unrelated rows. Use
these exact ids unless a later path change invalidates them; then STOP.
Call `db.save_run` with
`ResultBatchInput.status = "running"`, no output items, and a unique batch id;
assert each pre-reopen `db.node_detail(id)` returns `node.status == "running"`
and a `latest_batch` with the new id and `status == "running"`. This is the
existing detail surface that exposes batch status.
Use a valid model/provider/JSON fixture like existing test
`recovering_runs_marks_running_nodes_interrupted` (`db.rs:1999-2028`).
Then drop the handle and time one re-open as two separate spans:

1. `Database::open(&path)`, timed alone and labeled **open/migrate only**;
2. `db.recover_runs()` immediately after, timed separately and assert the
   return equals the number of currently running nodes.

Print rows recovered and the two timings; also print combined
`open+migrate+recover_runs` for comparison to the external target. Across
repeats, re-mark exactly the intended nodes running with fresh running batch
ids outside each combined sample; avoid polluting the subsequent move query
fixture. If moving the set of running nodes complicates correctness, run
recovery after move samples, with named deltas/provenance in output. Read
back affected node/batch status where practical and ensure interrupted nodes
are no longer selected as running by a subsequent recovery call. Do not time
temp directory creation as if it were opening a pre-existing document.

Keep a final clean re-open check and all cleanup in the temp tree. Preserve
the existing small ordinary `persists_across_reopen`; this larger case stays
`#[ignore]` and only runs in the benchmark.

**Verify**: benchmark output distinguishes `open+migration` from `recover_runs` and their combined total, with `recovered=100` and the second recovery result 0; repeated iterations use unique running ids, and cleanup removes only the generated temporary root.

### Step 6: Make the smoke's work and host profile observable

Preserve every existing action, selection, search, Fit, and screenshot in
`scripts/smoke-100k.mjs`. For `seed_benchmark_database`, call the common
builder with `include_images = false`, while the full benchmark uses true.
Assert the returned no-image variant's 100,000 nodes and 99,000 edges and
zero batch previews. Update the script header/doc string to state that it
shares the text graph but not the image-heavy timer fixture. Its no-image variant is still a common
deterministic graph topology (100k nodes plus 99k within-row edges) but
deliberately leaves 2,000 image nodes as text for the smoke: at Flow HEAD
`src/flow/asset-urls.ts` builds base64 data URLs that QuickJS and native
`Image` decode repeatedly, and the real existing assets are small SVGs. At
Fit that could introduce a sizable image-specific mounting/decode workload
without making it observable row-by-row. Photos deployed through URL loading
need a separate explicitly identified image-mount measurement before calling
that slow or unsupported. Rust previews still exercise real persisted asset
reads. Record this deliberate smoke topology difference in the script header
and docs instead of claiming the smoke mounts 2,000 images: the benchmark
native counts are still 100k nodes, 99k connectors, 2,000 image batches with
4 preview items each; smoke counts are 100k and 99k and **0 image batches**.
Do not add or change image decoding code in this plan.

Within that file only:

- Capture seed elapsed wall time through `performance.now()` or `Date.now()`
  and log it as a local observation; do not assert its budget.
- Add `--trace` and `--fps` to the existing `nsh test` args; retain the
  selected `--target` and `FLOW_DB_PATH`. NSH's nonverbose logger suppresses
  `nsh::fps` host-monitor info records (`crates/nsh-cli/src/logger.rs:7-10,77-87`),
  so include `--verbose`, the pinned CLI's global flag at `main.rs:84-96`.
  `--verbose` may be the last argument after `test`'s flags. `--trace` remains
  separately visible as `nsh::perf` (`logger.rs:80-84`). Avoid committing any
  unbounded trace output file; trace is terminal evidence.
- Change **measurement plumbing only**, not host selection, generated
  workspaces, or application code. Keep the existing
  `nsh test src/App.tsx --target <target>` invocation and its ordinary
  development-host build behavior. Note in the script report and
  `docs/testing.md` that release **Rust benchmark** and real-host smoke are
  separate profiles: the latter currently runs a development host until a
  maintainer intentionally adds supported release-host plumbing. Do not
  claim its timings are release-host readings.
- Plan 001 independently provides `bun run dev:release` for manual release
  host profiling; it is not a required change here. Do **not** start and kill
  that interactive dev-server while the test session owns the same app port.
  Do not probe for silent host replacement by copying release binaries into
  debug paths or expecting unsupported `nsh test --release` switches: pinned
  `crates/nsh-cli/src/main.rs:140-201` defines no such test flag.
  Full scene `avg/p95` coverage already lives in the ignored release Rust
  benchmark; this smoke provides realistic UI actions and trace/paint
  observations with its actual profile labeled.
- Prefix log lines `100k smoke` and measure named phases using marker log
  lines in `steps` (`console.log("100k smoke marker: before-pan", ...)`),
  plus surrounding wall-clock outputs. The test evaluator uses JS statements;
  `await app.wait` is valid and existing. Include explicit elapsed per logical

  phase using `Date.now()` before/after groups of test steps if supported by
  the evaluator; if dynamic loop/state syntax fails, keep each emitted phase
  timestamp and calculate intervals outside it, not by introducing an app
  sleep or replacing waits. Avoid hardcoded timing budgets.

- Preserve the existing literal `5%` and `6%` assertions **unchanged**, but
  instrument the zoom-label texts around them: `100k smoke zoom after Fit:
  ${app.texts().filter(t => /%$/.test(t)).join(",")}` and same after `mod+=`.
  Use exactly `mod+=`, the binding at `src/flow/bindings.ts:22`, not `mod=`.
  If the real grid Fit is about 4.51% (rounded 5%), a 1.2 keyboard zoom
  could yield 7%, making the current 6% waiter time out. If that happens,
  report the observed labels and mark smoke blocked; do not alter viewport
  behavior or silently rewrite this assertion/product expectation. If its
  stage-dependent zoom is 6%, record that label for reproducibility. This
  is an existing behavior diagnosis, not a required performance threshold.
  Compiled-in final result screenshot names stay unchanged.

Important provenance correction to inline in `docs/testing.md`: pinned NSH
`crates/nsh-cli/src/main.rs:140-201` documents that host `--trace` prints
batches under the step and the time of each commit. Treat engine `commit` and
`event js` timings as separate `nsh::perf` records while batches identify
steps; do not promise every composite under a step. Note `--fps` real-host
paint records supplement headless `nsh test <file> --trace`.

**Verify**: `bun run test:100k` → seed and all UI steps exit 0, output includes a labeled real-host profile, `100k smoke` elapsed/step-phase output, trace records, monitor lines, and screenshots `.nsh/bench/flow-100k-reveal.png` / `flow-100k-overview.png`; git status shows no generated artifacts staged/tracked.

### Step 7: Record real outputs and update affected docs

Run the benchmark once after it is complete, in a quiet reference environment
where feasible; save its output **outside the repository** for later quoting
in your response. Write a new `docs/plans/rust-core.md` subsection under the
P0 measured results, near lines 409-411, named explicitly for
`100k-grid-edges-images-v1`, including:

- date, OS, CPU and memory (or "not recorded" if unavailable), machine
  background-load observation, actual repository SHA, NSH `f0b4659` pin,
  `cargo test --release` profile, file-backed DB and asset tree;
- fixture counts: 100k grid nodes, 99,000 right-neighbor edges, 2,000 image
  nodes each with 4 preview items/assets (+100 transient outstanding runs in
  recovery samples, clearly labeled);
- Fit computed camera scale, 0.15/0.40 and explicit request margins;
- scenario rows for Fit/0.15/0.40 scene (both node and edge rows), previews,
  1,000 set/undo/redo, open/migrate/recovery/combined, and search timings;
- replace the "not printed by the benchmark yet" sentence with a precise
  pointer to this new measured table, preserving the historical in-memory P0
  table. If a genuine environmental limitation prevented some numbers, mark
  those rows "not measured" with the exact reason and report incomplete;
  never invent/promote old node-only measurements into the new fixture;
- remind readers these are local manual measurements and targets, not CI
  thresholds; follow-up optimizations should compare this same fixture or
  explicitly name a new version rather than silently rewriting the baseline.

Update `docs/testing.md:21-27` (currently says the benchmark covers the
100k-node path plus CJK), the real-host paragraph at lines 50-61, and the
test-path bullet near line 319 that mentions the 100k smoke: describe the
shared edges/images/file fixture, detailed benchmark command, steps/trace
profile, and manual review. Plan 001 landed: link to the existing
`## Measuring performance` section (line 61) and use `bun run dev:release`. Add `CHANGELOG.md` under `Unreleased` → `Added` or `Changed` a short
note about deeper large-document benchmarking/tracing, not performance gains.

**Verify**: `grep -n '100k-grid-edges-images-v1\|99,000\|2,000\|open.*recover\|setNodeBounds\|not measured' docs/plans/rust-core.md` → new table contains metadata/counts/all actual results; `grep -n 'not printed by the benchmark yet\|100k-node path' docs/plans/rust-core.md docs/testing.md` → obsolete statements are gone or clearly scoped to historical P0 text; no empty measurement rows masquerade as data.

### Step 8: Run gates and final scope/done checks

Run full `bun run check`, `bun run test`, and the final explicit release
benchmark command; run `bun run test:100k` as the real-host gate where plan
Step 6 is truly implemented. Include manual command status separately from
ordinary automated test results. Inspect `git diff --check` and diff scope;
the only README/status exception is as above. Remove no user's bench DB
unless it is a path created by your own smoke/ignored benchmark seed; never
clean `.nsh/dev`.

**Verify**: `bun run check && bun run test && git diff --check` → exit 0, ignored 100k benchmark not executed by the default gate, no whitespace errors; final release-benchmark/smoke results explicitly recorded; `git status --short` contains no build database/asset/screenshot artifacts.

## Test plan

- Existing primary patterns: keep all ordinary Rust tests in
  `src/native/src/db.rs`, especially `persists_across_reopen`
  (`1122-1155`), `recovering_runs_marks_running_nodes_interrupted`
  (`1999-2028`), and `assets_are_content_addressed_and_read_back`
  (`1833-1860`), as models for lifecycle, recovery, and asset assertions.
  Do not create TSX tests for what is exercised in Rust or the smoke driver.
- `src/native/src/db.rs` `hundred_thousand_nodes_benchmark` remains
  `#[test] #[ignore]`; `seed_benchmark_database` remains ignored. They now
  assert **counts and output validity**, never timings:
  - Seed: exactly 100,000 nodes / 99,000 right-neighbor edges.
  - Image seed: exactly 2,000 requested preview records, each with 4 image
    items, nonempty asset metadata; identical ids/geometry across seeding,
    not an arbitrary randomly scaled fixture.
  - Scene: stable node **and edge** rows across repeats at Fit, 0.15, 0.40,
    and label the actual read row counts; include proper margins derived from
    the request. Row counts may legitimately exceed the UI's visible budget.
  - Move: 1,000 summaries changed; measured undo restores and redo reapplies
    geometry through public calls, across ≥3 cycles.
  - Reopen: open timing includes create/connect/migrate, recovery separately
    finds chosen running rows (100) and returns 0 once interrupted. No
    illusory "open" timed by borrowing a live worker.
  - Sampling: avg nearest-rank p95 samples printed; no `>=20` p95 indexing
    error if a scenario uses five or three samples; count must be positive.
- `scripts/smoke-100k.mjs`: retain original user-visible scenario and both
  screenshots; verify real OS host if the document size/time allows; do not
  promote any assertions about measured times.
- Verification commands:
  - `cargo test --manifest-path src/native/Cargo.toml --lib` → ordinary native
    unit suite passes.
  - `bun run check && bun run test` → all ordinary tests pass; ignored
    benchmark stays outside gate.
  - Explicit release benchmark and smoke commands above → all assertions pass,
    full metrics/steps printed. Treat incomplete trace/monitor wiring or the
    legacy zoom-wait failure as STOP and report, not as permission to change
    product behavior.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/native/src/db.rs` uses one versioned builder whose full Rust fixture is 100k nodes, 99,000 within-row edges, and 2,000 image nodes with four preview items/assets each; `clear_history()` precedes mutation timing. The persistent smoke wrapper uses the same text graph with `include_images=false` and documents its zero-batch variant, not full image parity.
- [ ] Release benchmark prints `avg/p95/max` plus node+edge rows for Fit/0.15/0.40 and preview rows/items, uses `0.25*max(request width,height)` and real bounds/camera placements.
- [ ] Public 1,000-node `set_node_bounds`/`undo()`/`redo()` samples print independently, and successful assertions confirm their geometry.
- [ ] File `Database::open` (create/connect/migrate) and `recover_runs` timings print individually plus combined with 100 intended interrupted nodes; subsequent recovery returns 0.
- [ ] All existing common/selective/CJK search metrics still print and counts are included.
- [ ] Both benchmarks remain `#[ignore]`, using only app insertion/preview/mutation/history APIs; no production DB/query/FFI changes and no timing assertions.
- [ ] `bun run test:100k` shares the text graph with `include_images=false`, emits named wall-time phase logs and trace/fps evidence, and produces screenshots; its output and docs accurately label the actual test-host profile rather than implying the release Rust benchmark profile.
- [ ] `docs/plans/rust-core.md` contains first measured full-fixture values with machine/date/build context, replacing obsolete "not printed yet"; old P0 in-memory data remains identified as such.
- [ ] `docs/testing.md` and `CHANGELOG.md` describe the full Rust image fixture, smoke's no-image edge-rich graph, trace and timing output, and explicitly separate release Rust timings from development-host smoke; no unsupported improvement claim.
- [ ] `bun run check` and `bun run test` exit 0; final single test release benchmark exits 0; `cargo fmt --manifest-path src/native/Cargo.toml -- --check` exits 0; real smoke completes on this desktop OS and both output screenshots exist. If it cannot complete, preserve work, record the failure, and use `BLOCKED` in `plans/README.md`, not `DONE`.
- [ ] No out-of-scope modified files or generated artifacts (`git status --short`), except required `plans/README.md` status row; that row is updated and formatted.
- [ ] Commit(s) use project Conventional Commits and contain no AI attribution.

## STOP conditions

Stop and report back (do not improvise) if:

- Any Current state excerpt/API changed since the planning SHA (not merely
  surrounding line numbers), especially `insert_edges` behavior, `save_run`,
  `undo/redo`, or `Database::open` semantics.
- A correct common enriched fixture cannot fit `db.rs` within the 500-code-line
  enforced cap, or insists on a production/public DB helper or dependency;
  do not silently expand scope into a native architecture refactor.
- You need `connect_edges` rather than `insert_edges` to make indexes correct:
  that would duplicate inputs and create a different fixture. Report the
  observed indexing discrepancy and stop rather than selecting blindly.
- Reopening while old scoped `Database` handles remain alive gives a timing
  not representative of an actual fresh connection, or recovery does not
  return exactly the expected outstanding count. Do not relabel it.
- The smoke script cannot import modules dynamically or reach the page's
  private `Document` through `app`; these are confirmed probe limitations at
  pinned NSH. Do not invent host calls, new app-only instrumentation, or
  import-time file writes to bypass them. Trace plus phase wall-time is the
  intended smoke evidence; keep direct scene roundtrips in the Rust benchmark.
- If instrumentation or connection to the real host cannot work with the
  existing supported test API, report blocked manual evidence rather than
  claiming a different host profile; never fabricate output for the table.
- Current smoke's `5%` Fit rounded from ~4.51% and a single keyboard `+`
  likely produces 7% via rounded zoom-percent actions. Existing script waits
  for 6%, so it may time out on this dense grid before the extra traces.
  If encountered, reproduce the zoom logging (`console.log` label texts near
  `Fit` or calculated via zoom factors) and **report blocked**; do not change
  user-visible behavior or silently rewrite this acceptance to 7%. Because
  this plan's source scope cannot change the test zoom rule, no host timing
  assertion should make that a pass/fail budget.
- Building the fixture exhausts disk/memory or reveals asset dedup/metadata
  corruption. Do not down-sample below 100k, 99,000, 2,000 images, or four
  items/assets to make a successful but weaker baseline without reporting
  the plan deviation and blocking DONE.
- The reference desktop host cannot execute (unsupported OS, no window host,
  stale generated `.nsh/rust` or absent NSH pin). Keep checks that pass and
  mark manual evidence blocked, never fabricate output for the table.
- A repeated identical scene returns a different row count; stop to determine
  whether concurrent mutation/reused DB polluted the test before publishing
  timings as baseline.
- A step's verification fails twice after a reasonable fix attempt or a
  necessary out-of-scope file emerges; the closest safe alternative needs
  advisor review.

## Maintenance notes

- **Advisor-spec deviations from source probes**: literal right-neighbor
  connectors are within each 100-column row: 99,000 total, not ~100,000
  chaining across rows. Cross-row edges would dominate low-zoom reads and
  misrepresent locality. A common builder receives `include_images`: the
  smoke deliberately uses no-image text nodes, while the Rust benchmark
  uses 2,000 image nodes/four-item batches because data-URL image mounts are
  a distinct cost that can mask graph-UI measurements. Still collect full
  image `previews` data in Rust and explicitly report the smoke image gap,
  not claim 2,000 image cards mounted. Generic release-host selection or
  dynamic native import is not part of the smoke at pinned NSH. Reuse its
  supported trace/fps and timing output, and retain the original 6% zoom
  assertion as a STOP if it fails instead of tuning the product behavior.
  This reasoning was checked at `1956ebb`; repeat drift checks if APIs change.
- Future plans optimizing scene caps, viewport fetch width, commit write
  fanout, search ranking, preview query shape, or startup scans should quote
  **before/after numbers on this exact fixture version** and print both row
  shapes and avg/p95. Avoid comparing to the old in-memory fixture without
  an explicit qualification.
- This is a diagnostic benchmark, intentionally synchronous and direct
  within Rust. It does not measure TSX→Rust transfer, view mounting, or
  painting; those require release real-host profiling. The smoke adds phase
  wall times and host observations, but cannot turn trace core time into
  end-to-end DB latency. Do not equate the two.
- Running this file-backed benchmark generates a private temp `assets/` tree
  alongside its sqlite file and dedicated persistent smoke artifacts. Keep
  fixture revisions versioned and clean only owned paths. No user data
  belongs in either.
- `insert_edges` is deliberately used instead of automatic `connect_edges`
  for the synthetic neighbor graph, because user-created edge connections
  also snapshot result inputs. If fixture intent changes to simulate that
  behavior too, name the new version and document input counts first.
- Preserve public undo/redo (rather than direct history internals) and
  scenario shape across subsequent optimization plans. Never bury a reduced
  workload behind identical output labels.
- Follow-ups are measurement/consumption only: no scene read cap, query
  rewrite, search-ranking rewrite, startup index change, low-zoom card-detail
  tier, or native host renderer patch is authorized by this plan.
- Per advisor spec, the Rust `db.rs` sequence is 009 → 011 → 012 → 015 → 016. Later plans may append measurements into this benchmark; keep their
  before/after rows and do not remove earlier original baseline records.
- Plan 001 landed (status DONE): use its `bun run dev:release`
  release-profile recipe and cite the `## Measuring performance` section in
  `docs/testing.md`. Its changes do not waive the actual supported
  release-host wiring and STOP condition here.
