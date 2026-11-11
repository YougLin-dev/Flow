# Plan 015: Rank search hits before computing snippets

> **Executor instructions**: Follow this step by step. Run every verification
> command and confirm the expected result before moving to the next step. If
> anything in the "STOP conditions" occurs, stop and report — do not
> improvise. When done, update this plan's row in `plans/README.md` unless a
> reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/native/src/search.rs src/native/src/db.rs docs/plans/rust-core.md CHANGELOG.md plans/README.md`
> `plans/README.md` exists and is advisor-maintained; a parallel executor does
> not edit the index, while a standalone executor updates only this plan's
> status row at completion.
> This plan depends on `plans/009-bench-coverage.md`. Its benchmark and
> `docs/plans/rust-core.md` changes are expected; plan 011/012 may add further
> `db.rs` changes because of the shared execution order. Confirm 009's row is
> DONE in the index, compare only the search excerpts this plan edits, and
> treat any unexplained mismatch as STOP. Keep the new benchmark extension
> independent of the fixture added by 009. Its selected-file benchmark changes
> are all local to db.rs. Never hand-edit generated FFI types.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/009-bench-coverage.md`
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Rejected at**: commit `69a1146`, 2026-11-11 — the 100k paired benchmark
  disproved the premise. The existing single statement already defers
  `snippet()` to the rows the sorter returns; the two-stage path re-runs the
  FTS5 match for each retained rowid and measured 5.0x slower (reference
  avg 270.25 / p95 293.04 ms vs rank-first avg 1361.41 / p95 1462.85 ms;
  an independent reviewer re-run measured 279.22 / 304.80 vs 1399.23 /
  1495.67 ms). Production code, tests and benchmark were reverted; only a
  rejected-experiment note in `docs/plans/rust-core.md` was kept and merged
  as the docs-only commit `b8ee38a`. The implementation branch
  `advisor/015-search-rank-first` (`abaa03e`, `983de0a`, `b9e9239`,
  `cfdaca2`) was deleted after the note landed.

> **Outcome (2026-11-11): REJECTED.** Do not execute the steps below as a
> performance change. The equivalence contract passed, but the new path is
> slower; the measurement and phase diagnosis are recorded in
> `docs/plans/rust-core.md` under "Rejected: rank-first common-term search".
> A future attempt must not re-run `MATCH` per retained rowid, and must
> re-measure the existing statement's snippet deferral first.

## Why this matters

The common 100k-node query `generator` measured ~105 ms average / ~109 ms p95
in one release run and ~230/~268 ms in another (`docs/plans/rust-core.md:386`
and 397–399). Today SQLite asks `snippet()` to read and tokenize the full node
body for every match before the sorter retains only 20 hits. Replace that
unbounded expensive work with no more than `limit` snippet evaluations. The
public hit object, ordering, kind filtering, weights, and short-query fallback
must remain exactly equivalent on the same unchanged database.

## Current state

At `src/native/src/search.rs:15-22`, `SearchHitRow` is the row model for both
FTS and fallback searches. `search()` (lines 24-53) trims the query, rejects
empty/zero limit, caps limit at 200, routes any term shorter than three
characters to LIKE, then delegates at lines 47-52 to `fts_statement`:

```rust
// src/native/src/search.rs:55-68, 74-93 (at 1956ebb)
pub(crate) fn fts_statement(match_query: &str, kind: Option<&str>, limit: u64) -> SelectStatement {
    let mut statement = Query::select();
    statement
        .column((nodes::Entity, nodes::Column::Id))
        .column((nodes::Entity, nodes::Column::Kind))
        .column((nodes::Entity, nodes::Column::Title))
        .expr_as(
            Expr::cust("snippet(nodes_fts, 1, '', '', '…', 16)"),
            Alias::new("snippet"),
        )
        .expr_as(
            Expr::cust("(-bm25(nodes_fts, 8.0, 2.0, 1.0))"),
            Alias::new("score"),
        )
        // ... deliberate CROSS JOIN and rowid join ...
        .from(nodes_fts::Entity)
        .cross_join(nodes::Entity)
        // ...
        .and_where(Expr::cust_with_values(
            "nodes_fts MATCH ?",
            [match_query.to_owned()],
        ))
        .and_where(Expr::col((nodes::Entity, nodes::Column::DocumentId)).eq(DOCUMENT_ID));

    // optional kind filter is added before this order/limit
    statement
        .order_by_expr(Expr::cust("score"), Order::Desc)
        .limit(limit);
```

