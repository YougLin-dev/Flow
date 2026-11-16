# Flow first-release database design

> **Status: direction approved; the v1 core and the Phase 6 Rust split are implemented.** Owner: `@YougLin-dev`. Written 2026-11-15 from a read-only assessment and revised the same day after the owner confirmed the project model: one project is one self-contained package, with a project layer above it. The frozen v1 DDL and the open guard live in `src/native/src/schema/v1.{rs,sql}`, and the live document path opens, writes and reads v1: the entities, the trigger-maintained indexes, the batch/input state machines, the transactional seed and the TSX run/seed surface are switched. The read path, maintenance, project layer and the code-organization Phase 6 splits are complete. Because Flow has not shipped and every current row is test data, **no migration compatibility is required pre-release**: the five development migrations are replaced by one frozen v1 schema, and existing development databases are reset rather than migrated. The remaining database follow-ups are catalog invalidation/watch policy, backup/restore, zipped-package import and open-project rename (§8.7). Section 12 records the v1 decisions.

## 1. Goals and non-goals

### Goals

1. **One project per self-contained package.** A project is a directory containing one SQLite database (all structured data, FTS/RTree and project metadata) and a content-addressed `assets/` directory. The schema has one singleton `document` row, no `documents` collection and no `document_id` column. A second project is a second package, with its own backups, lock and asset bytes. The project layer above the core manages packages; project data lives only inside them.
2. **One writer, one transaction per command.** One `flow-db` worker thread owns one connection. Every command, including all index maintenance, runs in one transaction. `BEGIN IMMEDIATE` is used for write commands where the driver permits it; a per-project lock prevents two processes from opening the same package.
3. **Integrity by construction.** Enumerated statuses, origins, kinds and geometry are CHECK-constrained; JSON columns are `json_valid`; every real reference is a foreign key; FTS5 and RTree maintenance is performed by triggers in the same transaction, except the one deliberately batched connector-box path described in section 6.
4. **Meet the 100k budget.** 100,000 nodes and 99,000 edges; no whole-document scan on an interactive read; incident-edge work bounded by incident edges; previews bounded by four rows per visible batch; deterministic card sampling; O(1) document counts and bounds.
5. **Undo and redo remain trustworthy.** Undo is in-memory, bounded, and run-aware: it never rolls a later provider run's output/status/body back over a later run. Derived indexes and revisions are rebuilt or advanced, never restored to stale snapshots.
6. **A safe project identity and a repeatable reset.** `PRAGMA application_id`, `PRAGMA user_version` and the `document.project_id` identify a package before any DDL. A non-Flow SQLite file is refused, never dropped. A project is reset by deleting its package (database, WAL/SHM, assets) and reseeding; the project layer deletes a whole package rather than a row.
7. **One documented lifecycle for nodes, runs, batches, items, inputs and assets**, including retention and garbage collection, so storage cannot grow without bound.
8. **A project layer above the core.** A rebuildable catalog over project packages manages create/open/switch/rename/delete/duplicate/import. It owns no project data and never becomes a second source of truth.

### Non-goals

- Multi-document support inside one file. Multiple projects are multiple packages managed by the project layer; putting them in one database remains a v2 schema (project scope on every table, partitioned RTree/FTS, per-project recovery), not an ambiguous v1.
- Cross-project content search. Each package owns its FTS index; the project layer may search project titles, but a cross-project content index is a separate feature.
- Migration compatibility with the current v5 development schema, `schema_migrations` history, or destructive in-place migrations.
- Durable undo across process restarts (release 1 clears history at open; the schema supports a future persisted stack).
- Multi-user concurrency, remote sync, encryption at rest, or cloud backup.
- An asset-library search (the dead `assets_fts` table is removed).
- A read-only connection pool or per-node/per-frame FFI. The single worker and coarse calls stay.

## 2. Current-state assessment summary

### 2.1 What exists today

The core is a single SQLite file opened on one `flow-db` worker thread with one SeaORM `DatabaseConnection` and one transaction per command (`E:/code/mine/oflow/src/native/src/db.rs:357-394`). WAL, `busy_timeout=5000`, `cache_size=-64000` and `synchronous=NORMAL` are set for files (`db.rs:538-546`); `PRAGMA foreign_keys=ON` comes from SeaORM's rusqlite connector, not from application code. There are 9 ordinary tables (`documents`, `nodes`, `edges`, `assets`, `node_assets`, `result_batches`, `result_items`, `node_inputs`, `schema_migrations`) and 4 virtual tables (`nodes_rtree`, `nodes_fts`, `edges_rtree`, `assets_fts`). The bench fixture at `E:/code/mine/oflow/src/native/.nsh/bench/flow-100k-typed.db` has 100,000 nodes, 99,000 edges and 84.7 MB. `schema_migrations` records versions 1-5, and migrations 2 and 5 are destructive resets (`schema.rs:19,33-46,64-116,118-201`). The file has `user_version=0` and no `application_id`.

`node_assets` and `assets_fts` are dead production surface (`entity/mod.rs:9-13`; only schema and cascade tests touch `node_assets`). `assets_fts` indexes a `tags` column that `assets` never had, and no code writes or queries it.

### 2.2 Findings that drive the design

| Finding                                                                | Evidence                                                                                                                                           | Consequence                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A destructive reset can run against a non-Flow SQLite file             | `schema.rs:33-46,64-89,118-186,334-357`; `db.rs:499-516`; bench DB `application_id=0`, `user_version=0`                                            | A foreign database containing tables named `nodes`/`edges`/`assets` can lose data. The design refuses unknown files before DDL.                                                                                                         |
| Migration history is neither frozen nor gap-safe                       | `schema.rs:19,64-90,82-87,92-116,203-213`; `constants.rs:6`                                                                                        | Historical migrations change meaning with entity edits; a missing row reruns destructive migration 2. v1 is one frozen script and `user_version` is contiguous.                                                                         |
| Incident-edge reads scan every edge in the document                    | `scene.rs:158-170`; `mutation.rs:109-116,150-159`; `schema.rs:246-275`; EXPLAIN returns `SEARCH edges USING INDEX edges_port_pair (document_id=?)` | Work is proportional to the document's edge count, not incident edges; a 1,000-node delete approaches 100M row visits at 99k edges. The design uses a MULTI-INDEX OR bounded by incident edges.                                         |
| FTS/RTree maintenance is manual and can drift                          | `mutation.rs:1461-1490,1630-1702,2044-2085`; `edge_index.rs:90-221,276-317`; no `CREATE TRIGGER` in `src/native/src`                               | Any missed write path silently desynchronizes search or the canvas; a direct entity delete leaves orphan index rows. The design uses triggers, except the batched edge-box flush.                                                       |
| `edges_rtree` is keyed by the implicit `edges.rowid`                   | `edge_index.rs:74-75,236-270`; `entity/edges.rs:5-18`                                                                                              | VACUUM/rebuild can renumber rowids and silently invalidate connector boxes. The design gives edges a stable `seq INTEGER PRIMARY KEY`.                                                                                                  |
| Reference integrity is incomplete                                      | `entity/node_inputs.rs:16-18`; `entity/result_items.rs:15`; `entity/nodes.rs:27-28`; `entity/result_batches.rs:8-19`                               | `node_inputs.edge_id/item_id/asset_id`, `result_items.asset_id` and `nodes.output_batch_id` can dangle; a node can point at another node's batch. The design adds FKs, a composite output-pointer FK and a producer validation trigger. |
| Input positions contradict each other                                  | `docs/node-editor.md:85`; `mutation.rs:661-710,716-782,1958-1969`; `detail.rs:283-289`; `src/flow/document/session/node-session.ts:243-273`        | `sync_inputs` numbers per `(node, port)`, `reorder_inputs` numbers node-wide, uploads use a node-wide max, and reads interleave ports. The design enforces `UNIQUE(node_id, port_id, position)` and one shared two-phase writer.        |
| Whole-row `Replace` undo clobbers later runs                           | `mutation.rs:819-871,877-957,2044-2077`; `history.rs:100-143`; `docs/node-editor.md:99-104`                                                        | A manual edit's undo can restore a pre-run body/status/output pointer over a newer run. The design removes `Replace`, adds a guarded `NodeOutput` op and invalidates stale history on non-history writes.                               |
| Previews are O(all items in visible batches)                           | `detail.rs:143-233`; documented 249.70-254.55 ms                                                                                                   | A `ROW_NUMBER()` window and a grouped count materialize every item. The design stores `item_count` on the batch and does one `LIMIT 4` seek per batch.                                                                                  |
| Overview scans and sorts the whole document                            | `viewport.rs:193-250`; `scene.rs:128-144`                                                                                                          | Every node is hashed and about 800 rows sorted on each minimap read; `COUNT(*)` and `MIN/MAX` add scans. The design uses a covering sample index plus document counters and a bounds envelope.                                          |
| Common-term FTS misses the target                                      | `search.rs:55-93`; `docs/plans/rust-core.md:521`                                                                                                   | `generator` matches all 100k nodes; documented p95 is 265.59 ms against a 250 ms target. This remains a measured risk in the design.                                                                                                    |
| Search's short-term fallback is a full LIKE scan                       | `search.rs:37-45,95-136`                                                                                                                           | Any term shorter than 3 characters sends the whole query to `LIKE '%term%'`. The design routes terms independently and caps all-short queries.                                                                                          |
| Assets share one directory and are never collected                     | `asset.rs:21-35,43-54,68-97`; `src/flow/document/lifecycle/database-path.ts:22`                                                                    | Two database files in one directory share `<parent>/assets`; a reset of one can delete the other's bytes. The design scopes the directory to the database file and adds GC.                                                             |
| Seeding is four commands and fixed ids can collide with orphan batches | `src/flow/document/lifecycle/seed.ts:70-86`; `db.rs:334-338`; `entity/result_batches.rs:3-6`                                                       | A crash leaves a partial document; deleting all nodes and reopening reseeds over old batches. The design makes seeding one transaction with a `demo_seeded` guard and a node incarnation key.                                           |
| The 100k smoke is stale                                                | `scripts/smoke-100k.mjs:58-93`; `src/pages/flow/FlowPage.tsx:96-101`; `src/components/probes/CanvasProbe.tsx:9`; commit 401d297                    | It waits for percentages and a selection badge the probe-gated UI no longer renders. The design keeps the benchmark contract and updates the smoke with the schema work.                                                                |

### 2.3 Current 100k baseline

From `docs/plans/rust-core.md:508-524` and the assessments: open plus migration 126-160 ms; viewport 90 nodes 0.56/0.85 ms p95; Fit node-only 17.78 ms; legacy scene 90 nodes + 90 edges 24.79 ms; 2,000-node Fit scene 2,466 ms; previews 249.70-254.55 ms; `setNodeBounds` moved=1000 249.98 ms p95 262.21 ms; undo 219.39 ms; redo 244.65 ms; bounds 84.95 ms; common-term search 239.59 ms avg/265.59 ms p95/275.37 ms max; selective search 12.83 ms; 2-char CJK 42.20 ms; CJK trigram 54.94 ms; recovery 94-103 ms.

### 2.4 Review verdicts

Both proposals were reviewed adversarially and both returned **REVISE**. The single-document direction, frozen identity guard, external-content FTS, MULTI-INDEX OR incident edges, sample-index overview, per-batch LIMIT 4 previews and item_count were confirmed. The blockers were: the edge-box SQL did not use the port-centre geometry; undo could lose the output pointer; `node_inputs` uniqueness broke undo renumbering and the two-phase recipe used negative positions; batch/item state machines were not enforced; assets were not scoped per database; document bounds could be served stale; trigger-only edge-RTree maintenance defeated the 1,000-node move budget; `scale_edge_offsets_tx` was mistakenly included in the "remove RTree maintenance" range; and `PRAGMA quick_check` on every open cost about 0.68 s at 100k. Sections 3 and 6 resolve these explicitly.

## 3. Design selection and conflict resolution

The recommended design is the **single-document, frozen-v1, trigger-maintained** lineage of the second proposal, with the correctness grafts listed below. It is preferred because its read-path claims were independently reproduced on the 100k fixture, it removes the `documents`/`document_id` fiction rather than preserving it, it keeps the actual in-memory undo contract instead of adding a second persisted history with unresolved GC pinning, and its failures are localized (geometry formula, guards, batching) rather than foundational. The first proposal's best ideas are grafted: the node incarnation key, the guarded output history op, the per-project package scoping, the batch/item immutability guards, the batched connector-box path, and the open-time integrity/maintenance idea.

### 3.1 Explicit conflict resolutions

