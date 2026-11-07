# ADR 0003: SeaORM Sync for the document database

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Flow maintainers
- **Supersedes:** the raw-SQL queries in P0 of
  [ADR 0002](0002-rust-document-core.md); the storage decision itself stands.

## Context

P0 proved that a Rust-owned SQLite database can serve the document core, but
it wrote every query by hand. The project rule is now stricter: business code
must use an ORM/query builder rather than raw SQL. The decision has to fit the
existing constraints:

- Desktop only. There is no browser or mobile SQLite path.
- The core is synchronous Rust inside NSH. Database calls already run on NSH's
  blocking pool, so an async runtime and connection pool are not wanted.
- The schema uses ordinary relational tables plus two SQLite virtual-table
  index families: FTS5 for trigram search and RTree for viewport queries.
- Dynamic filters (document, kind, tags, future status) are common; a static
  query DSL alone is not enough.
- The UI must stay responsive at 100k nodes, with selective search around
  10 ms and viewport reads below a millisecond.

## Options considered

| Option                           | Why it fits                                                                                                                      | Why it does not                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **SeaORM Sync 2.0.4 + SeaQuery** | Official sync variant backed by `rusqlite`; entities, relations and `ActiveModel`; SeaQuery for dynamic filters; schema builder. | FTS5/RTree still need a virtual-table adapter; `sea-query-rusqlite` pins `rusqlite` 0.38; the shared connection is not `Send`. |
| Diesel 2.3.14                    | Mature, compile-time checked, good migration tooling.                                                                            | Dynamic filters need boxed queries; FTS5/RTree need `sql_query`; table schema and query code are more verbose.                 |
| SQLx 0.9                         | Excellent async SQL toolkit and compile-time SQL checks.                                                                         | It is not an ORM and still requires SQL strings, so it does not satisfy the rule.                                              |
| SeaQuery alone                   | Injection-safe query builder over the existing `rusqlite` connection.                                                            | No entities, relations, `ActiveModel` or schema-from-model; row mapping stays manual.                                          |

## Decision

Use **SeaORM Sync 2.0.4 with SeaQuery 1.0** and SQLite through
`sea-query-rusqlite` / `rusqlite` 0.38 with the bundled SQLite build.

- Ordinary tables (`documents`, `nodes`, `edges`, `assets`, `node_assets`,
  `schema_migrations`) are SeaORM entities and are created from those entities.
- Reads and writes use entities, `ActiveModel`, `QueryFilter`, SeaQuery joins,
  conditions and ordering. No handwritten `SELECT`/`INSERT`/`UPDATE`/`DELETE`
  strings exist for ordinary tables.
- The FTS5 and RTree tables are virtual tables. SQLite exposes no ORM schema or
  `MATCH` operator for them, so their DDL, `MATCH`, `snippet()`, `bm25()` and
  the escaped-`LIKE` fallback live in one documented adapter
  (`schema.rs`/`search.rs`). Values are always bound; only static SQL
  fragments are allowed there.
- The database connection lives on one dedicated worker thread. SeaORM's sync
  `RusqliteSharedConnection` is deliberately `!Send` (it owns a non-`Send`
  metric callback), so `Database` is a `Send + Sync` handle that sends typed
  jobs to that thread. This preserves the single-writer design and keeps
  SQLite off NSH's engine thread.
- Migrations are recorded in a `schema_migrations` table rather than
  `PRAGMA user_version`. A migration is an ordinary SeaORM insert after the
  schema statements; future versions add explicit, ordered steps.

## Consequences

- The P0 schema changes: `nodes` gains an internal `seq INTEGER PRIMARY KEY`
  used by RTree and FTS; `nodes.id` becomes `UNIQUE`. This is safe because P0
  was never wired into the app. An old development database is rejected with a
  clear message instead of being silently reinterpreted.
- `rusqlite` is pinned to 0.38 by `sea-query-rusqlite` 0.8. The app enables
  the `bundled` feature so FTS5 and RTree are available on every OS.
- `sea-orm-migration-sync` does not exist; schema evolution uses the sync
  `Schema` builder plus explicit migration steps, not the async migration
  crate. SeaORM's experimental `schema-sync` feature is not used.
- Insert performance benefits substantially from leaving out
  `sqlite-use-returning-for-3_35`: SQLite's `RETURNING` path roughly tripled
  the 100k-node build time in the spike, so `InsertResult::last_insert_id`
  uses `last_insert_rowid`.
- The FTS and RTree reads use `CROSS JOIN` to pin the virtual table as the
  outer join side. SeaQuery's ordinary `INNER JOIN` let SQLite choose the
  document index first, turning a 10k-node search into 26 seconds; the
  generated SQL is asserted in unit tests so the order cannot regress.
- A future move to another database would replace the entity/driver layer but
  not the command or search APIs; FTS5/RTree would still need a
  database-specific adapter.

## Verification

The 100k-node release benchmark, the Rust unit tests, the TSX
`src/native.test.ts` smoke test and `bun run check` cover the refactor. The
measured results are kept in [the Rust core plan](../plans/rust-core.md).