The comment at `search.rs:69-71` explains the invariant that must survive:
`CROSS JOIN` keeps the FTS virtual table outermost; an `INNER JOIN` caused
26-second searches on 10k nodes. SQLite's implicit order ties are not an
intentional feature: do not add a new ordering key or change the bm25 weights.

`search()` is called on the single worker through
`src/native/src/db.rs:270-277`; the public type stays `Vec<SearchHit>` and
`lib.rs:309-316` exposes the same async `Document.search`. Search adapter SQL
is an explicit exception to the ORM-first rule. Quote from standards §3.2:
"The ORM owns ordinary tables... `MATCH`, `snippet()`, `bm25()` and the escaped
`LIKE` fallback" live in `search.rs`. Every query value still goes through
`Expr::cust_with_values` or SeaQuery binding, never string interpolation.

`search.rs:178-197` has query-shape tests run beside the subject. The actual
search fixture is `db.rs:473-488` (`node(...)`) and its behavior/search tests
at 491-593, 606-643, 803-843. `docs/plans/rust-core.md:376-411` is the
existing benchmark record with provenance. `CHANGELOG.md` has `### Changed`
under `## [Unreleased]` at line 71; this is a notable non-visual performance
change and should receive a concise bullet there.

Dependency state: plan 009 expands the in-memory/file benchmark, including
several candidate timings and connectors/assets. Its row must be DONE and
`src/native/src/db.rs` must still have a `generator` common-term release
measurement before this plan's A/B step. If not, confirm with `grep`; a
missing measurement is a STOP, not justification to fabricate one.

## Commands you will need

| Purpose                       | Command                                                   | Expected on success                                      |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Exact Rust test target        | `cargo test --manifest-path src/native/Cargo.toml search` | all search-named Rust tests pass                         |
| All Rust tests                | `cargo test --manifest-path src/native/Cargo.toml`        | all non-ignored tests pass                               |
| Release benchmark             | `bun run test:bench`                                      | exit 0; prints common-term search timings and hit counts |
| Full gate                     | `bun run check`                                           | format/lint/typecheck/clippy exit 0                      |
| Full tests                    | `bun run test`                                            | Rust then TSX tests all pass                             |
| Format Markdown/changed paths | `./node_modules/.bin/vp fmt --check <paths>`              | all matched files use the correct format                 |

Note: `nsh test src/native/src/search.rs` is not a Rust test runner; use Cargo
direct test commands for each small Rust step.

## Scope

**In scope** (only these files modified):