| Conflict                                                               | Decision                                                                                                                                                                 | Reason                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents` table with `id='default'` vs no multi-row table            | Drop `documents` and every `document_id`; use a singleton `document(id=1)` with rev, counts, bounds and project metadata inside a project package                        | Every current query hardcodes `DOCUMENT_ID='default'` (`constants.rs:2`; `db.rs:461-497`), the virtual indexes have no document column, and batches/assets have no scope. One package per project makes the real model explicit and removes a predicate from every hot query.                                                                              |
| `projects` table in the database vs a package per project              | One package per project; the project layer keeps a rebuildable catalog outside the project files                                                                         | Projects are the unit of backup, move, delete and locking. A `projects` table would force project scope into every table, index and query, and make project deletion a large transactional delete instead of a directory operation.                                                                                                                        |
| `schema_migrations` ledger vs `PRAGMA user_version`                    | `user_version` is the version; the DDL is a frozen literal; no `schema_migrations` table                                                                                 | `user_version` is one contiguous integer and cannot rerun a destructive gap; the ledger had no reader and duplicated `SCHEMA_VERSION` (`constants.rs:6` vs `schema.rs:19`).                                                                                                                                                                                |
| FTS/RTree triggers vs Rust manual writes                               | FTS5, node RTree, edge RTree on edge rows, counts and item_count are trigger-maintained; node geometry uses a dirty marker plus one set-based edge-box flush per command | Triggers remove drift from FK cascades and undo. The one exception is the node-geometry connector refresh, where a per-row trigger made a 1,000-node move 39-88 ms; the batched flush keeps the write budget and a dirty table makes a missed flush repairable.                                                                                            |
| Persisted SQLite undo vs in-memory stack                               | In-memory, bounded, run-aware; no history tables                                                                                                                         | The actual contract is process-local (`history.rs:152-158`); persisted history creates asset/batch pinning and GC problems the reviews could not resolve. The design grafts field-scoped ops, an output guard and a byte budget.                                                                                                                           |
| Edge inputs as references vs copied snapshots                          | Keep copied snapshots (`text`, `meta_json`, `asset_id`) but validate them against the producer                                                                           | The DTO displays the snapshot (`detail.rs:318-347`); reference semantics would block result-item GC and change the source-of-truth answer. A trigger proves the copy came from the edge's source node and matches the immutable item.                                                                                                                      |
| Explicit `node_ports` table vs opaque port ids                         | Opaque port ids in v1; reconcile/delete invalid edges in the settings command; defer `node_ports` beyond v1                                                              | The first proposal's `node_ports` guard blocked capacity/ordinal updates and did not cover `node_inputs`/`result_items` without more triggers. The TSX kind registry already owns the port layout (`docs/node-editor.md:36-44`); v1 avoids a half-enforced table.                                                                                          |
| Normalized `node_tags` vs a tags text column                           | `nodes.tags` is canonical newline-joined text, validated to forbid empty/leading/trailing/double newlines; no cache                                                      | No production reader read `tags_json`; external-content FTS needs a `tags` column. A single canonical column cannot drift; tag-boundary queries are deferred (section 12).                                                                                                                                                                                 |
| Maintained exact bounds vs exact index probes vs conservative envelope | Trigger-maintained **conservative envelope** plus `compactBounds` maintenance; no four bounds indexes                                                                    | Exact per-command recompute is an 84.95 ms scan; four expression indexes add four writes per geometry change and jeopardize the 50 ms move target. The envelope is never wrong in the sense of excluding content; it can be loose after deletes/inward moves and is tightened in the post-open/idle maintenance. This is stated as a contract, not hidden. |
| FTS5 `rank=bm25(...)` vs `-bm25()` in ORDER BY                         | Keep `-bm25(nodes_fts, 8.0, 2.0, 1.0)` in `ORDER BY`                                                                                                                     | The review found `rank=bm25(...)` is not a valid FTS5 CREATE option; the prior rank-first experiment was 5x slower. The common-term miss is recorded as a risk, not disguised.                                                                                                                                                                             |
| Node delete mid-run vs leaving a running batch                         | Delete cancels/settles every running batch for the node before deleting the node; late `saveRun` on a missing node is a no-op/cancel                                     | The DDL's owner trigger would otherwise reject the late batch and leave `running` stuck until recovery.                                                                                                                                                                                                                                                    |
| Fixed seed ids vs node incarnation                                     | Batches carry `node_seq`; a re-created id gets a new seq; latest-batch filters by `node_seq`; seeding is once per file                                                   | Resolves seed-id reuse and any future node-id reuse without deleting retained batches.                                                                                                                                                                                                                                                                     |

### 3.2 How the synthesis resolves the review blockers

| Review blocker                                                   | Resolution in this design                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo of manual text/upload loses output/status                   | A field-scoped `NodeOutput { node_id, batch_id, body, status }` op with an expected-current guard; `Text` handles title/tags; `Settings` handles settings; all are applied through one guarded restore.                                                         |
| A single-file canvas does not scope assets                       | Asset bytes live in `<project>/assets/` inside the project package, not in a directory shared by sibling databases; reset/GC/backup are scoped to the package.                                                                                                  |
| Result batch/item state machine not enforced                     | Batches insert `running` only; items insert only into running batches; done requires at least one item; terminal batches immutable; items are update-immutable and delete-guarded except parent-batch cascade; `item_count` is derived and consistency-checked. |
| `edge_boxes` used the card left edge instead of the output port  | The SQL view uses port centres: `f.x + f.width + 14` and `t.x - 14`, then reach clamp and 4-unit stroke padding. A SQL/Rust/TSX parity test uses `scene.edgePorts` including `PORT_CENTER_GAP`.                                                                 |
| Unique input positions break undo renumbering                    | One shared per-port writer uses a positive offset (`position + max+1`) then assigns stored positions; it is used by add, insert-restore, sync, reorder and `InputOrder`. `addInput` no longer trusts a caller position.                                         |
| Negative-position two-phase recipe is illegal                    | The recipe uses a positive offset; `CHECK(position >= 0)` remains.                                                                                                                                                                                              |
| Document bounds can be stale                                     | The contract is a conservative envelope, not an exact tight box: inserts/moves expand; deletes/inward moves set `bounds_exact=0` and never shrink below content; `compactBounds` tightens in maintenance. A test asserts every node is inside the returned box. |
| Trigger-only edge RTree maintenance defeats batched moves        | Node geometry only inserts a dirty node id; the command harness flushes all incident edge boxes in one set-based DELETE + INSERT ... SELECT from `edge_boxes`; the flush is part of the same transaction.                                                       |
| Removing `mutation.rs:2091-2135` also removed offset scaling     | `scale_edge_offsets_tx` is kept as an explicit set-based helper in the geometry command (height ratio), separate from the removed RTree writes.                                                                                                                 |
| `PRAGMA quick_check` on every open breaks the 300 ms open target | Open runs identity/schema checks only; `quick_check`, FTS integrity-check, RTree check, dirty flush and bounds compaction run in the post-open `verify()`. GC is its own open-time command before seeding (history empty), and never runs inside `verify()`.    |
| Node inputs not bound to ports                                   | Ports are opaque in v1; the settings command reconciles/removes edges whose ports no longer exist, and the producer trigger validates edge/item/node relationships. `node_ports` is deferred in v1 (section 12).                                                |
| Producer trigger did not verify the item's source                | The trigger joins `result_items -> result_batches -> nodes(src)` and requires the batch to belong to the edge's source node incarnation and the snapshot to equal the item's text/asset/meta.                                                                   |
| Asset GC vs undo references                                      | GC runs only when history is empty (open/maintenance); no session-time collection. In-memory history refs are not needed for GC because the stack is empty at that point.                                                                                       |
| `bulk_mode` is a silent desync switch                            | No persisted bulk flag. The dirty table plus the command harness flush is bounded and self-healing; `verify()` flushes leftovers.                                                                                                                               |
| `history_trim` could wipe the stack                              | No persisted history; the in-memory stack uses a 200-entry/64 MiB budget and evicts oldest entries explicitly, clearing redo on overflow.                                                                                                                       |
| `add_input` trusts caller positions                              | `addInput` assigns `max(position)+1` per port inside the transaction; the caller position is ignored/removed from the DTO.                                                                                                                                      |
| Image items may lack assets                                      | The DDL requires `asset_id` for `kind='image'` in both items and inputs; `imageResultItem` becomes `assetId: string`, and fixtures/tests are updated.                                                                                                           |
| Crossing-edge cap still sorts                                    | The crossing read drops `ORDER BY edges.id` (the caller collects into a BTreeMap) and caps with `LIMIT 4000`; determinism is by edge id in Rust if needed.                                                                                                      |
| Sample index with geometry caused move write amplification       | The index is `(sample_key, id)` only; the 400 overview rows are fetched by primary key.                                                                                                                                                                         |
| `nodes_output_batch` index was not the FK check                  | The child key index is the composite `(output_batch_id, id, seq) WHERE output_batch_id IS NOT NULL`; it matches the three-column FK.                                                                                                                            |
| `read_batch` unbounded                                           | The read takes a page bound (for example 200 items) and a `has_more` flag.                                                                                                                                                                                      |

## 4. Storage model and table catalog

### 4.1 Identity and key model

- **Caller-supplied TEXT ids** remain the UI identity for nodes, edges, batches, items and assets (`NodeInput.id`, `EdgeInput.id`, `ResultBatchInput.id`, `ResultItemInput.id`, `AssetInput.id`). They are `TEXT UNIQUE`/`PRIMARY KEY` and never change.
- **Internal 64-bit integer keys** are `seq INTEGER PRIMARY KEY AUTOINCREMENT` on `nodes`, `edges` and `result_batches`. They key the two RTrees, the FTS row, the undo restore and the newest-batch order. `AUTOINCREMENT` prevents a deleted key from aliasing a new row's index entries.
- **Node incarnation**: `result_batches.node_seq` records the `nodes.seq` that produced the batch. `nodes(output_batch_id, id, seq)` references `result_batches(id, node_id, node_seq)`, so a node can only point at a done batch of its own incarnation. A re-created node id gets a new seq and cannot inherit old batches; an undo restore re-inserts the exact seq and therefore resolves its old batches again.
- **No `document_id` anywhere.** The project package is the scope. `document.project_id` is a stable 32-character lowercase hex identity minted once from `randomblob(16)`; it identifies the project across moves and catalog rebuilds, is never a foreign key, and is re-minted when a project is copied or imported under a new identity.
- **Per-project view state** (camera x/y/zoom) lives on the singleton `document` row. It is UI state, not canvas content: it is saved on close/switch, does not bump `rev`, and is never part of undo.
- **No `node_assets` and no `assets_fts`.** The real asset references are `result_items.asset_id` and `node_inputs.asset_id`, both FK-guarded and indexed.

### 4.2 Table catalog

| Object                 | Purpose                                                                                                                                                | Key constraints                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `document`             | Singleton (`id=1`): stable `project_id`, title, camera, revision, maintained node/edge counts, conservative bounds envelope, demo/clean-shutdown flags | PK `id=1`; UNIQUE `project_id`; project_id immutable; rev monotonic trigger; counts/bounds triggers; no delete                               |
| `nodes`                | Canvas card: geometry, kinds, searchable title/body/tags, opaque data/settings JSON, run status, current output pointer, row revision                  | PK `seq`; UNIQUE `id`; composite output FK; status/output CHECKs; geometry/JSON/tags CHECKs; rev monotonic                                   |
| `edges`                | Directed output-port to input-port connection with persisted offsets                                                                                   | PK `seq`; UNIQUE `id`; FKs to both nodes; no self-edge; UNIQUE port pair; immutable id/seq; no duplicate pair on update; offset/JSON CHECKs  |
| `result_batches`       | One immutable run/manual/upload outcome; outlives its node                                                                                             | PK `seq`; UNIQUE `id`; `node_seq`; status/trigger CHECKs; owner trigger; insert-running; terminal immutability; derived item_count           |
| `result_items`         | Ordered text/image items of a batch                                                                                                                    | PK `id`; FK batch CASCADE; FK asset RESTRICT; UNIQUE `(batch_id, port_id, position)`; image implies asset; immutable                         |
| `node_inputs`          | Ordered per-port inputs: edge snapshots or local uploads                                                                                               | PK `id`; FK node CASCADE; FK edge CASCADE; FKs item/asset RESTRICT; UNIQUE `(node_id, port_id, position)`; origin shape; producer validation |
| `assets`               | Content-addressed asset metadata; bytes in `<project>/assets/<sha256>`                                                                                 | PK `id`; UNIQUE hash (64 lowercase hex); size >= 0; JSON meta                                                                                |
| `nodes_geometry_dirty` | Internal notification table: nodes whose geometry changed since the last connector flush                                                               | PK `node_id`; written by a node geometry trigger, cleared by the flush                                                                       |
| `nodes_rtree`          | RTree of node world rectangles, keyed by `nodes.seq`                                                                                                   | Virtual table; trigger-maintained                                                                                                            |
| `edges_rtree`          | RTree of connector cubic boxes, keyed by `edges.seq`                                                                                                   | Virtual table; edge triggers + node-geometry flush                                                                                           |
| `nodes_fts`            | FTS5 trigram external-content index over title/body/tags                                                                                               | Virtual table; `content='nodes'`, `content_rowid='seq'`; triggers                                                                            |
| `edge_boxes`           | View: the single SQL definition of the connector cubic box (port centres, reach clamp 60..260, 4-unit padding)                                         | Read-only view; also the Rust parity oracle                                                                                                  |

Removed objects: `documents`, `nodes.document_id`, `edges.document_id`, `schema_migrations`, `node_assets`, `assets_fts`, `nodes.tags_json`, `nodes_rtree`/`edges_rtree` implicit-rowid keys, the `nodes_output_batch`-only partial index.

### 4.3 Complete SQLite DDL (frozen v1)

The opener sets `PRAGMA foreign_keys=ON` and asserts it, sets `PRAGMA recursive_triggers=OFF`, opens a write transaction, sets `PRAGMA application_id=1179406167` and `PRAGMA user_version=1`, executes the script below, inserts the singleton `document` row with a fresh `project_id` (32 lowercase hex characters from `randomblob(16)`), and commits. The script is stored verbatim (for example `src/native/src/schema/v1.sql` via `include_str!`), never regenerated from entities.

```sql
-- Flow release schema v1, frozen. The opener sets PRAGMA application_id =
-- 1179406167 and PRAGMA user_version = 1 inside the same transaction that
-- executes this script.

