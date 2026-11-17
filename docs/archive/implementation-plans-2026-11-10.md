# Implementation plans (closed, 2026-11-10)

The 19 implementation plans generated on 2026-11-10 against commit `1956ebb`
are closed: every one is done or rejected, and its work is in `main`. The
plan bodies were removed from the repository root; their full text remains in
git history (`git show 906b340:plans/<name>.md`). This record lives under
`docs/archive/` because the root `plans/` directory no longer exists.

They targeted the canvas performance problem behind a 70 fps group drag at
document scale. Names and paths quoted in the old plans describe the tree at
execution time (for example `src/flow/scene.ts`); the current tree is in
[the code map](../code-map.md). The NSH pins they name
(`f0b4659`, `bc17f693`) were current then; the crate's fork pin is
recorded in `src/native/Cargo.lock`.

## Status

| Plan | Title                                                              | Outcome                                                                                                |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 001  | Measure performance on an optimized host                           | DONE — established the release-host recipe and baselines now in [testing](../testing.md)               |
| 002  | Apply each scene command and pointer event in one update round     | DONE                                                                                                   |
| 003  | Compute the connector layer's box once per change                  | DONE                                                                                                   |
| 004  | Run the connector comet as a native loop that pauses and honors RM | DONE — the comet itself was later removed with the typed-port change                                   |
| 005  | Rebuild a card's pluses and border only when its own state flips   | DONE                                                                                                   |
| 006  | Keep the composer on screen when its card is clicked               | DONE                                                                                                   |
| 007  | Make viewport reads and change sets wake only what changed         | DONE                                                                                                   |
| 008  | Answer hit tests without walking every card and connector          | DONE                                                                                                   |
| 009  | Benchmark the 100k paths that grow                                 | DONE — the benchmark contract lives in [testing](../testing.md) and [rust-core](../plans/rust-core.md) |
| 010  | Keep at most one viewport read in flight                           | DONE                                                                                                   |
| 011  | Read only the cards and connectors the canvas will keep            | DONE                                                                                                   |
| 012  | Write each moved card and connector box once per gesture commit    | DONE                                                                                                   |
| 013  | Show asset images through blob: URLs instead of base64 data: URLs  | DONE                                                                                                   |
| 014  | Cut per-card paint work on large boards                            | DONE — the detail tiers were reverted on 2026-11-11                                                    |
| 015  | Rank search hits before computing snippets                         | REJECTED — the two-phase query is 5x slower; SQLite already defers `snippet()`                         |
| 016  | Small performance cleanups (five independent commits)              | DONE                                                                                                   |
| 017  | NSH fork: record and replay only visible canvas strokes (Windows)  | DONE — in the fork's history; the current pin includes it                                              |
| 018  | NSH fork: skip off-damage view painting and nine-patch shadows     | DONE — nine-patch deferred; the rest is in the fork                                                    |
| 019  | Typed input and output ports                                       | IMPLEMENTED — typed ports and the v2 benchmark fixture; see the CHANGELOG and database design          |

## Where the results live

- Measurement recipe, test levels and current baselines:
  [docs/testing.md](../testing.md).
- Benchmark and design decision log, including the rejected alternatives:
  [docs/plans/rust-core.md](../plans/rust-core.md) and
  [docs/plans/database-design.md](../plans/database-design.md).
- User-visible changes: [CHANGELOG.md](../../CHANGELOG.md).
- The NSH host work (017/018): the NSH fork's own history
  (`E:\code\mine\nsh-pr`).