- `src/native/src/search.rs`
- `src/native/src/db.rs` (behavior regression fixture and one common-term
  timing appended to plan 009's existing benchmark)
- `docs/plans/rust-core.md` (measured results and provenance)
- `CHANGELOG.md`

**Out of scope**:

- `src/native/src/lib.rs`, `types.rs`, `db.rs` outside the two specified
  areas, plus every generated `src/.nsh/` file: public search API unchanged.
- `schema.rs`, FTS schema/tokenizer, `LIKE` fallback, ranking weights,
  `SearchPalette.tsx`, and debounce behavior.
- Plan 009's fixture construction, benchmark scenarios unrelated to search,
  and plan 011/012's scene/mutation work.
- CJK optimization, global tie-breaking policy, a new FTS virtual table or
  query cache.
- `plans/README.md` is the only exception, for this plan's status row.

## Git workflow

- Branch: `advisor/015-search-rank-first` from `main` with
  `git switch -c advisor/015-search-rank-first`.
- Suggested commit sequence:
  1. `test: pin the search result contract beyond the limit`
  2. `perf: rank search hits before making snippets`
  3. `bench: compare ranked common-term search`
  4. `docs: note deferred search snippet work`
     Each commit should explain the reason in its body and match existing
     lower-case imperative subjects such as `fix: open the canvas menu after a
     click on the canvas` (`21dbe05`).
- No AI attribution: no `Co-Authored-By:` naming an AI and no "Generated
  with ..." line. Do not push or open a PR.
- On completion, update the index row and run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Pin search equivalence before changing the SQL shape

Rename the existing `fts_statement` to a reference-only
`fts_statement_all_snippets`, preserving its exact SQL. Temporarily keep
`search()` calling that reference while adding the new helpers. The integration
fixture can then compare actual old and new results against the same
`sea_orm::DatabaseConnection`, opened by `src/native/src/db.rs`'s private
`open_connection(":memory:")` at lines 343–357. This is not
`Database::open()`'s worker wrapper; a synchronous adapter test uses the
connection constructed by that helper, with the same migrations and document.

Add one integration regression in `src/native/src/db.rs` named
`search_ranking_keeps_the_old_snippets_and_order`. For this test only, expose
`pub(crate) fn search_reference(...)` in `search.rs` through the old statement.
Its test signature may return `Result<Vec<SearchHit>, String>`. Build one
fixture with far more matches than the limit (at least 30 nodes, limit 7),
including:

- Frequent `generator` body matches, some title matches with different text,
  and enough varied token frequency/term placement to stress bm25.
- Multiple text and image kinds, where image rows would crowd out the desired
  text rows if filtering happened after the limit.
- Multi-word entries that also produce an ellipsis or empty/short snippet;
  assert each tuple `(id, kind, title, snippet, score)` exactly, including
  `score.to_bits()` (do not use approximate float comparison).
- Ranking score ties: the original ORDER BY has no secondary key. Construct
  the main fixture with distinct bm25 frequencies/lengths; the static seeded
  100k benchmark texts also have varied lengths/order (see `benchmark_nodes`,
  `db.rs:2570-2587`). If a deliberately added tie returns a different SQLite
  internal order, report that unspecified tie change without masking it.

In Step 1, implement the shared inner helper **now**, with this exact
crate-private signature after the existing public `search()` front end:

```rust
pub(crate) fn search_ranked(
    conn: &DatabaseConnection,
    match_query: &str,
    kind: Option<&str>,
    limit: u64,
) -> Result<Vec<SearchHit>, String>
```

This helper is the function Step 1's test calls directly and Step 2's public
`search()` adopts after equivalence passes. Do not create
`search_ranked_for_test` or another test-only wrapper.

First write `search_ranking_keeps_the_old_snippets_and_order`, its complete
vector assertions, and its comparison of `search_reference` with
`search_ranked` against the same `DatabaseConnection`. Run the focused Verify
command and record its compile failure because `search_ranked` does not yet
exist. Then implement the rank-first inner path and its two statement builders
in `search.rs` according to Step 2's specification, and rerun the same test
until it passes before changing public dispatch.

Keep the existing public `search()` otherwise unchanged throughout Step 1: it
still trims/rejects/clamps/routes short terms, and still calls the reference
all-snippets statement. At the end of Step 2, replace exactly
`collect(conn, &fts_statement_all_snippets(&match_query, kind.as_deref(),
limit))` with `search_ranked(conn, &match_query, kind.as_deref(), limit)`.
There is no second production search path: before that one-line switch, only
the test calls the inner helper, while production remains the reference. Keep
`search_reference` with the original single SQL statement under `#[cfg(test)]`,
crate-private and outside the NSH FFI.

**Verify**: before the inner implementation,
`cargo test --manifest-path src/native/Cargo.toml ranking_keeps -- --nocapture`
fails because `search_ranked` does not exist. After implementing the inner path
but before the production switch, repeat that exact command: the named
`db::tests::search_ranking_keeps_the_old_snippets_and_order` test passes on the
unmodified database with complete equal hit vectors. Record both intentional
red and green results; do not skip the red by calling production `search()`.
(Cargo matches the full module path; `--exact` is used only with 016's fully
qualified test names.)

### Step 2: Implement exactly two bound SQL statements

`ranked_fts_statement(match_query, kind, limit)` retains the current
`nodes_fts CROSS JOIN nodes`, rowid/`nodes.seq`, document and kind filters,
`(-bm25(nodes_fts, 8.0, 2.0, 1.0)) AS score`, score-descending order and
limit. It selects only `nodes_fts.rowid AS fts_rowid`, node id/kind/title, and
score. There must be no snippet expression, body or other unused wide field.
Decode into `#[derive(FromQueryResult)] struct RankedSearchRow`.

`snippet_fts_statement(match_query, rowids, kind)` selects
`nodes_fts.rowid AS fts_rowid`, and all old `SearchHitRow` fields, including
exactly `snippet(nodes_fts, 1, '', '', '…', 16)` and
`(-bm25(nodes_fts, 8.0, 2.0, 1.0)) AS score`. It uses
`nodes_fts MATCH ? AND nodes_fts.rowid IN (?, ..., ?)`; one trusted
structural `?` per rowid from the bounded list, with each rowid a bound
SeaQuery value (`Expr::cust_with_values` or `.is_in(rowids)`). Never splice
one into SQL. Keep its MATCH/join/document/kind constraints identical to the
rank statement. It needs no order or additional LIMIT: apply rank-statement
ordering in Rust. One SQL statement computes snippets for at most `limit <=
200` rows.

Do **not** introduce bare `ROW_NUMBER()` or add a window filter to FTS5 as
part of this "small" plan. The LIMIT rank statement is constructed first,
executed and converted before the detail MATCH statement. This directly bounds
snippet computation, avoiding uncertain virtual-table/window optimization.
An optional subquery rewrite is out of scope for this plan; there is no such
executor discretion needed here.

Execute the two-stage adapter in production search. Return [] without even writing a second query if
phase 1 is empty. Otherwise extract its ordered ranked vec, run phase 2,
decode into `SnippetSearchRow { fts_rowid, hit: flattened fields... }`,
key by unique `fts_rowid`, remove from dict in rank order, and produce the
public existing `SearchHit { id, kind, title, snippet, score }` using the
phase-2 payload plus phase-1 score (explicitly assert both scores' `to_bits`
are equal when populating). Every retained rank must produce one full row;
a missing unexpected duplicate id/rowid causes an adapter error, not missing
or wrong data. Crucially this preserves the rank sequence after snippets even
though phase 2 has no defined ORDER BY. `LIKE`, `fts_match_query`, its
quoting/trimming, limit=0 handling and weights are untouched.

Do not modify public `Document.search` FFI or source-facing types. The
reference statement remains `#[cfg(test)]` only once the switch occurs; the
file's snippet/bm25/CROSS JOIN adapter permission does not permit other SQL in
ordinary tables.

The rank/detail implementations use the two queries defined above; the rank
statement never calls snippet and snippet statement runs after the original 20
row cap, not once per candidate.

Do not alter `LIKE`, `fts_match_query` term quoting, or public FFI contract;
the original statements stay available only as `#[cfg(test)]` reference A/B
helpers, not a second user-visible production path. The same rank/detail
functions create SQL for both production and test compared results.

Modify the former `fts_statement_matches_before_joining_nodes` SQL-shape case
to verify both statements retain the deliberate FTS5 CROSS JOIN, MATCH,
`bm25(nodes_fts, 8.0, 2.0, 1.0)`, document and optional kind filters. The
rank statement has no snippet; detail has rowid IN and exact snippet config.
Update the module header to describe the two-stage bounded behavior.

**Verify**: `cargo test --manifest-path src/native/Cargo.toml search` → all
existing and new shape/integration search tests pass, including the
`>matches > limit` equivalence and `LIKE` fallback. Run
`cargo test --manifest-path src/native/Cargo.toml` → all non-ignored Rust
tests pass.

### Step 3: Establish the one-line common-term hit-set contract at 100k

Extend plan 009's ignored benchmark, not the normal CI suite, to run the same
100k common-term search (`generator`, default filters, limit 20) through both
reference and new adapters on the same database without intervening writes.
Assert exact `SearchHit` vector equality including scores before recording
throughput. Do not use hit count alone; it misses changed snippets and order.

Record each side's avg and p95 across the same repeated pattern already used
by 009 (or add at least five matched pair repetitions after a warmup if that
benchmark lacks them), with labels for rows returned, `reference(all snippets)`
and `rank-first(snippet limit)`. Keep the benchmark `#[ignore]`; no hard
millisecond threshold is appropriate under standards §8.2. Plan 009 may already
hold this loop; preserve its established timing iterations and record those
counts in the documentation. Remove the direct reference-timing production
path if needed by making the helper `#[cfg(test)]`, but keep the benchmark in
the same compiled test module so it can access it.

Do not report "% faster" against pre-009 numbers if the fixture changed such
that common-term match population changed. Always use paired before/after from
the same database. A connector/assets-rich fixture can produce different
absolute numbers from the old P0 results; that is a fact to retain in the
notes, not a regression to hide.

**Verify**: `bun run test:bench` → all release test/benchmark paths exit 0;
the log includes equal search vectors, repeated avg and p95 for both
implementations, and both labels. `snippet evaluations` should not be an
expensive instrumented runtime measurement; the count is at most returned
hits by construction and covered by the query-shape tests.

### Step 4: Document the evidence, add changelog and run the full gate

In `docs/plans/rust-core.md`'s measured-results area (following the P0 table
at lines 383–399), add a dated follow-up subsection, not silent alteration of
old measurements. Include machine/OS, release build, fixture used after 009,
query/filters/limit, per-run hit-vector equivalence, iteration count,
before/after average and p95, and explicitly say an A/B within one unchanged
DB is the correct comparison after fixture changes. Leave the old historical
P0 numbers intact. Mention in the follow-up if the new numbers differ greatly
because 009 added connectors/assets.