CREATE TABLE document (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  project_id     TEXT    NOT NULL UNIQUE
                 CHECK (length(project_id) = 32
                        AND project_id NOT GLOB '*[^0-9a-f]*'),
  title          TEXT    NOT NULL DEFAULT 'Flow'
                 CHECK (instr(title, char(0)) = 0
                    AND length(trim(title, ' ' || char(9) || char(10) || char(13))) > 0),
  rev            INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  node_count     INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  edge_count     INTEGER NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
  demo_seeded    INTEGER NOT NULL DEFAULT 0 CHECK (demo_seeded IN (0, 1)),
  clean_shutdown INTEGER NOT NULL DEFAULT 0 CHECK (clean_shutdown IN (0, 1)),
  min_x          REAL,
  max_x          REAL,
  min_y          REAL,
  max_y          REAL,
  bounds_exact   INTEGER NOT NULL DEFAULT 1 CHECK (bounds_exact IN (0, 1)),
  camera_x       REAL    NOT NULL DEFAULT 0.0
                 CHECK (camera_x >= -1.0e308 AND camera_x <= 1.0e308),
  camera_y       REAL    NOT NULL DEFAULT 0.0
                 CHECK (camera_y >= -1.0e308 AND camera_y <= 1.0e308),
  camera_zoom    REAL    NOT NULL DEFAULT 1.0
                 CHECK (camera_zoom > 0.0 AND camera_zoom < 1.0e308),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK ((min_x IS NULL AND max_x IS NULL AND min_y IS NULL AND max_y IS NULL)
      OR (min_x <= max_x AND min_y <= max_y)),
  CHECK (node_count > 0 OR (min_x IS NULL AND max_x IS NULL
                            AND min_y IS NULL AND max_y IS NULL))
) STRICT;

CREATE TABLE assets (
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  hash       TEXT NOT NULL UNIQUE
             CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  kind       TEXT NOT NULL CHECK (length(kind) > 0),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (length(mime) > 0),
  size       INTEGER NOT NULL CHECK (size >= 0),
  meta_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE result_batches (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  node_id      TEXT NOT NULL CHECK (length(node_id) > 0),
  node_seq     INTEGER NOT NULL CHECK (node_seq > 0),
  trigger      TEXT NOT NULL CHECK (trigger IN ('run', 'manual', 'upload')),
  provider     TEXT NOT NULL DEFAULT '' CHECK (length(provider) <= 128),
  model        TEXT NOT NULL DEFAULT '' CHECK (length(model) <= 128),
  params_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  status       TEXT NOT NULL
               CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'interrupted')),
  error        TEXT CHECK (error IS NULL OR length(error) <= 16384),
  item_count   INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  UNIQUE (id, node_id, node_seq),
  CHECK ((status = 'running' AND finished_at IS NULL)
      OR (status <> 'running' AND finished_at IS NOT NULL))
) STRICT;

CREATE TABLE nodes (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  kind            TEXT NOT NULL CHECK (length(kind) > 0),
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT ''
                  CHECK (tags = '' OR (substr(tags, 1, 1) <> char(10)
                    AND substr(tags, -1, 1) <> char(10)
                    AND instr(tags, char(10) || char(10)) = 0)),
  x               REAL NOT NULL
                  CHECK (x >= -10000000.0 AND x + width <= 10000000.0),
  y               REAL NOT NULL
                  CHECK (y >= -10000000.0 AND y + height <= 10000000.0),
  width           REAL NOT NULL CHECK (width > 0.0 AND width <= 1000000.0),
  height          REAL NOT NULL CHECK (height > 0.0 AND height <= 1000000.0),
  z               REAL NOT NULL CHECK (z >= -1000000.0 AND z <= 1000000.0),
  data_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  settings_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  status          TEXT NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle', 'stale', 'running', 'done',
                                    'failed', 'cancelled', 'interrupted')),
  output_batch_id TEXT,
  rev             INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (status NOT IN ('done', 'stale') OR output_batch_id IS NOT NULL),
  CHECK (status <> 'idle' OR output_batch_id IS NULL),
  FOREIGN KEY (output_batch_id, id, seq)
    REFERENCES result_batches (id, node_id, node_seq)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE edges (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  from_id     TEXT NOT NULL CHECK (length(from_id) > 0),
  to_id       TEXT NOT NULL CHECK (length(to_id) > 0),
  from_port   TEXT NOT NULL CHECK (length(from_port) > 0),
  to_port     TEXT NOT NULL CHECK (length(to_port) > 0),
  port_kind   TEXT NOT NULL CHECK (length(port_kind) > 0),
  from_offset REAL NOT NULL CHECK (from_offset >= 0.0 AND from_offset <= 1000000.0),
  to_offset   REAL NOT NULL CHECK (to_offset >= 0.0 AND to_offset <= 1000000.0),
  kind        TEXT NOT NULL DEFAULT 'flow' CHECK (length(kind) > 0),
  data_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  CHECK (from_id <> to_id),
  FOREIGN KEY (from_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (to_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE
) STRICT;

CREATE TABLE result_items (
  id        TEXT PRIMARY KEY CHECK (length(id) > 0),
  batch_id  TEXT NOT NULL,
  position  INTEGER NOT NULL CHECK (position >= 0),
  port_id   TEXT NOT NULL CHECK (length(port_id) > 0),
  kind      TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  text      TEXT NOT NULL DEFAULT '',
  asset_id  TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  UNIQUE (batch_id, port_id, position),
  FOREIGN KEY (batch_id) REFERENCES result_batches (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (kind <> 'image' OR asset_id IS NOT NULL)
) STRICT;

CREATE TABLE node_inputs (
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  node_id    TEXT NOT NULL,
  port_id    TEXT NOT NULL CHECK (length(port_id) > 0),
  position   INTEGER NOT NULL CHECK (position >= 0),
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  origin     TEXT NOT NULL CHECK (origin IN ('edge', 'local')),
  edge_id    TEXT,
  item_id    TEXT,
  asset_id   TEXT,
  text       TEXT NOT NULL DEFAULT '',
  meta_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (node_id, port_id, position),
  FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (edge_id) REFERENCES edges (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (item_id) REFERENCES result_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((origin = 'edge' AND edge_id IS NOT NULL AND item_id IS NOT NULL)
      OR (origin = 'local' AND edge_id IS NULL AND item_id IS NULL AND asset_id IS NOT NULL)),
  CHECK (kind <> 'image' OR asset_id IS NOT NULL)
) STRICT;

CREATE TABLE nodes_geometry_dirty (node_id TEXT PRIMARY KEY) STRICT;

CREATE VIRTUAL TABLE nodes_rtree USING rtree (id, min_x, max_x, min_y, max_y);
CREATE VIRTUAL TABLE edges_rtree USING rtree (id, min_x, max_x, min_y, max_y);

CREATE VIRTUAL TABLE nodes_fts USING fts5 (
  title,
  body,
  tags,
  content = 'nodes',
  content_rowid = 'seq',
  tokenize = 'trigram'
);

-- The box of the cubic exactly as the canvas draws it: the port centres are
-- PORT_CENTER_GAP (14) outside the card edges, and EDGE_PADDING (4) covers the
-- stroke. The Rust connection_bounds oracle must mirror this definition.
CREATE VIEW edge_boxes AS
WITH ports AS (
  SELECT e.seq AS id,
         f.x + f.width + 14.0 AS from_x,
         f.y + e.from_offset AS from_y,
         t.x - 14.0 AS to_x,
         t.y + e.to_offset AS to_y,
         min(max(abs((t.x - 14.0) - (f.x + f.width + 14.0)) * 0.5
                 + abs((t.y + e.to_offset) - (f.y + e.from_offset)) * 0.15,
                 60.0), 260.0) AS reach
    FROM edges AS e
    JOIN nodes AS f ON f.id = e.from_id
    JOIN nodes AS t ON t.id = e.to_id
)
SELECT id,
       min(from_x, from_x + reach, to_x - reach, to_x) - 4.0 AS min_x,
       max(from_x, from_x + reach, to_x - reach, to_x) + 4.0 AS max_x,
       min(from_y, to_y) - 4.0 AS min_y,
       max(from_y, to_y) + 4.0 AS max_y
  FROM ports;

CREATE INDEX nodes_sample
  ON nodes (((seq % 2147483647) * 2654435761) % 2147483647, id);
CREATE INDEX nodes_running ON nodes (status) WHERE status = 'running';
CREATE INDEX nodes_output
  ON nodes (output_batch_id, id, seq) WHERE output_batch_id IS NOT NULL;

CREATE UNIQUE INDEX edges_port_pair
  ON edges (from_id, from_port, to_id, to_port);
CREATE INDEX edges_to ON edges (to_id, to_port);

CREATE INDEX result_batches_node ON result_batches (node_id, seq);
CREATE INDEX result_batches_latest ON result_batches (node_seq, seq);
CREATE INDEX result_batches_running
  ON result_batches (status) WHERE status = 'running';

CREATE INDEX result_items_asset
  ON result_items (asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX node_inputs_edge ON node_inputs (edge_id) WHERE edge_id IS NOT NULL;
CREATE INDEX node_inputs_item ON node_inputs (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX node_inputs_asset ON node_inputs (asset_id) WHERE asset_id IS NOT NULL;

CREATE TRIGGER document_no_delete BEFORE DELETE ON document
BEGIN
  SELECT RAISE(ABORT, 'the document row cannot be deleted');
END;

CREATE TRIGGER document_rev_monotonic BEFORE UPDATE OF rev ON document
WHEN NEW.rev <= OLD.rev
BEGIN
  SELECT RAISE(ABORT, 'document.rev must strictly increase');
END;

CREATE TRIGGER document_project_id_immutable BEFORE UPDATE OF project_id ON document
WHEN NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'document.project_id is immutable');
END;

CREATE TRIGGER document_no_replace BEFORE INSERT ON document
WHEN EXISTS (SELECT 1 FROM document WHERE id = NEW.id OR project_id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'document: use UPDATE, not REPLACE');
END;

CREATE TRIGGER nodes_no_replace BEFORE INSERT ON nodes
WHEN EXISTS (SELECT 1 FROM nodes WHERE id = NEW.id OR seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'nodes: use UPDATE, not REPLACE');
END;

CREATE TRIGGER nodes_identity_immutable BEFORE UPDATE OF id, seq ON nodes
WHEN NEW.id <> OLD.id OR NEW.seq <> OLD.seq
BEGIN
  SELECT RAISE(ABORT, 'nodes identity is immutable');
END;

CREATE TRIGGER edges_no_replace BEFORE INSERT ON edges
WHEN EXISTS (
  SELECT 1 FROM edges
   WHERE id = NEW.id
      OR seq = NEW.seq
      OR (from_id = NEW.from_id AND from_port = NEW.from_port
          AND to_id = NEW.to_id AND to_port = NEW.to_port)
)
BEGIN
  SELECT RAISE(ABORT, 'edges: use UPDATE, not REPLACE');
END;

CREATE TRIGGER edges_identity_immutable BEFORE UPDATE OF id, seq ON edges
WHEN NEW.id <> OLD.id OR NEW.seq <> OLD.seq
BEGIN
  SELECT RAISE(ABORT, 'edges identity is immutable');
END;

CREATE TRIGGER edges_no_duplicate_update
BEFORE UPDATE OF from_id, from_port, to_id, to_port ON edges
WHEN EXISTS (
  SELECT 1 FROM edges
   WHERE seq <> OLD.seq
     AND from_id = NEW.from_id AND from_port = NEW.from_port
     AND to_id = NEW.to_id AND to_port = NEW.to_port
)
BEGIN
  SELECT RAISE(ABORT, 'edges: duplicate port pair');
END;

CREATE TRIGGER nodes_rev_monotonic BEFORE UPDATE OF rev ON nodes
WHEN NEW.rev <= OLD.rev
BEGIN
  SELECT RAISE(ABORT, 'nodes.rev must strictly increase');
END;

CREATE TRIGGER nodes_output_done_bi BEFORE INSERT ON nodes
WHEN NEW.output_batch_id IS NOT NULL
 AND (SELECT status FROM result_batches WHERE id = NEW.output_batch_id) IS NOT 'done'
BEGIN
  SELECT RAISE(ABORT, 'the current output must be a done batch');
END;

CREATE TRIGGER nodes_output_done_bu BEFORE UPDATE OF output_batch_id ON nodes
WHEN NEW.output_batch_id IS NOT NULL
 AND (SELECT status FROM result_batches WHERE id = NEW.output_batch_id) IS NOT 'done'
BEGIN
  SELECT RAISE(ABORT, 'the current output must be a done batch');
END;

CREATE TRIGGER result_batches_owner_bi BEFORE INSERT ON result_batches
WHEN NOT EXISTS (SELECT 1 FROM nodes WHERE id = NEW.node_id AND seq = NEW.node_seq)
BEGIN
  SELECT RAISE(ABORT, 'a batch must belong to a live node incarnation');
END;

CREATE TRIGGER result_batches_insert_running BEFORE INSERT ON result_batches
WHEN NEW.status <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'a batch must be inserted running');
END;

CREATE TRIGGER result_batches_done_item BEFORE UPDATE OF status ON result_batches
WHEN NEW.status = 'done' AND NEW.item_count = 0
BEGIN
  SELECT RAISE(ABORT, 'a done batch must contain at least one item');
END;

CREATE TRIGGER result_batches_terminal_immutable BEFORE UPDATE ON result_batches
WHEN OLD.status <> 'running'
 AND (NEW.seq IS NOT OLD.seq
   OR NEW.id IS NOT OLD.id
   OR NEW.node_id IS NOT OLD.node_id
   OR NEW.node_seq IS NOT OLD.node_seq
   OR NEW.trigger IS NOT OLD.trigger
   OR NEW.provider IS NOT OLD.provider
   OR NEW.model IS NOT OLD.model
   OR NEW.params_json IS NOT OLD.params_json
   OR NEW.status IS NOT OLD.status
   OR NEW.error IS NOT OLD.error
   OR NEW.created_at IS NOT OLD.created_at
   OR NEW.finished_at IS NOT OLD.finished_at)
BEGIN
  SELECT RAISE(ABORT, 'a settled result batch is immutable');
END;

CREATE TRIGGER result_batches_running_delete BEFORE DELETE ON result_batches
WHEN OLD.status = 'running'
BEGIN
  SELECT RAISE(ABORT, 'a running batch must be settled, not deleted');
END;

CREATE TRIGGER result_batches_item_count_consistent
BEFORE UPDATE OF item_count ON result_batches
WHEN NEW.item_count IS NOT (SELECT count(*) FROM result_items WHERE batch_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'result_batches.item_count is derived from result_items');
END;

CREATE TRIGGER result_items_running_only BEFORE INSERT ON result_items
WHEN (SELECT status FROM result_batches WHERE id = NEW.batch_id) IS NOT 'running'
BEGIN
  SELECT RAISE(ABORT, 'items can only be added to a running batch');
END;

CREATE TRIGGER result_items_no_update BEFORE UPDATE ON result_items
BEGIN
  SELECT RAISE(ABORT, 'result items are immutable');
END;

CREATE TRIGGER result_items_delete_guard BEFORE DELETE ON result_items
WHEN EXISTS (SELECT 1 FROM result_batches WHERE id = OLD.batch_id)
BEGIN
  SELECT RAISE(ABORT, 'a settled result item cannot be deleted directly');
END;

CREATE TRIGGER result_items_count_ai AFTER INSERT ON result_items
BEGIN
  UPDATE result_batches SET item_count = item_count + 1 WHERE id = NEW.batch_id;
END;

CREATE TRIGGER result_items_count_ad AFTER DELETE ON result_items
BEGIN
  UPDATE result_batches SET item_count = max(item_count - 1, 0) WHERE id = OLD.batch_id;
END;

CREATE TRIGGER node_inputs_edge_shape_bi BEFORE INSERT ON node_inputs
WHEN NEW.origin = 'edge'
 AND NOT EXISTS (
   SELECT 1
     FROM edges AS e
     JOIN result_items AS ri ON ri.id = NEW.item_id
     JOIN result_batches AS b ON b.id = ri.batch_id
     JOIN nodes AS src ON src.id = e.from_id
    WHERE e.id = NEW.edge_id
      AND e.to_id = NEW.node_id
      AND e.to_port = NEW.port_id
      AND ri.port_id = e.from_port
      AND ri.kind = NEW.kind
      AND b.node_id = e.from_id
      AND b.node_seq = src.seq
      AND b.status = 'done'
      AND ri.text = NEW.text
      AND ri.asset_id IS NEW.asset_id
      AND ri.meta_json = NEW.meta_json
 )
BEGIN
  SELECT RAISE(ABORT, 'edge input does not match its source producer');
END;

CREATE TRIGGER node_inputs_edge_shape_bu
BEFORE UPDATE OF node_id, port_id, edge_id, item_id, kind, text, asset_id, meta_json
ON node_inputs
WHEN NEW.origin = 'edge'
 AND NOT EXISTS (
   SELECT 1
     FROM edges AS e
     JOIN result_items AS ri ON ri.id = NEW.item_id
     JOIN result_batches AS b ON b.id = ri.batch_id
     JOIN nodes AS src ON src.id = e.from_id
    WHERE e.id = NEW.edge_id
      AND e.to_id = NEW.node_id
      AND e.to_port = NEW.port_id
      AND ri.port_id = e.from_port
      AND ri.kind = NEW.kind
      AND b.node_id = e.from_id
      AND b.node_seq = src.seq
      AND b.status = 'done'
      AND ri.text = NEW.text
      AND ri.asset_id IS NEW.asset_id
      AND ri.meta_json = NEW.meta_json
 )
BEGIN
  SELECT RAISE(ABORT, 'edge input does not match its source producer');
END;

CREATE TRIGGER nodes_count_bounds_ai AFTER INSERT ON nodes
BEGIN
  UPDATE document
     SET node_count = node_count + 1,
         min_x = min(coalesce(min_x, NEW.x), NEW.x),
         max_x = max(coalesce(max_x, NEW.x + NEW.width), NEW.x + NEW.width),
         min_y = min(coalesce(min_y, NEW.y), NEW.y),
         max_y = max(coalesce(max_y, NEW.y + NEW.height), NEW.y + NEW.height)
   WHERE id = 1;
END;

CREATE TRIGGER nodes_count_bounds_ad AFTER DELETE ON nodes
BEGIN
  UPDATE document
     SET node_count = max(node_count - 1, 0),
         bounds_exact = CASE WHEN node_count = 1 THEN 1 ELSE 0 END,
         min_x = CASE WHEN node_count = 1 THEN NULL ELSE min_x END,
         max_x = CASE WHEN node_count = 1 THEN NULL ELSE max_x END,
         min_y = CASE WHEN node_count = 1 THEN NULL ELSE min_y END,
         max_y = CASE WHEN node_count = 1 THEN NULL ELSE max_y END
   WHERE id = 1;
END;

CREATE TRIGGER nodes_bounds_au AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  UPDATE document
     SET bounds_exact = CASE
           WHEN (OLD.x = min_x AND NEW.x > OLD.x)
             OR (OLD.x + OLD.width = max_x AND NEW.x + NEW.width < OLD.x + OLD.width)
             OR (OLD.y = min_y AND NEW.y > OLD.y)
             OR (OLD.y + OLD.height = max_y AND NEW.y + NEW.height < OLD.y + OLD.height)
           THEN 0 ELSE bounds_exact END,
         min_x = min(coalesce(min_x, NEW.x), NEW.x),
         max_x = max(coalesce(max_x, NEW.x + NEW.width), NEW.x + NEW.width),
         min_y = min(coalesce(min_y, NEW.y), NEW.y),
         max_y = max(coalesce(max_y, NEW.y + NEW.height), NEW.y + NEW.height)
   WHERE id = 1;
END;

CREATE TRIGGER edges_count_ai AFTER INSERT ON edges
BEGIN
  UPDATE document SET edge_count = edge_count + 1 WHERE id = 1;
END;

CREATE TRIGGER edges_count_ad AFTER DELETE ON edges
BEGIN
  UPDATE document SET edge_count = max(edge_count - 1, 0) WHERE id = 1;
END;

CREATE TRIGGER nodes_rtree_ai AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_rtree (id, min_x, max_x, min_y, max_y)
  VALUES (NEW.seq, NEW.x - 2.0, NEW.x + NEW.width + 2.0,
          NEW.y - 2.0, NEW.y + NEW.height + 2.0);
END;

CREATE TRIGGER nodes_rtree_au AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  UPDATE nodes_rtree
     SET min_x = NEW.x - 2.0,
         max_x = NEW.x + NEW.width + 2.0,
         min_y = NEW.y - 2.0,
         max_y = NEW.y + NEW.height + 2.0
   WHERE id = NEW.seq;
END;

CREATE TRIGGER nodes_rtree_ad AFTER DELETE ON nodes
BEGIN
  DELETE FROM nodes_rtree WHERE id = OLD.seq;
END;

CREATE TRIGGER nodes_geometry_dirty_au
AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  INSERT INTO nodes_geometry_dirty (node_id) VALUES (NEW.id)
  ON CONFLICT (node_id) DO NOTHING;
END;

CREATE TRIGGER nodes_geometry_dirty_ad AFTER DELETE ON nodes
BEGIN
  DELETE FROM nodes_geometry_dirty WHERE node_id = OLD.id;
END;

CREATE TRIGGER edges_rtree_ai AFTER INSERT ON edges
BEGIN
  INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y)
  SELECT id, min_x, max_x, min_y, max_y FROM edge_boxes WHERE id = NEW.seq;
END;

CREATE TRIGGER edges_rtree_au
AFTER UPDATE OF from_id, to_id, from_port, to_port, from_offset, to_offset ON edges
BEGIN
  DELETE FROM edges_rtree WHERE id = NEW.seq;
  INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y)
  SELECT id, min_x, max_x, min_y, max_y FROM edge_boxes WHERE id = NEW.seq;
END;

CREATE TRIGGER edges_rtree_ad AFTER DELETE ON edges
BEGIN
  DELETE FROM edges_rtree WHERE id = OLD.seq;
END;

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_fts (rowid, title, body, tags)
  VALUES (NEW.seq, NEW.title, NEW.body, NEW.tags);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes
BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body, tags)
  VALUES ('delete', OLD.seq, OLD.title, OLD.body, OLD.tags);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE OF title, body, tags ON nodes
BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body, tags)
  VALUES ('delete', OLD.seq, OLD.title, OLD.body, OLD.tags);
  INSERT INTO nodes_fts (rowid, title, body, tags)
  VALUES (NEW.seq, NEW.title, NEW.body, NEW.tags);
