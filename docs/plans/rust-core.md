# Rust document core plan

- **Status:** P0, P1 and P2 complete; P3 pending. The document core and its
  contract are current; the canvas this plan calls a Leafer scene is now a
  native view tree ([ADR 0004](../adr/0004-native-view-canvas.md)).
- **Date:** 2026-11-07
- **Related:** [ADR 0002](../adr/0002-rust-document-core.md),
  [ADR 0003](../adr/0003-orm-seaorm.md)

## Goal

Move Flow's document, search and persistence layer from QuickJS to a Rust
crate while keeping Leafer and the UI in TSX. The target is a desktop-only
infinite canvas with 50k–100k+ nodes, connected panels, runtime state, undo,
an asset library and fast full-text search.

The migration must keep the existing canvas usable at every step. P0 is a
spike and does not rewrite the UI.

## Non-goals

- No web or mobile target.
- No Rust rewrite of Leafer, its editor, camera or hit testing.
- No remote database or search service in the first version.
- No multi-user collaboration in the first version.
- No custom search engine; SQLite FTS5 is the search engine.
- No async runtime or second database driver. SeaORM Sync is the only ORM.

## Target architecture

```text
App.tsx / TSX / QuickJS
  ├─ pages/FlowPage.tsx
  ├─ leafer/*                     scene, editor, camera, NSH canvas adapter
  └─ @flow/native                 generated Rust boundary
       └─ src/native (Rust)
            ├─ Document            commands, revisions, undo/redo
            ├─ db                  worker handle, startup, WAL
            ├─ SeaORM + SeaQuery   entities, dynamic filters, transactions
            ├─ SQLite              WAL, schema_migrations
            ├─ FTS5                full-text search
            ├─ RTree               viewport queries
            └─ assets              content-addressed files and metadata
```

Rules:

- SQLite belongs to Rust. TSX never opens the database or writes SQL.
- Leafer remains the scene graph and editor. Rust returns node summaries and
  change sets; TSX maps them to Leafer objects.
- Calls across the boundary are coarse-grained and batch-oriented. No
  per-node or per-frame FFI calls.
- Rust is the source of truth. The TSX store keeps only view state (tool,
  zoom label, selection count, transient drag state).

## Repository layout

```text
src/
  App.tsx
  nsh.json                         "rust": "native"
  native/
    Cargo.toml
    Cargo.lock
    src/
      lib.rs                       #[native_module("@flow/native")]
      types.rs                     shared JsObject/PropEnum types
      db.rs                        worker handle, pragmas, startup
      entity/                      SeaORM entities, one file per table
      schema.rs                    table creation and virtual-table DDL
      mutation.rs                  transactional commands and undo payloads
      viewport.rs                  RTree viewport reads
      search.rs                    FTS5 search and short-query fallback
      history.rs                   reversible command operations
      assets.rs                    planned: content-addressed files and metadata
```

Use the specifier `@flow/native` rather than `flow/native` to avoid colliding
with the existing `src/flow/` foundation directory. The mixed app keeps
`App.tsx` as its entry; do not add a Rust `"root"` component for this design.

The crate depends on `nsh-core` 0.4.0, `sea-orm-sync` 2.0.4 with SeaQuery 1.0
(MIT/Apache-2.0), `rusqlite` 0.38 with bundled SQLite (MIT; SQLite itself is
public domain) and `serde_json` 1.0 (MIT/Apache-2.0). `sea-orm-sync`'s
`rusqlite` feature selects the sync driver; the direct `rusqlite` dependency
enables the bundled SQLite build with FTS5 and RTree.
`src/native/Cargo.lock` is committed; new runtime crates need an ADR and a
license/maintenance review.

## Data model

One SQLite database per app, with `document_id` columns for future multiple
canvases. Asset metadata is global. The database lives under NSH's app data
directory; P0 confirms how the Rust side receives that path from the host.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nodes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  z REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  from_port TEXT,
  to_port TEXT,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE node_assets (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (node_id, asset_id, role)
);