Add one `CHANGELOG.md` `### Changed` bullet: ranked common-text searches now
make snippets only for retained hits; no UI/suggestion behavior change.
Update stale module docs at `search.rs:1-6` to describe this
bounded two-phase approach while preserving `MATCH` and CROSS JOIN intent.

Run:

```sh
bun run check
bun run test
./node_modules/.bin/vp fmt plans/README.md
```

**Verify**: each gate exits 0. `grep -n "generator\|rank-first\|reference(all snippets)" docs/plans/rust-core.md`
shows the newly measured common-term comparison with machine/date provenance;
`git diff --stat 1956ebb --name-only` yields no source edits outside the two
allowed Rust files.

## Test plan

- `src/native/src/search.rs`:
  - Existing `fts_statement_matches_before_joining_nodes` revised for the two
    stages: preserve CROSS JOIN/MATCH/8,2,1 weights; no snippet in rank stage;
    retained-row filter in detail stage.
  - Existing `like_statement_escapes_the_pattern` remains green.
- `src/native/src/db.rs`, using its `node(...)` helper and the pattern in
  `inserts_searches_moves_and_deletes` (lines 491-593):
  - New `search_ranking_keeps_the_old_snippets_and_order`: >30 matches, limit
    7; complete hit tuple equality; filter-before-limit; exact snippet and
    `f64::to_bits` score; empty hits and zero limit unchanged.
  - Retain `short_terms_all_match_in_a_mixed_query` (606-643), kind-filter
    tests and searchable-text undo tests (803-843) as behavior safety net.