END;
```

The DDL above was applied and exercised read-only in a scratch SQLite 3.53.1 database: `PRAGMA integrity_check` returns `ok`, `foreign_key_check` is empty, node/edge cascades fire the RTree and FTS delete triggers with `recursive_triggers=OFF`, an explicit `seq` restore resolves the old output batch, the item delete guard permits the parent-batch cascade but blocks direct deletes, and `item_count` remains consistent. The same trigger chains were also independently checked against the bundled SQLite 3.51.1 (`libsqlite3-sys 0.36.0`; `src/native/target/debug/build/libsqlite3-sys-*/out/bindgen.rs:26`).

## 5. Indexes and query service

### 5.1 Index catalog

| Index                                                                    | SQL it serves                                                                 | Why it exists                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `nodes` PK `seq`                                                         | Phase-2 viewport `WHERE seq IN (...)`, RTree/FTS joins, undo restore          | Stable integer identity and covering PK lookups                                                                          |
| `nodes.id` UNIQUE (autoindex)                                            | `getNode`, edge/input FK checks, node lookup by public id                     | UI identity                                                                                                              |
| `nodes_sample` on `(((seq % 2147483647) * 2654435761) % 2147483647, id)` | Overview `ORDER BY sample_key,id LIMIT 400`                                   | O(400) deterministic sample without hashing/sorting 100k rows; deliberately excludes geometry so moves do not rewrite it |
| `nodes_running` partial on `status='running'`                            | Startup recovery `WHERE status='running'`                                     | Proportional to unfinished nodes                                                                                         |
| `nodes_output` partial on `(output_batch_id,id,seq)`                     | Composite output-pointer FK check and batch GC                                | SQLite does not auto-index child keys; matches the three-column FK                                                       |
| `edges_port_pair` UNIQUE `(from_id,from_port,to_id,to_port)`             | `from_id IN (...)`, duplicate-pair check, node cascade prefix                 | From-side half of incident-edge MULTI-INDEX OR; unique port pair                                                         |
| `edges_to` on `(to_id,to_port)`                                          | `to_id IN (...)`, `read_incoming GROUP BY to_port`, capacity/incident queries | To-side half; covering for incoming port counts                                                                          |
| `result_batches_node` on `(node_id,seq)`                                 | Per-node cleanup/export                                                       | Batch GC and node-scoped batch listing                                                                                   |
| `result_batches_latest` on `(node_seq,seq)`                              | `WHERE node_seq=? ORDER BY seq DESC LIMIT 1`                                  | Deterministic newest batch per node incarnation                                                                          |
| `result_batches_running` partial on `status='running'`                   | Recovery `WHERE status='running'`                                             | Proportional to unfinished runs                                                                                          |
| `result_items` UNIQUE `(batch_id,port_id,position)` (autoindex)          | Preview `WHERE batch_id=? ORDER BY port_id,position LIMIT 4`; read batch      | One seek per visible batch, no window materialization                                                                    |
| `result_items_asset` partial                                             | Asset reference check/GC                                                      | Index-bounded asset use                                                                                                  |
| `node_inputs` UNIQUE `(node_id,port_id,position)` (autoindex)            | Input read `WHERE node_id=? ORDER BY port_id,position`; max+1 per port        | Enforces per-port order and makes reorder/append O(log n)                                                                |
| `node_inputs_edge` / `_item` / `_asset` partial                          | Edge cascade, item/asset RESTRICT checks, GC                                  | Index-bounded reference checks                                                                                           |
| `assets.hash` UNIQUE (autoindex)                                         | Import dedupe                                                                 | Content-addressed lookup                                                                                                 |
| `document` PK `id=1`                                                     | Rev, counts, bounds                                                           | O(1) document metadata                                                                                                   |

No `nodes_kind` index: the only kind-filtered path is the short-term LIKE fallback, which is dominated by its text scan; the FTS path applies `kind` as a post-filter. No four `nodes_min_x`-style bounds indexes: see the bounds contract below. No redundant `edges_from`: the unique pair index has `from_id` as its leftmost prefix.

### 5.2 Query-to-index table for the 100k paths

| Path                        | SQL shape                                                                                                                                                                   | Plan / index                                                                            | 100k budget and evidence                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FTS search                  | `FROM nodes_fts CROSS JOIN nodes ON nodes_fts.rowid=nodes.seq WHERE nodes_fts MATCH ? [AND kind=?] ORDER BY -bm25(nodes_fts,8,2,1) DESC, nodes.id ASC LIMIT <=200`          | FTS5 virtual scan is the outer table; `nodes` PK lookup; temp B-tree for the score sort | Selective 12.83 ms p95; common-term 265.59 ms p95 vs 250 ms target (known miss); external content removes the 9.3 MB content copy.                               |
| Short-term search           | All terms < 3 chars: `WHERE (title LIKE ? OR body LIKE ? OR tags LIKE ?) AND ... ORDER BY (title=query) DESC, z, id LIMIT <=200`                                            | Full scan; capped at 8 terms and 200 hits                                               | 2-char CJK 42.20 ms p95 documented; scales linearly; no index can serve a leading wildcard.                                                                      |
| Mixed search                | FTS on terms >= 3 chars, LIKE predicates as post-filters for shorter terms                                                                                                  | FTS outer + node PK                                                                     | Avoids the whole-query LIKE fallback when a selective term exists.                                                                                               |
| Viewport phase 1            | `FROM nodes_rtree CROSS JOIN nodes ON nodes_rtree.id=nodes.seq WHERE box intersects rect+margin AND exact f64 recheck ORDER BY in_view,z,sample,id LIMIT min(limit,2000)+1` | RTree outer; nodes PK; temp B-tree for the four-key order                               | Fit node-only 17.78 ms documented; 8 ms/2,001-row synthetic; the RTree match is a superset and the exact `x/y/width/height` recheck removes f32 false positives. |
| Viewport phase 2            | `SELECT columns FROM nodes WHERE seq IN (chunk of 400)`                                                                                                                     | nodes PK                                                                                | 0.85 ms/400 ids documented.                                                                                                                                      |
| Incident edges              | `WHERE from_id IN (...) OR to_id IN (...)` (no document predicate)                                                                                                          | MULTI-INDEX OR over `edges_port_pair` and `edges_to`                                    | 0.9-1.9 ms/400 ids synthetic; 3.14-3.84 ms including row fetches; the old document-prefix scan was 24.6 ms.                                                      |
| Crossing edges              | `FROM edges_rtree CROSS JOIN edges ON edges.seq=edges_rtree.id WHERE box intersects LIMIT 4000` (no SQL ORDER BY)                                                           | RTree outer; edges PK                                                                   | 8.54 ms/4,000 synthetic; the cap bounds payload, not the RTree scan; deterministic ordering is done in Rust only if a caller needs it.                           |
| Overview cards              | `SELECT id,x,y,width,height FROM nodes ORDER BY sample_key,id LIMIT 400`                                                                                                    | `nodes_sample` covering order scan + 400 PK lookups                                     | 0.4-0.67 ms synthetic, versus 5.8 ms hash+sort; no `COUNT(*)` dependency.                                                                                        |
| Bounds                      | `SELECT min_x,max_x,min_y,max_y FROM document WHERE id=1`                                                                                                                   | document PK                                                                             | O(1); the current scan is 84.95 ms. The box is a conservative envelope; `bounds_exact` is 0 after deletes/inward moves until compaction.                         |
| `compactBounds` maintenance | `SELECT min(x),max(x+width),min(y),max(y+height) FROM nodes` + document update                                                                                              | Full scan; maintenance only                                                             | One ~11-85 ms scan at 100k, run post-open/idle or explicitly; never on an interactive read.                                                                      |
| Counts                      | `SELECT node_count,edge_count FROM document`                                                                                                                                | document PK                                                                             | O(1), replaces 3.79 ms count scans.                                                                                                                              |
| Latest batch                | `SELECT ... WHERE node_seq=? ORDER BY seq DESC LIMIT 1`                                                                                                                     | `result_batches_latest`                                                                 | 0.004 ms synthetic.                                                                                                                                              |
| Previews                    | Per batch: `SELECT ... WHERE batch_id=? ORDER BY port_id,position LIMIT 4`, plus `result_batches.item_count`                                                                | `result_items` unique index; batch PK                                                   | 0.009 ms per seek; 2,000 seeks 11-20 ms; replaces the 249.70-254.55 ms window + grouped count.                                                                   |
| Inputs                      | `WHERE node_id=? ORDER BY port_id,position`                                                                                                                                 | `node_inputs` unique index prefix                                                       | One seek; no temp B-tree for the tiebreak.                                                                                                                       |
| Incoming ports              | `SELECT to_port,count(*) FROM edges WHERE to_id=? GROUP BY to_port`                                                                                                         | `edges_to` covering                                                                     | Proportional to incident edges; replaces full-row fetch + Rust counting.                                                                                         |
| Recovery                    | `WHERE status='running'` on nodes/batches                                                                                                                                   | Partial `nodes_running` / `result_batches_running`                                      | Proportional to unfinished work; 94-103 ms for 100 running fixtures before the other fixes.                                                                      |
| Node detail                 | Node by unique id, batch by PK, items by unique index, inputs by unique index, edges by PK/unique id, assets by PK                                                          | Point lookups; chunks of 400                                                            | Bounded by the node's own rows; `read_batch` gets a page bound.                                                                                                  |
| Asset GC                    | `result_items.asset_id` / `node_inputs.asset_id` probes                                                                                                                     | Partial asset indexes                                                                   | Index-bounded reference checks; no full scans.                                                                                                                   |
| Batch GC                    | Newest per incarnation, output pointer, input item references                                                                                                               | `result_batches_latest`, `nodes_output`, `node_inputs_item`                             | Index-bounded; no session-time GC.                                                                                                                               |

## 6. FTS5 and RTree maintenance

### 6.1 FTS5

`nodes_fts` is **external content**: `content='nodes'`, `content_rowid='seq'`, tokenizer `trigram`. It stores only the trigram index; `snippet()` and `bm25()` read the live `nodes` row, eliminating the 9.3 MB `nodes_fts_content` copy measured on the 100k fixture. Three triggers insert/delete/update the FTS row in the same transaction as every `nodes` insert/delete/title/body/tags update, including undo and FK cascades. The entity is read-only; no Rust code writes FTS shadow tables.

Search keeps the deliberate `FROM nodes_fts CROSS JOIN nodes` shape so FTS5 stays the outer table; a plain INNER JOIN regressed a 10k search to 26 s (`search.rs:69-73,182-189`). Terms are routed independently: terms of 3+ Unicode characters use FTS; shorter terms are applied as LIKE post-filters when at least one long term exists; an all-short query uses the capped LIKE fallback (at most 8 terms, at most 200 hits). The final order is `score DESC, nodes.id ASC` for determinism. `kind` remains a post-filter. The `-bm25(nodes_fts, 8.0, 2.0, 1.0)` expression stays in `ORDER BY`; the invalid `rank=bm25(...)` CREATE option and the rejected rank-first split are not used.

Known miss: the release fixture makes `generator` match all 100,000 nodes; documented p95 is 265.59 ms against a 250 ms target. The external-content synthetic measured 160.9 ms but is not the fixture. This design records the miss as a release risk; a read-only search connection or a bigram index is a measured follow-up, not a v1 promise, and the target is not claimed as met.

Maintenance: `INSERT INTO nodes_fts(nodes_fts) VALUES('integrity-check')` and `...VALUES('rebuild')` are exposed as `verify()`/maintenance commands and run after an unclean shutdown or restore, not on every open.

### 6.2 Node RTree

`nodes_rtree` is keyed by `nodes.seq` and maintained by AFTER INSERT/UPDATE OF x,y,width,height/DELETE triggers. The box is `(x-2, x+width+2, y-2, y+height+2)`: SQLite converts to 32-bit floats and rounds outward, so the 2-unit pad is a safety margin at the ±10,000,000 world limit; the viewport query rechecks exact f64 geometry so f32 rounding cannot add a card that does not intersect. FK cascades and undo reinserts fire the delete/insert triggers, so orphan node boxes are not possible for ordinary writes.

### 6.3 Edge RTree and the one explicit path

`edges_rtree` is keyed by the stable `edges.seq` (not the implicit rowid). Edge inserts, updates and deletes are maintained by triggers that read the single `edge_boxes` view. That view is the SQL definition of the drawn cubic: port centres are `f.x + f.width + 14` and `t.x - 14` (`PORT_CENTER_GAP` in `src/flow/canvas/geometry/connection.ts:8,76,89`; `scene.edgePorts` uses the same gap at `src/flow/canvas/model/scene/scene.ts:509-512`), reach is `clamp(abs(dx)*0.5 + abs(dy)*0.15, 60, 260)`, and 4 units cover the stroke (`EDGE_PADDING`). The earlier proposals omitted the card/port gap and one proposal used `f.x` instead of `f.x + f.width`; both are corrected here.

Node geometry changes do **not** run a per-row connector trigger. They insert the node id into `nodes_geometry_dirty` (cheap, `ON CONFLICT DO NOTHING`); every mutation command ends with one set-based flush in the same transaction:

```sql
DELETE FROM edges_rtree
 WHERE id IN (SELECT e.seq FROM edges e
               WHERE e.from_id IN (SELECT node_id FROM nodes_geometry_dirty)
                  OR e.to_id   IN (SELECT node_id FROM nodes_geometry_dirty));

INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y)
SELECT b.id, b.min_x, b.max_x, b.min_y, b.max_y
  FROM edge_boxes b
 WHERE b.id IN (SELECT e.seq FROM edges e
                 WHERE e.from_id IN (SELECT node_id FROM nodes_geometry_dirty)
                    OR e.to_id   IN (SELECT node_id FROM nodes_geometry_dirty));

DELETE FROM nodes_geometry_dirty;
```

The flush is part of the command harness (`run_command`/`apply_ops`), so every move, resize, undo and redo runs it. A connector whose both ends moved is written once, reproducing the single-pass behavior of `sync_edges_for_nodes` (`edge_index.rs:136-199`) without a per-node trigger. `verify()` flushes leftover dirty rows after a crash or a direct SQL write. Height changes also run `scale_edge_offsets_tx` as a set-based UPDATE using `NEW.height / OLD.height`; this is kept separate from the removed RTree writes. Rotating the whole world, adding/removing ports without height changes, and far-card offsets remain documented limitations (v1 decisions; section 12).

The crossing-edge read caps at 4,000 rows and drops the redundant SQL `ORDER BY`; the caller already collects into a BTreeMap. The cap bounds payload; the RTree scan still costs the number of matching boxes, which is the intended spatial semantics. Above the cap the retained subset follows the index's physical order, so a flush that re-inserts boxes can change it; the response order itself stays by edge id.

### 6.4 Cascades, REPLACE and integrity

- `PRAGMA foreign_keys=ON` is set and asserted in `configure()`; the current reliance on the driver default (`db.rs:538-546`) is removed. `PRAGMA recursive_triggers=OFF` is explicit; the trigger chains were verified with it off.
- Node deletion cascades edges and inputs; the edge AFTER DELETE triggers remove `edges_rtree` rows, the node AFTER DELETE triggers remove `nodes_rtree`/`nodes_fts` rows, and counts decrement. This was verified on the bundled 3.51.1 and 3.53.1.
- `INSERT OR REPLACE` is banned by BEFORE INSERT triggers on `document` (by id or project_id), `nodes` (by id or seq) and `edges` (by id, seq or port pair), because REPLACE skips AFTER DELETE triggers and would corrupt counts/FTS/RTree or the project identity. Node and edge `id`/`seq` are immutable, and an edge update cannot create a duplicate port pair, so `UPDATE OR REPLACE` cannot use the same bypass. The app uses plain INSERT/UPDATE; tests assert the bans.
- No trigger may be assumed to run in a particular order; tests assert rejection, not messages.
- `verify()` runs `PRAGMA quick_check`, `PRAGMA foreign_key_check`, FTS `integrity-check`/`rebuild` if needed, `rtreecheck` for both RTrees, the dirty flush and the bounds compaction. It is a maintenance command/post-open job, not part of the 300 ms open path (quick_check measured 0.682 s on the 100k/74 MB fixture).

## 7. Undo/history design

### 7.1 Model

Undo and redo remain **in-memory** in the `Database` handle, mutated only inside serialized worker jobs; `clear_history` is routed through the worker queue (fixing the current caller-thread race at `db.rs:280-285`). Each `HistoryEntry` stores `forward`/`inverse` ops plus reference sets (`nodes`, `batches`, `assets`) used for invalidation. The stack is capped at 200 entries and 64 MiB of serialized payload; overflow evicts oldest entries and clears redo. The newest entry is kept even when it alone exceeds the byte budget. A command that changes no row pushes no entry and does not bump the document revision. A panic in a job is contained so the only worker cannot die; a poisoned history lock is reported, not silently reused.

### 7.2 Operations

| Op                                         | Fields                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InsertNode`                               | Full `NodeRow` including `seq`, tags text, output pointer, rev/timestamps     | Undo of a node insert; restoring `seq` rebuilds RTree/FTS via triggers                                                                                                                                                                                                                                                                                                                                           |
| `DeleteNode`                               | Full `NodeRow` plus its ports? no ports; its nodes/inputs captured separately | Undo of delete re-inserts the exact incarnation, then edges, then inputs                                                                                                                                                                                                                                                                                                                                         |
| `NodeGeometry`                             | `id,x,y,width,height`                                                         | Applied through the geometry helper; dirty flush and offset scaling run                                                                                                                                                                                                                                                                                                                                          |
| `NodeText`                                 | `id,title,tags` (body is output-derived)                                      | Does not restore a snapshot revision/timestamp                                                                                                                                                                                                                                                                                                                                                                   |
| `NodeSettings`                             | `id,settings_json` plus any edges removed by port reconciliation              | Settings changes that delete edges record those Edge/Input deletes. Forward/redo marks an existing output stale; undo restores settings without touching the run-owned status.                                                                                                                                                                                                                                   |
| `NodeOutput`                               | `id,batch_id,body,status`                                                     | Guarded against the op's from state: undo applies only if the node still points at the batch/body the edit wrote; redo only if the node still points at the pre-edit batch/body. Status is restored but not guarded: undoable input/settings edits legitimately mark a node stale, while non-history status writes invalidate the entry through its references. A stale entry is skipped whole, never partially. |
| `InsertEdge` / `UpdateEdge` / `DeleteEdge` | Full edge row including `seq`                                                 | Restores before/after offsets and endpoints; edge triggers rebuild the box                                                                                                                                                                                                                                                                                                                                       |
| `InsertInput` / `DeleteInput`              | Full input row (snapshot semantics)                                           | Restored through the per-port position writer                                                                                                                                                                                                                                                                                                                                                                    |
| `InputOrder`                               | `node_id,port_id,ordered ids`                                                 | Restored through the shared two-phase writer                                                                                                                                                                                                                                                                                                                                                                     |