CREATE VIRTUAL TABLE nodes_rtree USING rtree(
  id, min_x, max_x, min_y, max_y
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  title,
  body,
  tags,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE assets_fts USING fts5(
  id UNINDEXED,
  name,
  tags,
  tokenize = 'trigram'
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX nodes_document ON nodes(document_id);
CREATE INDEX nodes_kind ON nodes(document_id, kind);
CREATE INDEX edges_from ON edges(from_id);
CREATE INDEX edges_to ON edges(to_id);
CREATE INDEX node_assets_asset ON node_assets(asset_id);
```

Implementation notes:

- `nodes.seq` is the internal integer key. `nodes_rtree.id` and the FTS5
  `rowid` both point at it; `nodes.id` remains the stable public identifier.
- `nodes_fts` and `assets_fts` are regular FTS5 tables keyed by the source
  row's rowid. Every write updates the FTS row in the same transaction as the
  source row; no separate index file or rebuild step.
- FTS5 `trigram` handles CJK substrings; queries shorter than three characters
  need a `LIKE` fallback with a limit, or a later bigram table if measurements
  show it is needed. Do not implement a custom tokenizer in the first version.
- Asset files are content-addressed under the app data directory; SQLite
  stores metadata only. `assets_fts` is keyed by `assets.rowid`.
- Schema changes use the `schema_migrations` table and ordered SeaORM schema
  steps. Back up the database before a destructive migration.
- The ORM owns ordinary tables. FTS5/RTree virtual-table DDL, `MATCH`,
  `snippet()`, `bm25()` and the escaped `LIKE` fallback are the only
  handwritten SQL, isolated in `schema.rs` and `search.rs`.
- One dedicated database worker owns the single SeaORM connection and receives
  typed jobs from NSH's blocking pool. SeaORM's sync Rusqlite connection is not
  `Send`, and a single writer is the correct SQLite model anyway.

## Rust API boundary

Export a `Document` class and the data types TSX needs. All database work is
async from TSX's point of view:

```rust
#[class]
pub struct Document { /* database handle + undo history */ }

#[class]
impl Document {
    pub async fn open(path: String) -> Result<Document, String>;
    pub async fn insert_nodes(
        this: Instance<Document>,
        nodes: Vec<NodeInput>,
    ) -> Result<ChangeSet, String>;
    pub async fn move_nodes(
        this: Instance<Document>,
        ids: Vec<String>,
        dx: f64,
        dy: f64,
    ) -> Result<ChangeSet, String>;
    pub async fn set_node_text(
        this: Instance<Document>,
        id: String,
        title: String,
        body: String,
        tags: Vec<String>,
    ) -> Result<ChangeSet, String>;
    pub async fn delete_nodes(
        this: Instance<Document>,
        ids: Vec<String>,
    ) -> Result<ChangeSet, String>;
    pub async fn viewport(
        this: Instance<Document>,
        rect: Viewport,
        margin: f64,
    ) -> Result<Vec<NodeSummary>, String>;
    pub async fn search(
        this: Instance<Document>,
        query: String,
        filters: SearchFilters,
        limit: u32,
    ) -> Result<Vec<SearchHit>, String>;
    pub async fn count(this: Instance<Document>) -> Result<u32, String>;
    pub async fn undo(this: Instance<Document>) -> Result<ChangeSet, String>;
    pub async fn redo(this: Instance<Document>) -> Result<ChangeSet, String>;
}
```

`Command`, `SearchFilters`, `NodeSummary`, `ChangeSet`, `SearchHit` and
`Viewport` cross the boundary as generated `JsObject`/`PropEnum` types. Keep
them small and stable; put node-specific properties in `data_json`, not in a
new FFI field for every node type. P0 exposes the explicit methods above; a
single `apply(commands)` entry point can wrap them in P1 when the UI needs a
transactional command batch.

The database handle moves each query or transaction to NSH's blocking pool
with `blocking`; a dedicated worker thread owns the single connection. The
engine thread never runs SQLite, and the worker serializes the single-user
workload. The current measurements do not justify a read-only pool: viewport
reads stay below a millisecond and no lock contention has appeared. If a
future read path blocks writes, add a small pool of read-only connections
(`r2d2_sqlite`) rather than sharing the writer.

Revision protocol:

- Every mutation increments `documents.updated_at` and the affected node
  `rev`.
- `ChangeSet` carries the new revision and only the changed/removed ids plus
  summaries needed by the scene.
- TSX caches node summaries by id and applies change sets; it does not reload
  the whole viewport after every edit.

## Commands and undo

A command is one user action, not one pointer event:

- `add_nodes`, `delete_nodes`, `move_nodes`, `resize_nodes`, `set_node_text`,
  `set_node_data`, `add_edge`, `delete_edge`, `set_asset_ref`.
- A drag produces one `move_nodes` command on pointer-up. A text edit is
  debounced and produces one command. Selection, camera movement and hover
  are not commands.
- Each command executes in one SQLite transaction and updates `nodes`,
  `edges`, `nodes_rtree`, `nodes_fts` and any asset links atomically.
- Undo/redo uses an in-memory command stack of the last 200 actions for the
  first version. Redo is cleared on a new command. Persisted undo across
  restarts is a later decision, not a P1 requirement.
- A large multi-node command is still one transaction; if it exceeds a
  measured time budget, split it only at a command boundary and keep the
  document consistent.

Autosave is the transaction commit. WAL makes each commit durable enough for
desktop use without serializing the whole document. Use `synchronous=NORMAL`;
on clean shutdown checkpoint the WAL. Text edits may be debounced; structural
commands commit immediately.

## Search

Use SQLite FTS5 as the only full-text engine:

- `nodes_fts(title, body, tags)` with `tokenize='trigram'`.
- Query with parameter binding and a sanitized FTS5 expression; never
  concatenate user input into SQL.
- Rank with `bm25(nodes_fts, 8.0, 2.0, 1.0)` so title matches outrank body
  matches.
- Apply type, tag, document and status filters in SQL before/alongside the
  FTS query; tags are normalized in a join table if they need exact matching.
- Return a short snippet and node id; TSX fetches the node summary and pans to
  it.
- For 1–2 character CJK queries, use a bounded `LIKE` fallback. If that is too
  slow in P0, add a bigram side table; do not replace FTS5 with a JS index.
- Search across documents is a `document_id` filter on the same index.

## Viewport and Leafer scene

Leafer must not instantiate all nodes:

- Query `nodes_rtree` for the visible rectangle plus a margin.
- TSX keeps a `Map<nodeId, LeaferNode>`; add, update and remove only the
  difference between viewport results.
- Query viewport at a throttled rate (for example every 50–100 ms during
  pan/zoom), not once per animation frame. Leafer can move existing nodes
  between queries.
- Fetch edges for visible nodes, or edges whose bounding box intersects the
  viewport; render only those.
- Keep selected nodes alive even when they leave the viewport so the editor
  box remains valid.
- At low zoom, render simplified clusters or a capped number of nodes. Rust
  cannot make 100k Leafer nodes viable.
- Do not create or destroy thousands of Leafer objects in one JS call. Batch
  scene changes across frames and watch the 2 second call budget.

## Assets

- Import copies a file to `assets/<sha256>` (or reuses an existing hash) and
  writes an `assets` row.
- Store images, audio and 3D models as files; SQLite stores metadata and
  node/asset links only.
- Generate and cache thumbnails outside the canvas path; never decode a large
  asset on every scene update.
- Use Rust's filesystem APIs; the TSX `fs` 8 MiB write cap does not apply to
  native Rust code.
- P1 must verify how a runtime asset file is displayed through NSH `Image` /
  Leafer (`file://`, Blob, or a host URL). Do not assume `asset:` works for
  files created after packaging.
- Failed imports and orphaned files are cleaned by a later maintenance task;
  deleting an asset row must not delete a file still referenced by another
  row with the same hash.

## Performance targets for P0

Measure release builds on the three desktop targets; treat these as targets,
not promises:

| Operation                                | Target                 |
| ---------------------------------------- | ---------------------- |
| Open a migrated database with 100k nodes | under 300 ms           |
| Viewport RTree query, p95                | under 20 ms            |
| Selective FTS5 search, p95               | under 50 ms            |
| Common-term FTS5 search, p95             | under 250 ms           |
| Apply a 1,000-node move command          | under 50 ms            |
| Undo the same command                    | under 50 ms            |
| Any TSX→Rust call                        | under 2 s, with no OOM |

If a target is missed, record the measured number and adjust the design before
starting P1. A fast database with an unvirtualized Leafer scene still fails.

### P0 measured results

Measured on Windows in a release build, with an in-memory, node-only 100k-node
database (no connectors or images) and 1000-node insert transactions. The
numbers are from the ORM-refactored code; the raw-SQL P0 spike was similar for
inserts and slightly faster for viewport reads.

| Operation                                          | Measured                                    |
| -------------------------------------------------- | ------------------------------------------- |
| Insert 100k nodes, including RTree and trigram FTS | ~2.9 s                                      |
| Common-term search (`generator`), 20 hits          | ~101 ms first, ~105 ms average, ~109 ms p95 |
| Selective search (`Node 99999`)                    | ~7.5 ms                                     |
| Short CJK search (`图片`, 2 chars; LIKE fallback)  | ~22 ms                                      |
| CJK trigram search (`生成器`)                      | ~29 ms                                      |
| Viewport query, 90 visible nodes                   | ~0.23 ms average, ~0.43 ms p95              |
| `scene()` for the same viewport (nodes + edges)    | ~0.6 ms                                     |
| `bounds()` for Fit over 100k nodes                 | ~17 ms                                      |
| TSX smoke test through `@flow/native`              | about 7 ms per test call                    |

The CJK numbers are from the P2 benchmark (half the fixture bodies are Chinese,
so both return the 20-result limit). Timings vary with machine load: another
P2 run measured ~230 ms average / ~268 ms p95 for the common-term search and
4.0–4.3 s for the build, just above the 250 ms p95 target, while the idle run
above is well inside it.

Both index reads depend on a deliberate `CROSS JOIN`: it keeps FTS5 or RTree
as the outer table. With a plain `INNER JOIN`, SQLite scanned the document
index and re-ran the FTS match per node; a 10k-node search took 26 seconds
instead of 10 milliseconds. Keep the `CROSS JOIN` and its regression test.

The 100k build, viewport, scene and bounds reads are within their targets.
Common-term search sits at roughly 210–270 ms p95 and therefore sometimes
crosses the 250 ms target; it is debounced, and selective and CJK queries are
well inside it. The file-backed `100k-grid-edges-images-v1` table below prints
open/migrate, 1,000-node commit/undo/redo, scene, preview and recovery timings;
the ordinary reopen test still covers persistence and schema creation with a
small document.

### Full fixture: `100k-grid-edges-images-v1`

Measured 2026-11-11 on branch `advisor/009-bench-coverage` at `59d5b6e`
(base `6ea781f`), with NSH pinned at `f0b4659`, using:

```sh
cargo test --manifest-path src/native/Cargo.toml --release \
  db::tests::hundred_thousand_nodes_benchmark -- --ignored --nocapture --test-threads=1
```

- **Machine**: Windows 11 Pro 10.0.26300 (x64), Intel Core i7-14650HX
  (16 cores / 24 logical, 2.2 GHz base), 32 GiB RAM. No other repository
  build or test ran during the run.
- **Profile and storage**: `cargo test --release` (optimized Rust, no LTO
  flags of its own), a file-backed SQLite database in the OS temp directory
  with WAL and an `assets/` tree beside it. The database was just seeded and
  the page cache had seen it, so reopen is a warm-file reopen, not a cold OS
  start.
- **Fixture**: 100,000 nodes in the 100x1,000 grid; 99,000 right-neighbor
  edges (99 per row, none across rows); 2,000 image nodes (`i % 50 == 0`)
  each with one four-item image batch, 8,000 image items and 2,000
  content-addressed 2x2 PNG assets. Recovery samples add 100 transient
  running batches on row-end text nodes; those batches are not part of the
  seed counts.
- **Seeding** (open, 100 node batches, 100 edge batches, 2,000 asset
  imports and 2,000 image batches): 58.8 s. This is fixture construction,
  not a target.
- **Fit**: `camera.fit` computes raw 0.007031 from the document bounds
  (21,980 x 139,944) and clamps it to the 0.05 minimum. Scene requests use
  the centered camera, the 48-point Fit padding, and the viewport
  controller's `max(width, height) * 0.25` margin.
- Scene rows are native read rows before the UI's card cap (2,000 is the
  hard node read limit). Edges include connectors touching returned cards
  and connectors whose curve crosses the request.
- Timings cover only the direct synchronous Rust database method. They do
  not include TSX-to-Rust transfer, view mounting, image decoding or
  painting; use the real-host recipe under "Measuring performance" in
  `docs/testing.md` for those.
- Every scene, preview and search scenario runs one warmup outside its five
  timed samples; the common-term search uses 20 samples. Each move cycle
  reads its starting geometry and resets with `set_node_bounds` outside the
  move, undo and redo spans, so only the three public calls are timed.

| Scenario                      | Request / scale                                            | Rows                                      |                avg |         p95 |         max |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------- | -----------------: | ----------: | ----------: |
| `bounds()` (Fit source)       | whole document                                             | 100,000 nodes                             |           84.95 ms |           — |           — |
| legacy `viewport()` reference | (0,0,1920,1080), margin 120                                | 90 nodes                                  |            0.56 ms |     0.85 ms |     0.85 ms |
| legacy `scene()` reference    | (0,0,1920,1080), margin 120                                | 90 nodes + 90 edges                       |           24.79 ms |    26.23 ms |    26.23 ms |
| `scene()` Fit                 | scale 0.0500, rect (-9170,58212,40320,23520), margin 10080 | 2,000 nodes + 30,888 edges                |        2,466.10 ms | 2,519.83 ms | 2,519.83 ms |
| `scene()`                     | scale 0.15, rect (4270,66052,13440,7840), margin 3360      | 2,000 nodes + 9,672 edges                 |          699.60 ms |   730.71 ms |   730.71 ms |
| `scene()`                     | scale 0.40, rect (8470,68502,5040,2940), margin 1260       | 1,440 nodes + 1,480 edges                 |           50.05 ms |    51.95 ms |    51.95 ms |
| `previews()`                  | 2,000 image ids                                            | 2,000 previews, 8,000 items, 2,000 assets |          261.97 ms |   332.72 ms |   332.72 ms |
| `setNodeBounds moved=1000`    | 1,000 contiguous nodes, 3 cycles                           | 1,000 changed                             |          607.83 ms |   666.61 ms |   666.61 ms |
| `undo()`                      | same command, 3 cycles                                     | 1,000 changed                             |          504.66 ms |   549.03 ms |   549.03 ms |
| `redo()`                      | same command, 3 cycles                                     | 1,000 changed                             |          515.83 ms |   534.61 ms |   534.61 ms |
| `open()` + migration          | two opens of the seeded file                               | 100,000 nodes + 99,000 edges              | 160.54 / 126.04 ms |           — |           — |
| `recover_runs()`              | 100 running row-end nodes                                  | 100 recovered; second call 0              |  94.09 / 103.21 ms |           — |           — |
| `open()` + recover            | same two iterations                                        | 100 recovered                             | 254.62 / 229.25 ms |           — |           — |
| search `generator`            | common term, 20 hits                                       | 20 samples                                |          239.59 ms |   265.59 ms |   275.37 ms |
| search `Node 99999`           | selective, 1 hit                                           | 5 samples                                 |           12.54 ms |    12.83 ms |    12.83 ms |
| search `图片`                 | short CJK, 20 hits                                         | 5 samples                                 |           41.24 ms |    42.20 ms |    42.20 ms |
| search `生成器`               | CJK trigram, 20 hits                                       | 5 samples                                 |           51.49 ms |    54.94 ms |    54.94 ms |

These are local manual measurements and SHOULD targets, not CI thresholds;
the benchmark asserts counts and output validity, never elapsed time. Follow-up
read, write, preview or startup work should compare its before/after numbers on
this exact fixture version (or name a new version) and report the row shapes,
rather than mixing them with the older in-memory node-only table.

### Scene read card budget (plan 011)

Measured 2026-11-11 on branch `advisor/011-scene-read-budget` from `300227c`,
release build, same machine and `100k-grid-edges-images-v1` fixture as the
table above. The lines below are copied verbatim from `bun run test:bench`
(`cargo test --release`, ignored benchmark). The canvas keeps 300 cards below
0.15 zoom, 800 below 0.40 and 2,000 otherwise; these reads predate passing
that budget to Rust, so the 300- and 800-card cases still returned 2,000 rows.

**before 011** (the existing single-statement read; no per-read card budget):

```text
legacy viewport scale=1.0000 (reference; edges and images present): n=5 avg=0.57ms p95=0.81ms max=0.81ms rect=(0.0,0.0,1920.0,1080.0) margin=120.0 nodes=90
legacy scene scale=1.0000 (reference; edges and images present): n=5 avg=24.53ms p95=25.65ms max=25.65ms scale=1.0000 rect=(0.0,0.0,1920.0,1080.0) margin=120.0 nodes=90 edges=90
scene fit=0.0500: n=5 avg=2472.65ms p95=2516.38ms max=2516.38ms scale=0.0500 rect=(-9170.0,58212.0,40320.0,23520.0) margin=10080.0 nodes=2000 edges=30888
scene scale=0.15: n=5 avg=702.79ms p95=728.40ms max=728.40ms scale=0.1500 rect=(4270.0,66052.0,13440.0,7840.0) margin=3360.0 nodes=2000 edges=9672
scene scale=0.40: n=5 avg=49.41ms p95=51.26ms max=51.26ms scale=0.4000 rect=(8470.0,68502.0,5040.0,2940.0) margin=1260.0 nodes=1440 edges=1480
```

**after 011** (per-read card budget, two-phase node read, capped reads skip
the crossing-connector index, port-only far lookup):

```text
legacy viewport scale=1.0000 (reference; edges and images present): n=5 avg=0.59ms p95=0.69ms max=0.69ms rect=(0.0,0.0,1920.0,1080.0) margin=120.0 nodes=90
legacy scene scale=1.0000 (reference; edges and images present): n=5 avg=23.90ms p95=24.64ms max=24.64ms scale=1.0000 rect=(0.0,0.0,1920.0,1080.0) margin=120.0 nodes=90 edges=90
scene fit=0.0500: n=5 avg=77.87ms p95=80.17ms max=80.17ms scale=0.0500 rect=(-9170.0,58212.0,40320.0,23520.0) margin=10080.0 nodes=300 edges=595
scene scale=0.15: n=5 avg=152.73ms p95=189.68ms max=189.68ms scale=0.1500 rect=(4270.0,66052.0,13440.0,7840.0) margin=3360.0 nodes=800 edges=1600
scene scale=0.40: n=5 avg=51.84ms p95=53.79ms max=53.79ms scale=0.4000 rect=(8470.0,68502.0,5040.0,2940.0) margin=1260.0 nodes=1440 edges=1480
```

The Fit and 0.15 reads now stop at the same card budget the canvas keeps
(300 and 800) and, because they reach it, skip the edge RTree half: the Fit
snapshot drops from 2,000 nodes + 30,888 edges to 300 + 595, and from
2,472.65 ms to 77.87 ms. At 0.40 the 2,000-card budget is larger than the
1,440 in-rect cards, so the read stays uncapped and keeps the RTree half and
1,480 connectors; its time is unchanged within run noise. The legacy 90-node
read is also uncapped, so its shape is unchanged.

The two-phase split was kept on a paired node-only comparison from the same
benchmark run (same worker and budget, five alternating samples): Fit
17.78 ms two-phase vs 19.24 ms single statement, 0.15 11.43 ms vs 12.99 ms,
0.40 9.00 ms vs 7.45 ms, and the 90-row legacy read 0.64 ms vs 0.51 ms. The
narrow sorter pays when the candidate set is large and the budget binds; the
second `IN` query costs about 1.5 ms when it does not.

### Gesture commit SQL (plan 012)

Measured 2026-11-11 on branch `advisor/012-gesture-commit-sql` from `498f81e`,
release build, same machine and `100k-grid-edges-images-v1` fixture as the
table above. The lines below are copied verbatim from `bun run test:bench`
(`cargo test --release`, ignored benchmark).

**before 012** (per-card UPDATE + re-SELECT; each card syncs its own incident
connectors, so a connector whose two ends both moved is boxed twice):

```text
setNodeBounds moved=1000: n=3 avg=514.29ms p95=553.23ms max=553.23ms nodes=1000 samples=3
undo moved=1000: n=3 avg=498.78ms p95=515.48ms max=515.48ms nodes=1000 samples=3
redo moved=1000: n=3 avg=531.06ms p95=554.38ms max=554.38ms nodes=1000 samples=3
```

## Phases

### P0 — mixed scaffold and storage spike (done)

- Add `src/native/` Cargo crate and `nsh.json` `"rust": "native"`.
- Export a minimal `Document` with open, insert, viewport, search, delete,
  undo and redo.
- Add schema initialization and `schema_migrations` versioning.
- Replace the P0 raw SQL with SeaORM entities and SeaQuery; keep only the FTS5
  and RTree virtual-table adapter as static SQLite SQL.
- Move database work to NSH's blocking pool; one dedicated worker thread owns
  the SeaORM connection.
- Add 100k synthetic nodes and Chinese/English search fixtures.
- Add Rust tests and one TSX smoke test through `nsh test`.
- Do not change the existing Flow scene or UI.

Gate: `cargo test`, `nsh test`, `bun run check`, the benchmark report and a
manual `nsh run src` smoke test. P0 fails if the mixed build or the FFI
boundary is not workable.

### P1 — document and viewport integration (done)

- Open `flow.db` under `process.dataDir` when the host has one; headless tests
  use `:memory:`. The Rust URL adapter percent-encodes paths, so a macOS
  "Application Support" directory works. An explicit
  `host.params.databasePath` or the declared `FLOW_DB_PATH` environment
  variable overrides the data directory; `bun run dev` uses it to keep
  development data in `.nsh/dev/flow.db`.
- Seed `flow/data.ts` into an empty document; every later scene read comes
  from SQLite.
- Replace the static `buildScene` with `flow/scene.ts`'s `FlowScene`: cards
  are added, updated and removed from the viewport snapshot only. Selected
  cards survive leaving the viewport, and low zoom caps the card budget
  (300 below 0.15 scale, 800 below 0.4, else 2000).
- Throttle viewport reads to 80 ms during pan/zoom; Leafer moves existing
  cards between reads.
- Order viewport reads with nodes inside `rect` before margin-only nodes, so
  prefetch cannot consume the card budget, and sample capped low-zoom reads
  by a deterministic hash of the internal sequence instead of insertion
  order, so one row-clustered strip does not fill the viewport.
- Route drag, resize, add, delete and connect through `setNodeBounds`,
  `insertNodes`, `deleteNodes` and `insertEdges`; one FFI command per gesture.
  Deleting a node records its connected edges so undo restores them.
- Wire `mod+z`/`mod+shift+z`/`mod+y`, `N`, `L`, Delete/Backspace and keep the
  existing camera, selection, tool and Escape behavior.
- Add `scene(rect, margin)` and `bounds()` so the UI reads a viewport and Fit
  reads the whole document in one call each.

Gate: existing canvas tests pass and the Rust 100k benchmark covers viewport,
scene and bounds reads. The real-host 100k UI pass is `bun run test:100k`,
which pans, zooms, searches, reveals the last node and fits the document
against a seeded database. At the Fit scale (~5%) Leafer culls cards only a
few pixels tall, so that screenshot is blank; the smoke captures the 6%
overview, where the sampled cards render. A minimum-size or cluster
representation at very low zoom remains open.

### P2 — search UI (done)

- Add the command palette / search panel: `mod+k` or the Search button opens
  it; typing is debounced (120 ms) and calls `Document.search` with the
  selected type filter. Results show the title, an FTS/LIKE snippet and the
  card kind; `↑`/`↓` move the selection and Enter opens it.
- `Document.getNode(id)` fetches the node behind a hit. Opening a result fits
  the camera to that card, reads the new viewport, and selects the card, so
  the edit box is valid whether the node was on screen or not.
- The palette is mounted only while open, so its arrow bindings disappear with
  it and the canvas keeps its arrow-pan shortcuts. Escape closes the palette
  before it clears the canvas selection.
- Type filters are wired to `SearchFilters.kind` (`All`, `Panels`); more kinds
  and tag filters can reuse the same row when the data model needs them.
- Rust tests cover title, body and tag matches, the 1–2 character CJK fallback,
  the trigram path, kind filtering and `getNode`; the benchmark now also
  reports short CJK and CJK trigram searches. UI tests cover opening by
  shortcut or button, filtering, clicking and Enter, and Escape.

Gate: `bun run check`, `bun run test`, `bun run test:bench`, plus a real
Windows-host screenshot of the palette and its results. P2 is done.

### P3 — assets

- File import, content hashing, deduplication and metadata.
- Asset library browsing; node asset references.
- Thumbnail generation and cleanup.
- Verify display of runtime files through NSH and Leafer.

### P4 — hardening and release

- Backup/restore, migration rollback story, integrity check on startup.
- Persisted undo decision, if product requires it.
- Packaging for macOS, Windows and Linux; install and launch tests.
- Update `docs/architecture.md`, `CLAUDE.md`, `docs/testing.md` and the ADR
  status to Accepted.
- Remove web/mobile assumptions from testing and packaging where they no
  longer apply.

## Testing and tooling

- Rust unit tests use `:memory:` databases; the reopen, path-with-spaces and
  benchmark-seed tests use real files. Every test gets a fresh database.
- There is no full migration-from-old-schema test yet; `check_legacy_schema`
  runs on every open and a test proves it rejects a pre-`seq` database even
  when the old database recorded migration 1.
- Search fixtures include English, Chinese and mixed text; they assert the
  1–2 character LIKE fallback, per-term matching for mixed short/long queries,
  the trigram path, kind filters and a zero limit.
- Mutation tests cover insert, move, bounds, text and its FTS update, delete
  with edges, undo, redo and index restoration. Nested transactions and
  1,000-node batches still lack Rust tests.
- `flow/scene.test.ts` covers viewport diffing, the low-zoom card cap,
  selected-card pinning, change-set card creation, pinned connectors and
  transform-free commits; `App.test.tsx` covers add, delete (through search),
  selection, panning, zooming and the search palette.
- The 100k benchmark is an ignored Rust test; `bun run test:bench` runs it and
  reports build, viewport, scene, bounds, selective/common/CJK search timings.
  It does not print open, commit or undo timings. `bun run test:100k` seeds 100k
  nodes and drives the real desktop host through pan, zoom, search, reveal and
  Fit, saving screenshots under `.nsh/bench/` for manual review.
- TSX integration tests use `nsh test` with the Rust registry; `cargo test`
  covers the native side. `nsh test` runs both the Rust unit tests and the TSX
  tests. `bun run test:host` runs each test file in its own host process and
  skips `native.test.ts`, because the host cannot load `@flow/native` before
  an app registers it; native tests are headless-only.
- `bun run check` now includes `cargo fmt --check` and
  `cargo clippy --all-targets -- -D warnings` through `check:rust`.
- CI runs the desktop matrix only: Windows, macOS and Linux. No web/mobile
  jobs.

## Risks and mitigations

| Risk                                          | Mitigation                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Rust build/toolchain complexity               | P0 builds the mixed app on all three desktop targets; document C++/SDK prerequisites; CI matrix.                              |
| FFI overhead or accidental blocking           | Worker thread, bulk APIs, revision change sets, no per-frame calls; measure p95.                                              |
| FTS5 trigram index size and CJK short queries | Benchmark index size; use bounded LIKE fallback; add bigram table only if measured.                                           |
| Leafer still cannot show 100k nodes           | Virtualization, selection pinning and a card cap are in; very low zoom still culls tiny cards (cluster/minimum-size pending). |
| Asset display path                            | Verify `Image`/Leafer runtime file URLs in P1 before building the library UI.                                                 |
| SQLite writer contention                      | One dedicated writer thread and WAL; add a read-only pool only if a measured read path blocks writes.                         |
| Undo memory growth                            | Cap in-memory history; store inverse commands, not snapshots.                                                                 |
| Schema/data loss                              | Migrations with backups, WAL checkpoint, integrity check, export path.                                                        |
| Mixed API changes in NSH 0.x                  | Pin the `nsh` CLI version in the repo; keep the Rust boundary small.                                                          |
| Silent index drift                            | FTS and RTree updates are in the same transaction as node writes; tests cover undo and delete.                                |

## Open questions

- One database for all documents or one file per document; start with one file
  and `document_id`, split only if backup/export requirements demand it.
- Whether very low zoom should draw a minimum-size card, a cluster summary or
  a density texture. Leafer currently culls cards only a few pixels tall, so
  the fitted 100k view is blank until the user zooms in slightly.
- Whether undo must survive process restarts; if yes, persist a bounded
  command log in P4.
- Whether search should span all documents or only the open canvas.
- Which filters the palette needs once image, text and asset nodes exist; the
  current UI exposes the kind filter that the backend already supports.
- The runtime asset URL strategy for locally imported files.
- Whether low-zoom aggregation needs a separate cluster table or can be
  computed from viewport summaries.
- Whether one writer connection is enough under real editing/search load.
- SQLite's RTree stores 32-bit floats while nodes use f64. Very large
  infinite-canvas coordinates will round; decide on a scaled/integer index or
  another spatial scheme before coordinates approach that precision limit.
- `node_assets` links are cascaded away with a deleted node but are not part of
  the undo payload. Capture and restore them when P3 adds asset mutations.
- The Leafer adapter rasterizes a layer whose compositing must stay inside it
  as one SVG image; that path needs an NSH host whose canvas draws SVG (see
  [../nsh.md](../nsh.md)). Images referenced by `asset:`/file/URL inside such
  a layer are not embedded yet, and a layer containing patterned strokes or
  text rasterizes whole: keep those out of very large layers.
- Seeding writes nodes and edges in two transactions. A crash between them
  leaves a partial demo that is not reseeded because the document is non-empty.
- Database failures currently reach only `console.error`; surface an error
  state to the user before release.

## Rollback

P0, P1 and P2 are implemented. Rolling back to the TSX-only scene is a git
revert of the native crate, `FlowScene` and the search palette; there is no
shipped user data format to preserve yet. Once packaged data exists, a rollback must export or migrate
`flow.db` first.
