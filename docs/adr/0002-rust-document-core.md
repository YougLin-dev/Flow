# 0002: Use a Rust document core with SQLite for the desktop app

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Flow maintainers

## Context

Flow is currently a TSX-only NSH app. Its canvas runs in QuickJS and every
document value, search operation and persistence step would share that VM's
limits: a 2 second budget for one call into JS, a 256 MB JS heap and no
`IndexedDB`, `WebAssembly` or `structuredClone`. The product is heading for a
large infinite canvas with many connected nodes, runtime state, undo/redo, an
asset library and heavy full-text search. Benchmarking the pure-JS options
showed that 100k rich-text nodes do not fit the embedded limits, and that
common-term search at 50k already approaches the call budget.

NSH supports apps written in Rust, TSX or both. In a mixed app the TSX entry
stays the root, the app carries QuickJS for its screens, and a Rust crate
exports components, modules and classes through a generated typed boundary.
A pure Rust app has no QuickJS, but Leafer is a JavaScript library and would
have to be rewritten or hosted in a separate JS runtime.

The app is desktop-only: macOS, Windows and Linux. There is no web or mobile
target to support.

## Decision

Adopt a mixed NSH app for Flow:

- `src/App.tsx` stays the entry point and the UI stays in TSX.
- Add a Rust crate at `src/native/` and point `nsh.json` at it with `"rust":
  "native"`.
- The Rust crate owns the document model, commands and undo/redo, full-text
  search, viewport queries, asset metadata and persistence.
- Use one bundled SQLite database with WAL, FTS5 (trigram) and RTree.
- Leafer stays in TSX/QuickJS and continues to own the scene, editor, camera
  and input. It is not moved into Rust.
- Do not add TinyBase or FlexSearch to this design. SQLite replaces both the
  source of truth and the search sidecar.

The implementation sequence, schema, API boundary and acceptance criteria are
in [the Rust core plan](../plans/rust-core.md).

## Consequences

- The data and search layer is no longer bounded by the QuickJS heap or call
  budget. Rust can use native threads, SQLite WAL and the filesystem directly.
- The app carries QuickJS for its TSX screens. Leafer's scene graph, editor
  and draw calls remain subject to the JS limits, so the scene must be
  virtualized by viewport; Rust does not make 100k visible Leafer nodes viable.
- Build and release gain a Rust toolchain, Cargo dependencies and
  platform-specific native builds. The desktop CI matrix must build and test
  Windows, macOS and Linux.
- SQLite gives atomic document and search updates in one transaction, plus
  schema migrations and crash recovery. It also creates a data format and
  migration surface the project must maintain.
- The Rust/TSX boundary must stay coarse-grained and typed. Per-node or
  per-frame FFI calls are not acceptable.
- The app remains local-first and desktop-only. There is no web or mobile
  persistence path to design.

## Alternatives considered

- **TinyBase + a JS search sidecar (FlexSearch or MiniSearch).** Rejected for
  the 100k target: the combined data and index exceed the embedded heap, and
  broad queries approach the 2 second call budget. It remains a reasonable
  option only for a much smaller TSX-only prototype.
- **Orama for full-text, facets and vectors.** Rejected: too large and too
  slow at 10k–100k in QuickJS, with no usable CJK tokenizer under the embedded
  runtime.
- **SQLite through WASM or a browser API.** Rejected: `WebAssembly` and
  `IndexedDB` are unavailable in this runtime, and the product has no web
  target to justify a second persistence path.
- **A pure Rust app with a Rust canvas.** Rejected for now: it would replace
  Leafer's scene graph, editor, hit testing and camera, which is a much larger
  product rewrite than moving the data layer.
- **A WebView running Leafer's web build from Rust.** Rejected: it is a
  browser surface, not NSH's native canvas, and complicates input, focus,
  assets and the editor.
- **A remote search service.** Rejected for the first version: Flow is a
  local-first desktop app and the network is not needed for document search.
  A server or a native search sidecar can be revisited only if requirements
  outgrow SQLite FTS5.