There is no whole-row `Replace`. `set_manual_text`/`set_manual_upload` record `NodeOutput` + `NodeSettings` (+ geometry for upload) instead of a full row; a later run invalidates those entries. Guard validation runs for the whole entry before any op executes; a stale entry applies nothing and is dropped from the stack rather than moved to redo. Every applied UPDATE sets `rev = current_rev + 1` and `updated_at = now`; no snapshot rev/timestamp is restored. The document rev is bumped exactly once per undo/redo.

### 7.3 Run-aware invalidation

`begin_run`, `save_run`, `set_node_status`, `sync_inputs`, `recover_runs` and asset imports are not history commands. Each non-history write to a node deletes every history entry whose reference set contains that node (and the affected batches), and clears redo. A run on a source node also invalidates entries on target nodes whose snapshots came from that source (the entry records the source node from its edge/item). A run also records every direct downstream target that currently has an output, including targets already stale, so an older output undo cannot clear the stale mark. This prevents a later undo from restoring a snapshot over a newer run. The guarded `NodeOutput` op is the second line of defense for a missed invalidation.

Input restores are idempotent when `sync_inputs` already recreated a row (`mutation.rs:1285-1315` keeps that tolerance). Edge deletes cascade their inputs; explicit `DeleteInput` ops tolerate a missing row. Reordering uses the per-port writer: `UPDATE ... SET position = position + (max(position)+1)` for the affected port, then assign 0..n-1. The offset is positive, so `CHECK(position >= 0)` is never violated; this applies to add, insert-restore, sync, reorder and `InputOrder`, not only `reorder_inputs`.

History memory is bounded by `byte_size` estimates (serialized payload) and the 200-entry cap. Large text bodies or uploads can evict older entries; that is explicit policy, not silent corruption.

## 8. Data lifecycle and state machines

### 8.1 Node status

Allowed transitions (enforced in one Rust module plus the DB enum/output CHECKs; the DB also enforces the output invariants):

| From                                   | To                           | Trigger                                           |
| -------------------------------------- | ---------------------------- | ------------------------------------------------- |
| insert                                 | `idle`                       | New node, no output                               |
| `idle`                                 | `running`                    | `beginRun`                                        |
| `idle`                                 | `done`                       | Manual text/upload                                |
| `running`                              | `done`                       | Successful run with >= 1 item                     |
| `running`                              | `failed` / `cancelled`       | Failed/cancelled run; previous output kept if any |
| `running`                              | `interrupted`                | Startup recovery                                  |
| `done`                                 | `running`                    | New run                                           |
| `done`                                 | `stale`                      | Settings/input/source change                      |
| `done`                                 | `done`                       | Manual text/upload replaces the output            |
| `stale`                                | `running` / `done`           | New run / manual output                           |
| `stale`                                | `stale`                      | Further input/settings changes                    |
| `failed` / `cancelled` / `interrupted` | `running` / `done` / `stale` | New run / manual output / input change            |

Invariants: `done` and `stale` require an `output_batch_id`; `idle` forbids one; `output_batch_id` always names a `done` batch of the node's current incarnation; `failed`/`cancelled` may keep a previous output. Node rev strictly increases on every write. `stale` is the UI's "Upstream updated"; a node with no output stays `idle` rather than stale.

### 8.2 Run and batch lifecycle

1. `beginRun(nodeId, trigger, provider, model, params)` in one transaction: insert a `running` batch (with `node_seq`), set node status `running`, clear redo/invalidations.
2. Provider call and asset imports happen outside the DB worker.
3. `saveRun(batchId, status, items, error)` in one transaction: insert items only while the batch is `running`, settle to `done`/`failed`/`cancelled` with `finished_at`, set `item_count`, update the node output pointer/body/status only on `done`, mark downstream stale, bump rev.
4. Crash: on open, `recover_runs` sets every `running` batch to `interrupted` and every `running` node to `interrupted` (or keeps its previous output), then bumps rev once. `recover_runs` is scoped to the singleton document by construction.
5. Node delete: cancel/settle any running batch for the node before deleting the node; a late `saveRun` for a missing node is a no-op/cancel, not a batch insert.
6. Manual text/upload: insert a `running` batch, insert items, settle `done`, set pointer/body/status; one transaction and one history entry.

Batch invariants: inserted only `running`; `done` requires `item_count >= 1`; terminal batches are immutable; `item_count` is derived and consistency-checked; a running batch cannot be deleted; a batch delete is allowed only when no output pointer and no input item reference holds it (FK RESTRICT). `result_batches.node_id` deliberately has no FK so batches outlive nodes, but the owner trigger requires a live node incarnation at insert time.

### 8.3 Items and inputs

- Items: only inserted into running batches; update-immutable; delete only by parent-batch cascade; position unique per `(batch, port)`; `kind` text/image; image requires an asset; `item_count` maintained by triggers. Previews read four per batch by `(port_id, position)`.
- Inputs: snapshots are copied from an immutable done item of the edge's source node incarnation; a trigger proves the source join and exact snapshot equality. Local inputs are asset-backed uploads. Positions are dense per `(node, port)` after reorder/sync; gaps are allowed after removal. The settings command deletes incident edges (and therefore their inputs) when a port disappears, recording them for undo.

### 8.4 Assets