- Benchmark (`bun run test:bench`, never CI assertions): paired reference/new
  equality at 100k and paired common-term timings, with optional selective
  result checks already established by 009 kept unchanged.
- Commands and expected results are in steps 1–3; full gates are in step 4.

## Done criteria

- [ ] On an unchanged fixture with more matches than LIMIT, old/new results,
      ordering, IDs, kinds, titles, snippets and score bits are exactly equal.
- [ ] `grep -n "snippet\|bm25\|CROSS JOIN\|rowid IN" src/native/src/search.rs`
      shows both phases, shared rank expression and preserved deliberate join;
      the rank-only statement contains no snippet.
- [ ] Kind filter precedes limit and all rowids/query values are bound.
- [ ] `cargo test --manifest-path src/native/Cargo.toml` has all non-ignored
      Rust tests passing, including the named equivalence test.
- [ ] `bun run test:bench` produces paired old/new avg and p95 for the same
      `generator` data, and its exact hit-vector equality assertion passes.
- [ ] `docs/plans/rust-core.md` records those data with post-009 fixture,
      timestamp/OS/build and iteration count; `CHANGELOG.md` has one bullet.
- [ ] `bun run check` and `bun run test` both exit 0.
- [ ] No public search API, schema, FTS weights, LIKE fallback or TSX source
      changed; no out-of-scope file shown by `git status --short`.
- [ ] `plans/README.md` status row updated and formatted.

## STOP conditions

- Dependency 009 is not DONE or has no comparable common-term benchmark.
- Reference/new results differ in rank order, snippet text, score (including
  bits), or filter count on the same static database. Do not "fix" this by
  introducing an arbitrary tie-break, deduplication, or limit adjustment.
- There is no safe bound-parameter representation for per-retained-row IN and
  raw SQL without bound identifiers would be required; ask for review rather
  than interpolating values.
- Score tie behavior has to change, or changing CROSS JOIN/rowid join becomes
  tempting: retain the proven shape and pause for maintainer decision.
- Plan 009's rich fixture makes absolute numbers differ from pre-009; do not
  compare those directly or edit historical numbers to force consistency.
- A verification fails twice after a reasonable fix attempt, or completion
  requires editing the public FFI, schema, TSX or another out-of-scope file.

## Maintenance notes

- Keep the rank predicate and detail predicate bit-for-bit consistent as search
  evolves (filters, kind, document, match quoting, bm25 weights). A reference
  equality test is the contract; maintain it alongside modifications.
- The snippet stage always uses retained-row IDs in SQL. One statement for ≤200
  hits avoids per-hit FFI/SQL and parameter-list interpolation.
- If SQLite engine/SQLite FTS version is upgraded, re-run the equivalence and
  benchmark, especially ties. The old statement is kept only under
  `#[cfg(test)]` for this comparison, not as a user-selectable query path.
- `LIMIT` is capped at 200 in production. Do not lift this plan's cap or
  discard "empty rank list skips snippet" on the assumption of small results.