Bytes are content-addressed under `<project>/assets/<sha256>` inside the project package. The path is derived from the package root (the database file's parent directory), not from the database file name, so renaming the project (which changes only `document.title`) or moving the package never breaks an asset. Import: hash bytes, look up `assets.hash`; on hit return the existing row (first-writer-wins) and ensure the file exists; on miss write a temp file, rename to the final hash, insert the metadata row (the file-first order can leave an orphan file, never a row without bytes), return it. `size`/hash are checked. Asset GC runs only when the undo stack is empty: delete rows not referenced by `result_items.asset_id` or `node_inputs.asset_id`, then sweep files with no row. `assets_fts` is removed; asset search is not in v1.

### 8.5 Deletion, cascade and GC matrix

| Operation           | Effects                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delete node         | Cancel running batches first; delete node row; FK cascades edges and node inputs; edge triggers remove edge boxes; FTS/RTree/count/bounds triggers fire; batches remain terminal and unreachable |
| Delete edge         | FK cascades its `node_inputs`; `edges_rtree_ad` removes the box; history records the edge and input rows                                                                                         |
| Delete result batch | Only terminal and unreferenced; FK cascades items; `item_count` consistency holds; assets remain until GC                                                                                        |
| Delete result item  | Direct delete blocked; only parent-batch cascade                                                                                                                                                 |
| Delete asset        | Blocked while referenced by an item or input; GC only unreferenced                                                                                                                               |
| Delete document     | Blocked by trigger; reset uses DROP TABLE in the dev reset                                                                                                                                       |

GC policy at open/maintenance (never during a session): keep batches referenced by `nodes.output_batch_id`, referenced by `node_inputs.item_id`, and the newest batch per live `node_seq` (for the composer error line); delete other terminal batches and their items; then delete unreferenced assets and sweep orphan files. Running batches are absent after recovery. This is `gc()`, a separate command run once at open before seeding; it refuses while the in-memory undo history holds an entry, and it sweeps files only after the row transaction commits.

### 8.6 Seeding

`seedDocument` is one worker command in one transaction: if `demo_seeded=1`, no-op; if the document has nodes or edges, return an error and leave `demo_seeded=0` (seeding never writes over data; the frozen v1 schema has no pre-v1 packages, so a partial/legacy row state is not a supported input); otherwise insert the two fixed-id nodes, insert a `running` manual batch, insert its item, settle it `done`, set the node output pointer/status, insert the seed edge, insert the edge snapshot input, bump rev once, clear history, set `demo_seeded=1`. Deleting all nodes later does **not** reseed (behavior change; reset does).

### 8.7 Project package and the project layer

A project is a self-contained package:

```
<projects-root>/
  catalog.json               -- rebuildable cache; never the source of truth
  .locks/<project_id>.lock   -- ephemeral OS lock; never copied or unlinked
  <project_id>/
    project.db               -- the singleton document and all structured data
    assets/<sha256>          -- content-addressed asset bytes
```

The database is the only source of truth; asset bytes are the only resource stored beside it, inside the same package. Moving, backing up or deleting a project operates on the directory. Renaming changes `document.title`; the directory name is the stable `project_id`, so a rename never moves bytes or breaks an asset path.

The lock is deliberately **outside** the package. On Windows, renaming a directory fails with `PermissionDenied` while any handle inside it is open — verified on the target host — so an in-package lock could not be held across delete's rename-to-trash or duplicate/import's final rename. The lock's owner is the OS lock, not its bytes: process death releases it, so there is no stale-lock protocol, and the file is never unlinked (an unlock-then-unlink can split the inode). Its holder JSON is diagnostics only.

The project layer above the document core owns the managed projects root, the project-list UI, and the create/open/switch/rename/delete/duplicate/import flows. It keeps a **rebuildable catalog cache** (root-relative directory name, project_id, title, updated_at, last_opened_at); the cache is an index, never the source of truth. If it is lost or fails strict validation, scanning `*/project.db` and reading each `document` row rebuilds it; unreadable packages stay listed as fallback rows so they are not silently lost.

- **Create** builds the package in a temporary directory, creates the v1 database, mints `project_id`, optionally seeds demo content, then renames the directory into place. A crash leaves no half project.
- **Open** validates `application_id`, `user_version` and `project_id`, acquires the lock, runs `recover_runs`, and opens the workspace. One project is open per window; switching closes the current document first (settle/cancel running batches, save the camera, checkpoint WAL, clear history).
- **Delete** closes the project first, renames the package to a trash name, then deletes it after the UI confirmation. **Duplicate** copies the closed package and mints a new `project_id`; **import** validates identity/version and mints on collision.
- A second process opening the same project is refused by the lock; the list marks that project as open elsewhere.
- Cross-project content search is out of scope; each package's FTS is local. The project layer may search titles from its catalog.

**Implementation status (first slice).** The Rust `ProjectStore`/`ProjectLease` and the `flow/projects` TSX area are implemented. Delete (unlike rename and duplicate) does not read the document identity: a real package directory under its lock is enough, so an unreadable or mismatched fallback row stays removable. The store manages the root, catalog, package lock, create (seeded or blank), existing-only open, rename, delete, duplicate and import; every write commits through a synced temp directory and one rename, and every package-wide statement lives in `schema/package.rs` (`wal_checkpoint(TRUNCATE)`, `VACUUM INTO`, identity rekeying around the frozen trigger, `clean_shutdown`). `Document.openPackage(path, projectId)` is the managed open: it refuses a missing/empty file without creating it, compares the document identity, and only then marks the package dirty. A blank managed create records `demo_seeded=1` and the managed open passes `seedDemo: false`, so the legacy auto-seed cannot fill a project the user meant to leave empty. Rename is closed-package only (title/`updated_at`; no rev or history change). Imports accept an unpacked package directory, read it only (`VACUUM INTO` includes committed WAL frames), keep its identity when free and mint otherwise, and set `clean_shutdown=0` so the first managed open verifies. The projects screen and the managed session mount are implemented: `pages/projects` lists, creates, renames, duplicates, deletes and imports projects through the store (a fallback row offers only delete), the flow workspace leases and opens the chosen package, closes it before releasing the lease on the back control or quit, and the app starts on the list when it has a managed root (an explicit document path keeps the legacy canvas); its design, motion inventory and verification are in [projects-screen.md](projects-screen.md). Still to do: catalog invalidation/watch policy, backup/restore, zipped-package import, and open-project rename. The lock location and the `flow/projects` seam are recorded in `docs/architecture.md` and `docs/code-map.md`.

## 9. Schema versioning, reset and reseed

### 9.1 Project identity and open guard

`PRAGMA application_id = 1179406167` (`0x464C4F57`, "FLOW") and `PRAGMA user_version = 1` are set inside the creation transaction. Open reads `PRAGMA application_id`, `PRAGMA user_version` and `sqlite_master` before any DDL:

| State                                                                                                    | Action                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `application_id=0`, `user_version=0`, no user tables or views                                            | New package: create v1 in one transaction, insert the `document` row, set identity/version, commit              |
| `application_id=0`, any user table or view                                                               | Refuse with "not a Flow database"; never DROP (this catches the existing v5 dev files and foreign SQLite files) |
| matching `application_id`, `user_version` = 1                                                            | Validate the document row and return `Current`                                                                  |
| matching `application_id`, `user_version` < 1                                                            | Refuse: no earlier Flow schema exists; reset the project                                                        |
| matching `application_id`, `user_version` > 1                                                            | Refuse as newer                                                                                                 |
| matching id, missing/invalid `document` row, `project_id`, camera, required tables/view/indexes/triggers | Refuse; suggest `verify()` or a project reset/deletion                                                          |

`PRAGMA quick_check` is not on the open path. Open sets `document.clean_shutdown=0`; an explicit `close()` (or `closeWithView`, which saves the camera in the same job) checkpoints WAL, sets it to 1 and closes. A close makes queued reads skippable — they fail with "the database is closed" without touching SQLite — while commands accepted before the close request still run ahead of the close job. The recovery state starts as `!opened_clean`, the verify job stores its outcome on the worker, and the close job samples it there, so a failed verify leaves the package dirty. A verify still queued when the close is requested is skipped and leaves the package pending; a check already running aborts between its phases. On the next open, a `0` schedules the post-open `verify()` job (quick_check, FTS/RTree checks, dirty flush, bounds compaction). GC is a separate `gc()` command run once at open before seeding and never inside `verify()` or mid-session. A verify phase already in flight blocks the close job behind it; if the shell's 200 ms quit deadline expires first, the process exits with `clean_shutdown=0` and the next open verifies again. The 300 ms open budget is preserved; a normal clean open does no integrity scan.

### 9.2 Frozen migrations

- `MIGRATION_1` is the DDL in section 4.3, stored literally and included with `include_str!`; it is never generated from entities. The file should live outside `schema.rs` so the 500-code-line rule is respected.
- Every future entity/schema change appends a new frozen `MIGRATION_N` string and increments `user_version`; release migrations are forward-only and never DROP document tables. SQLite table-rebuild recipes (create new, copy, drop old, rename, recreate indexes/triggers/view) are acceptable inside a frozen migration.
- A schema-shape test opens a migrated database and asserts every entity column via `PRAGMA table_info`; an entity change without a migration fails at test time, not at runtime.
- `schema_migrations` is gone. If support later needs an audit trail, add a metadata table that is not the version source.

### 9.3 Development reset (preferred)

1. Stop the app/worker.
2. Delete or move the whole package: `<project>/` (its database, `-wal`, `-shm` and `assets/`). For the current legacy `FLOW_DB_PATH` development file, delete that file, its `-wal`/`-shm` and its existing legacy asset directory.
3. Reopen. The new binary creates v1 and the atomic seed runs.

This is required because every current v5 development database has `application_id=0`. The error message must name the package path and the legacy files. The seeder (`src/native/src/db/tests/benchmark.rs`) deletes the database, `-wal` and `-shm` before writing; the smoke deletes those files plus the package's `assets/` directory before re-seeding, and fails if the seeder wrote no database, so a filter mismatch cannot pass on a stale fixture.

### 9.4 In-app destructive reset (dev-only)

Use only when the app is already open on a valid v1 file and a file delete is inconvenient. One worker transaction:

```sql
DROP VIEW edge_boxes;
DROP TABLE nodes_fts;
DROP TABLE nodes_rtree;
DROP TABLE edges_rtree;
DROP TABLE node_inputs;
DROP TABLE result_items;
DROP TABLE edges;
DROP TABLE nodes;
DROP TABLE result_batches;
DROP TABLE assets;
DROP TABLE nodes_geometry_dirty;
DROP TABLE document;
-- execute MIGRATION_1 and insert the singleton document row
```

Before the transaction, capture `project_id` and `title`, and rename `<project>/assets` to `<project>/assets.trash-<timestamp>`; on commit delete it, on failure rename it back. The new `document` row restores the captured `project_id` and title: a reset clears content, not project identity; duplicating or importing is what mints a new id. Reset never runs against a refused file because a refused file cannot produce a `Document`. Mark the command dev-only in the FFI/UI.

Implemented as `reset()` in one worker job: it also preserves `document.created_at` (the project's own creation time), resets the camera and `demo_seeded`, clears the in-memory undo history on success, and deletes the parked asset directory best-effort after the commit. A failed transaction renames the directory back. No v1 UI calls it.

### 9.5 Reseed

After reset or when a new project is created, `seedDocument` runs as described in 8.6. `demo_seeded` is the single guard. A crash mid-seed rolls back the whole transaction; a crash after a successful seed leaves `demo_seeded=1` and no partial document.

### 9.6 Backup and restore

Close or `close()` the document, or run `PRAGMA wal_checkpoint(TRUNCATE)`. Copy the project package: the SQLite file **and** `<project>/assets/` together (the lock is ephemeral and is not copied). Verify `application_id`, `user_version`, `quick_check` and `project_id`; restore both; if the backup is older than the binary, apply frozen migrations; then run `verify()` and `compactBounds()`. Never restore a newer `user_version` into an older build.

### 9.7 Benchmark and smoke contract

Keep the exact cargo filter `db::tests::benchmark::seed_benchmark_database` and `FLOW_BENCH_DB` (`scripts/smoke-100k.mjs`); the smoke deletes the db/-wal/-shm and the package assets directory before re-seeding and fails if the seeder wrote no database (so a filter mismatch cannot pass on a stale fixture). `FIXTURE_VERSION` is `100k-grid-edges-images-v2-typed-ports`; `docs/testing.md` and `docs/plans/rust-core.md` are re-baselined to it together. The seeder inserts batches as `running`, inserts items, then settles; image items have assets. The smoke runs `src/Smoke100k.host.test.tsx`, which opens with `flowZoomProbe`/`flowSelectionProbe` and waits on `id:zoom-probe`/`id:canvas-probe` state instead of painted text or fixed sleeps; every other test run skips it on the bench-path gate.

## 10. SeaORM entity/module mapping

### 10.1 Entity and module changes

| Path                                                                                                                      | Change                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/native/src/entity/document.rs` (renamed from `documents.rs`)                                                         | Singleton model: `id i32`, `project_id String`, title, `camera_x/y/zoom f64`, rev, node_count, edge_count, demo_seeded, clean_shutdown, min/max/bounds_exact, timestamps. No has-many relations.                                                                              |
| `src/native/src/entity/nodes.rs`                                                                                          | `seq: i64`; remove `document_id`; `tags: String`; keep data/settings/status/output/rev/timestamps; no generated sample/bounds columns (they are expression indexes only).                                                                                                     |
| `src/native/src/entity/edges.rs`                                                                                          | `seq: i64` PK AUTOINCREMENT; `id: String` unique; remove `document_id`; keep endpoints/ports/offsets/kind/data; FromNode/ToNode CASCADE relations.                                                                                                                            |
| `src/native/src/entity/result_batches.rs`                                                                                 | `seq: i64` PK; id unique; node_id; node_seq i64; trigger; provider/model/params; status; `error: Option<String>`; `item_count: i64`; created/finished. No node relation by design.                                                                                            |
| `src/native/src/entity/result_items.rs`                                                                                   | `position: i64`; asset relation RESTRICT; batch CASCADE; unique `(batch_id,port_id,position)` in DDL.                                                                                                                                                                         |
| `src/native/src/entity/node_inputs.rs`                                                                                    | `position: i64`; add Edge CASCADE, ResultItem RESTRICT, Asset RESTRICT relations; per-port uniqueness and origin shape in DDL.                                                                                                                                                |
| `src/native/src/entity/assets.rs`                                                                                         | Keep model; remove node_assets relation; add has-many items/inputs.                                                                                                                                                                                                           |
| `src/native/src/entity/nodes_rtree.rs`, `edges_rtree.rs`, `nodes_fts.rs`                                                  | Map keys/rowid as `i64`; document that triggers own the rows and the entity is read-only for FTS.                                                                                                                                                                             |
| Delete `src/native/src/entity/node_assets.rs`, `assets_fts.rs`, `schema_migrations.rs`                                    | Dead production surface removed; update `entity/mod.rs` and its stale P1 comment.                                                                                                                                                                                             |
| `src/native/src/schema.rs` + `src/native/src/schema/v1.{rs,sql}`                                                          | Frozen DDL and open guard (`FileState`, `create`, `inspect`, `configure`) implemented in step 1; then `compactBounds`, `rebuildSpatialIndexes`, `rebuildFts`, `verify`, dirty flush, GC. No entity-generated release DDL, no `check_legacy_schema`.                           |
| `src/native/src/db.rs`                                                                                                    | Assert `foreign_keys=ON`, `recursive_triggers=OFF`; open guard with `project_id` validation; package lock; remove `DOCUMENT_ID` filters; counts/bounds/camera from `document`; `close()`; route `clear_history` through the worker; catch panics; add seed/verify/reset jobs. |
| `src/native/src/mutation.rs`                                                                                              | Remove `document_id` and all manual RTree/FTS writes; add the per-port position writer, batch `beginRun`/settle, port reconciliation on settings, history invalidation, set-based/chunked deletes, dirty flush in the command harness, offset scaling helper.                 |
| `src/native/src/edge_index.rs`                                                                                            | Remove `sync_*`/`backfill`/rowid lookup; keep `connection_bounds` as the Rust oracle updated to port centres + 4 padding; read joins `edges.seq`; dirty flush in SQL; cap crossing reads.                                                                                     |
| `src/native/src/viewport.rs`, `scene.rs`                                                                                  | Remove document filters; RTree-first CROSS JOIN + exact recheck; explicit truncation flag; sample-index overview; document bounds; incident-edge MULTI-INDEX OR; edge cap; no whole-document scans.                                                                           |
| `src/native/src/detail.rs`                                                                                                | Per-batch LIMIT 4 + `item_count`; latest by `node_seq, seq`; inputs by `(port_id,position)`; incoming GROUP BY; paged `read_batch`.                                                                                                                                           |
| `src/native/src/search.rs`                                                                                                | External-content FTS; independent term routing; `score DESC, id ASC`; keep `CROSS JOIN`; no document filter.                                                                                                                                                                  |
| `src/native/src/asset.rs`                                                                                                 | Project-package asset dir (`<project>/assets`); atomic import order; first-writer-wins; GC/reference checks.                                                                                                                                                                  |
| `src/native/src/history.rs`                                                                                               | Field-scoped ops + `NodeOutput` + reference sets + byte budget; no persisted history.                                                                                                                                                                                         |
| `src/native/src/types.rs`, `src/native/src/lib.rs`, `src/.nsh/types/@flow/native.d.ts`, `src/flow/shared/native-types.ts` | `error` optional; `addInput` position server-assigned; `beginRun`/`settleRun`; `seedDocument`; `projectInfo`; `saveView`; `close`; `verify`/`compactBounds`; image asset required; regenerate the TSX surface.                                                                |
| TSX callers                                                                                                               | `src/flow/execution/runner.ts` uses beginRun/settle; `node-session.ts` stops computing positions; `seed.ts` calls one seed command; `result-inputs.ts` requires image assets; smoke updates.                                                                                  |
| TSX project layer (new area; ADR 0007)                                                                                    | Project list and catalog cache; create/open/switch/rename/delete/duplicate/import; lock state; save the camera on switch; title search only, no cross-project content search.                                                                                                 |

### 10.2 Command harness

Every mutation entry point wraps one transaction:

```
run_command(f) = conn.transaction(|txn| {
  let mutation = f(txn)?;            // rows + history ops
  edge_index::flush_geometry_tx(txn)?; // dirty marker -> set-based edge boxes
  Ok(mutation)
})
```

`run_mutation` pushes history after commit, inside the same worker job; on failure the transaction rolls back and the history entry is not pushed. Undo/redo call `apply_ops` through the same harness. Non-history writes (`begin_run`, `save_run`, `set_node_status`, `sync_inputs`, `recover_runs`) invalidate history refs inside their transactions. All IN lists are chunked at <=400 parameters; multi-node deletes are set-based where possible.

### 10.3 FFI/DTO changes (deliberate, TSX-wide)

- `ResultBatchSummary.error` becomes `Option<String>` (SQLite NULL; no `''` sentinel).
- `InputItemInput.position` is removed or ignored; `addInput` assigns `max+1` per port inside the transaction.
- Provider runs use `beginRun` + `settleRun` (or a `saveRun` that settles the already-inserted running batch); `setNodeStatus('running')` is no longer the run start.
- `imageResultItem` requires `assetId: string`; tests/fixtures that pass null are updated.
- `close()`, `seedDocument()`, `verify()`, `compactBounds()` are added; `resetDocument()` is dev-only.
- `projectInfo()` exposes the stable `projectId`, title, counts and camera; `saveView(x, y, zoom)` persists the camera without bumping `rev`. Project creation, importing and deletion stay in the project layer's filesystem flow, not the document FFI.
- The generated `Document` class and `NodeSummary` field set stay otherwise stable (id, kind, title, body, x, y, width, height, z, rev, dataJson, settingsJson, status, outputBatchId).

## 11. Risks and verification plan

### 11.1 Risks

1. **Common-term search still misses the 250 ms p95 target.** The fixture matches all 100k nodes; external content and index fixes do not change bm25 scoring over 100k matches. Mitigation: keep the benchmark gate, record the measured number on the new fixture, and add a read-only search connection or bigram FTS only if the measurement shows a material win. Do not claim success from a synthetic 160.9 ms.
2. **Trigger write amplification.** 100k seed, hub-node moves, and 1,000-node geometry commands can be dominated by RTree/FTS/count/dirty triggers. The batched edge-box flush removes the worst per-node cost; measure the real fixture. If the 50 ms move target is still missed, the next lever is a set-based node RTree write in the same flush, not a persisted bulk-mode flag.
3. **Edge-box parity.** The SQL view, the Rust oracle and the TSX scene geometry must agree on port-centre gap, reach clamp and padding. A parity test over forward/backward/short/long connectors, resizes and far endpoints is mandatory; a mismatch can make connectors disappear at viewport edges.
4. **RTree f32 precision.** The world is bounded to ±10,000,000 and boxes are padded; node reads recheck exact f64 geometry. Boundary tests at ±10,000,000 and ±2^23 are required. Edge boxes may over-include; the client clips.
5. **Undo over later runs.** The invalidation rule is application code, not a schema property. If a future command forgets it, the guarded `NodeOutput` op is the fallback, but tests must cover every non-history write path.
6. **Batch lifecycle migration.** Every batch writer and the benchmark seeder must insert running, insert items, then settle. A missed writer fails the DB trigger. Inventory: `save_run`, `set_manual_text`, `set_manual_upload`, `insert_upload_node`, seed, benchmark.
7. **Node delete mid-run.** The runner must cancel/settle before deleting; a late `saveRun` must no-op/cancel. Add a host test.
8. **Position renumbering.** The unique index is immediate; the shared writer must be used by add, insert-restore, sync, reorder and `InputOrder`. Test reorder -> undo, remove -> run sync -> undo, and concurrent uploads.
9. **External-content FTS drift only if triggers are bypassed.** Keep the adapter/entities from writing shadow tables; `verify()` runs integrity-check/rebuild after unclean shutdown/restore.
10. **Application guard refuses all current dev DBs.** Intentional. Scripts, docs and error messages must name the package path (db, -wal, -shm, assets) or the legacy files.
11. **Open-time integrity checks.** `quick_check` is 0.682 s at 100k; keep it off the open path and in `verify()`/post-open.
12. **Conservative bounds can be loose.** Fit after a delete may show extra whitespace until compaction. This is a deliberate tradeoff; the exact four-index variant is rejected for v1 because it adds four writes per geometry change.
13. **Seed behavior change.** Deleting all nodes no longer reseeds; reset or a new project does.
14. **Image asset enforcement.** `imageResultItem` null callers and fixtures must change; a failed/placeholder image without bytes is no longer storable.
15. **Single-process assumption.** A lock file plus one worker; busy_timeout does not protect logical conflicts across processes.
16. **World/kind/port vocabulary.** The DB CHECKs are release vocabulary; adding a kind or port kind is a migration. The TSX kind registry remains the source of the port layout.
17. **Package path and rename.** The asset path is derived from the package root, not the database stem. The project layer must move, rename or delete the whole directory; moving only the database orphans its assets. A project rename changes only `document.title`.
18. **Duplicate identity.** Two packages with the same `project_id` in one root make the catalog ambiguous. Duplicate always mints a new identity; import keeps the source identity when its directory is free and mints on collision. A directory whose document identity disagrees with it is listed as a fallback row keyed by the directory and re-read on the next list, not reported as a duplicate.
19. **Switching with a running job.** Closing or switching must settle or cancel running batches before closing the database; a crash falls back to `recover_runs` on the next open. A late `settleRun` after close is a no-op.
20. **Catalog drift.** The project-list cache is rebuildable and may lag the filesystem; the list must tolerate missing, locked and newer-version packages without deleting anything.
21. **Camera persistence.** Camera is UI state, saved on close/switch and not part of undo; a crash loses at most the last view position.

### 11.2 Verification matrix

| Area               | Test                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DDL/identity       | Apply v1 on an empty DB; assert `application_id`, `user_version`, `document` row and `project_id`; refuse a foreign file, a v5 dev file, a newer version; `PRAGMA integrity_check`, `foreign_key_check`                                                                               |
| Project package    | Create in a temp dir and rename into place; open; read project_id/title/camera; rename title; duplicate mints a new project_id; delete moves to trash; import refuses a foreign/newer file; a second open is locked; rebuild the catalog from directories; camera survives close/open |
| Constraints        | Every CHECK/FK/trigger rejects its negative case: self-edge, duplicate port pair, bad status/origin/kind, non-JSON, negative size/position, image without asset, node without output for done, output from another node/incarnation, idle with output                                 |
| Cascades           | Delete node -> edges, inputs, RTree/FTS rows, counts; delete edge -> inputs, edge box; delete batch -> items, item_count; delete asset with references fails; delete node with connected ports? no ports table                                                                        |
| REPLACE ban        | `INSERT OR REPLACE` on document, nodes and edges aborts by id, seq/project_id or edge port pair; identity updates and duplicate-pair updates abort; counts/FTS/RTree/identity stay consistent                                                                                         |
| Batch/item machine | Insert done directly fails; item into settled batch fails; item update/delete blocked; batch cascade succeeds; running batch delete blocked; item_count consistency trigger rejects a wrong direct update                                                                             |
| Positions          | Reorder p2/p0/p1, undo, redo; insert-restore at a stored position; upload append while another insert races; sync_inputs renumber; no UNIQUE failure                                                                                                                                  |
| Geometry           | SQL `edge_boxes` vs Rust `connection_bounds` vs TSX `scene.edgePorts` for a matrix; port gap 14, reach 60/260, padding 4; ±10,000,000 and ±2^23; resize offset scaling; dirty flush after 1,000-node move                                                                             |
| Undo               | Manual text/upload undo across a later run; guarded Output skips a stale entry; a run invalidates a pending settings edit and keeps its output; node delete undo restores seq/output/edges/inputs; edge delete undo restores inputs; clear_history queued                             |
| Queries            | `EXPLAIN QUERY PLAN` assertions by shape (MULTI-INDEX OR, `SEARCH result_items USING INDEX ... (batch_id=?)`, sample index, RTree outer, PK lookups), not auto-generated index names                                                                                                  |
| 100k reads         | Bounds, overview, viewport phase 1/2, scene incident/crossing edges, previews, latest batch, inputs, incoming, recovery, search selective/common/short                                                                                                                                |
| Failure modes      | 33k+ bulk delete (chunked), 100k node delete/undo memory, history byte cap, FK pragma assertion, node delete mid-run, asset GC/undo, clean/unclean open, backup/restore                                                                                                               |
| Smoke              | Fix the 100k smoke probes; assert `id:zoom-probe`/`id:canvas-probe`; keep `search-result-${id}` testIDs                                                                                                                                                                               |

### 11.3 100k benchmark plan

Use the exact fixture contract (`db::tests::benchmark::seed_benchmark_database`, `FLOW_BENCH_DB`, counts 100k/99k, overview 400, previews 2,000/8,000/2,000, recovery 100) in a dedicated benchmark directory so `<db-parent>/assets` is not shared with another database. Reset the package: the DB, -wal, -shm and the project assets directory; bump `FIXTURE_VERSION`; re-baseline:

- open/close (target <300 ms; integrity checks outside open)
- bounds (target O(1) document read; compaction separate)
- viewport p95 (target <20 ms)
- overview (target <1 ms + 400 PK lookups)
- incident-edge chunks (target <5 ms per 400 ids)
- crossing-edge cap (target <15 ms for 4,000)
- previews (target <25 ms for 2,000 batches)
- latest batch (target <1 ms)
- search selective (<50 ms), common (<250 ms, record the miss if it remains), short CJK (<50 ms)
- 1,000-node move/undo/redo (<50 ms target; record the measured trigger/flush number)
- 100k seed time and DB size (external content removes the copied text; expect a smaller FTS footprint)
- recovery after 100 running rows
- `gc`/`compactBounds` maintenance time

The benchmark asserts counts and output validity, never elapsed time; the measured table is recorded in `docs/plans/rust-core.md` with the new fixture version.

### 11.4 Gate

Run `bun run check` (format, lint, type check, Rust format/clippy, boundary rules), `bun run test` (Rust unit + TSX), `bun run test:host` and `bun run test:bench`. File names and dependency direction are lint rules; keep the frozen SQL in its own file and the modules under 500 code lines.

## 12. Decisions

The owner confirmed the project model on 2026-11-15 and delegated the remaining choices as "one step, best solution". These are v1 decisions, not open questions.

1. **Project model.** A project is one self-contained package (database + assets), and the project layer manages packages. There is no multi-document database and no `projects` table inside a project file; cross-project content search is out of scope.
2. **Common-term FTS.** Implement the query/index fixes and measure on the new fixture. If p95 remains above 250 ms, record the number and ship with the documented limitation; add a read-only search connection or bigram FTS only if measurement shows a material win. A synthetic result is not evidence.
3. **Ports.** Opaque port ids plus command validation and settings reconciliation; no `node_ports` table in v1. It is revisited only if port-level queries or DB-level capacity become a product requirement.
4. **Tags.** Canonical newline-joined `nodes.tags`; no `node_tags` table. Exact tag-membership queries are a post-v1 feature.
5. **Bounds.** A conservative envelope with `bounds_exact`; `compactBounds` tightens it in maintenance. Fit may include whitespace after deletes; exactness is not a v1 contract.
6. **Images.** Every image item and image input references an asset. Failed or placeholder images are not persisted.
7. **Inputs.** Copied snapshots with the producer-validation trigger; no reference-only inputs in v1.
8. **Undo.** In-memory, bounded and run-aware; cleared at open/close. No persisted history.
9. **Seeding.** A new project may seed demo content once (`demo_seeded`). An existing empty project does not auto-reseed; reset or a new project does.
10. **Asset metadata.** First-writer-wins; no merge command in v1.
11. **Read path.** One writer and no read pool; asset bytes stay on the asset path. Revisit only with benchmark evidence.
12. **Reset exposure.** `resetDocument` is dev-only. The user-facing destructive action is deleting a project in the project layer.
13. **World cap.** ±10,000,000 is the release contract; RTree padding and exact recheck handle f32 precision.
14. **Vocabulary.** DB CHECKs are release vocabulary; changing kinds, port kinds, providers or statuses is a migration plus an app update. The TSX kind registry owns the port layout.
15. **Retention.** Keep the current output, input-referenced batches and the newest batch per incarnation; GC runs at open/maintenance when history is empty.
16. **Clean shutdown.** The TSX lifecycle calls `close()` on switch and quit; a crash falls back to the post-open `verify()`, whose cost is accepted.
17. **Far-card offsets.** Accept the drift until the card is visible; no port-layout command in v1.
18. **Status transitions.** Enforce in the Rust mutation module plus CHECKs; no transition trigger table.
19. **Project catalog.** A rebuildable cache over package directories; no authoritative central database. Cache loss is repaired by scanning.
20. **Project switching.** One open project per window; switching closes the current document. Multi-window later means one worker per project; the schema is unchanged.
21. **Project identity.** `project_id` is minted once and immutable; duplicate/import mints a new id; the directory name is the id and the display name is `document.title`.

## 13. Approval and implementation order

This is a **proposal whose direction is approved; the v1 core swap is implemented**. It deliberately breaks compatibility with the previous test-only development database: the development reset deletes the old database and its asset directory, while a project reset deletes the whole package, then reseeds. No production data exists, so no migration path is required before the first release.

Implementation order:

1. Frozen v1 DDL including `project_id` and camera, the identity/open guard, and schema-shape tests.
2. Entities and the command harness.
3. Batch/item/input state machines and history.
4. Trigger-maintained FTS/RTree/bounds/counts and the geometry flush.
5. Read-path query rewrites and the 100k benchmark.
6. Reset/seed/GC/verify, `projectInfo`/`saveView`, and the TSX surface changes.
7. The project layer as a separate workstream: package layout and lock, catalog cache, create/open/switch/rename/delete/duplicate/import, and the project-list UI. It is not part of the code-organization Phase 6/7 refactor; it consumes the document core's open/close lifecycle.

Steps 1–2 and the v1 write/read surface are implemented on `feat/database-v1`, including the review fixes: the geometry flush and minimap sample follow the frozen index shapes (with `EXPLAIN QUERY PLAN` tests), a deleted node's running batch is cancelled and late settles are no-ops, the composer's latest batch is scoped to the node incarnation, a no-op seed leaves history alone, and `close()` checkpoints the WAL and releases the file before acknowledging. The lifecycle unit is also implemented: the pre-open flag is reported as `projectInfo.openedClean`, an unclean open schedules `verify()` after the first scene read, `verify()` checks and rebuilds FTS parity, both RTrees, leftover dirty connectors and exact bounds, and quit settles running batches, saves the camera and closes the package (with the camera restored on open). Its review made close priority explicit (queued reads are skipped, commands accepted before the close still run), tracked the recovery state on the worker so a failed verify or a quit before verify keeps the package dirty across a later clean close, and aborted verify between phases when a close is pending. The read-path step is also complete: the viewport prefilter rechecks exact f64 geometry and reports truncation from one row past its budget, the crossing-edge half is capped at 4,000 without a sorting `ORDER BY`, and mixed search routes long terms to FTS with short terms as `LIKE` post-filters (all-short queries cap at eight terms). `gc()` is implemented as its own open-time command with the undo-history guard and the post-commit file sweep, and the dev-only `reset()` recreates the frozen schema while keeping the project identity and parking the asset directory. The project layer's first slice is implemented too: the Rust store/lease, package lock, catalog, create/open/rename/delete/duplicate/import and the thin `flow/projects` seam (section 8.7); its projects screen (list/create/rename/duplicate/delete/import), managed session mount and default startup switch are implemented; catalog invalidation policy and backup/restore remain. The smoke re-baseline is complete. Each step is a small, revertible PR with tests and the full gate; the 100k benchmark runs after the index/query steps and before the project layer is declared ready.
