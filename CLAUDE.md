# Notes for coding agents

Flow is a TSX app for Native Shell (NSH) with a Rust document core and a
native-view canvas. Read [the engineering standard](docs/standards.md),
[architecture](docs/architecture.md), [conventions](docs/conventions.md) and
[testing](docs/testing.md) before changing code; this file is the short list.

## Gate

Run `bun run check` (format + lint + type check + Rust format/clippy +
boundary-rule tests; file names and dependency direction are lint rules) and
`bun run test` (Rust unit tests plus TSX tests) before you finish.
`bun run check:fix` applies safe fixes. `bun run test:host` also drives the
real desktop host on this OS. `bun run test:bench` runs the ignored 100k
SQLite/search benchmark.

## Invariants

- **App code lives in `src/`:** the entry, `nsh.json`, `theme.json` and assets
  are the NSH app root; the repository root is tooling only.
- **No `any`.** Narrow `unknown` with type guards.
- **Dependencies flow down.** `src/App.tsx → pages → components/store`.
  `components/` and foundations never import a page; foundations
  (`flow/`, `lib/`, `tool.ts`) never import the store. The
  `boundaries/no-upward-import` rule (`lint/boundaries.js`) enforces it.
- **Database access is ORM-first.** Use the SeaORM entities and SeaQuery in
  `src/native/`; handwritten SQL is limited to the FTS5/RTree virtual-table
  adapter and migrations. Never interpolate values into a query.
- **Signals stay private in `src/store.ts`.** Export readers and actions;
  pages bind them to presentational components.
- **The canvas is native views.** Cards, ports, connectors, selection and the
  composer are ordinary NSH views. Keep geometry in `src/flow/` (scene, camera,
  selection, overlay), gestures in `src/flow/canvas-controller.ts`, and the
  views in `src/components/FlowCanvas.tsx` and its parts; extend those with
  tests instead of adding a canvas library.
- **The document core is Rust's.** `src/native/` is the mixed NSH Rust crate;
  it owns SQLite, FTS5, RTree, undo history and asset metadata. TSX must not
  open SQLite or write SQL. The canvas stays in TSX/QuickJS and is never moved
  into Rust. Keep calls coarse-grained; no per-node or per-frame FFI.
- **The scene is viewport-driven.** `FlowScene` reconciles only the nodes and
  edges in `scene(rect, margin)`; keep the card budget, throttled reads and
  selected-card pinning. Never instantiate the whole document in the view tree.
- **Files stay focused.** The `max-lines` lint rule caps a module at 500 code
  lines; treat that as a prompt to find a seam, not a target.
- **Design tokens only.** No raw hex/rgba or palette classes in app code; add
  a semantic token to `src/theme.json` when a role is missing.
- **The sandbox is declared.** `src/nsh.json` grants no remote hosts; add one
  to `capabilities.network` only for a real integration, and keep the
  `capabilities` key (its presence switches the app to allow-list mode).
- **File names:** PascalCase components, kebab-case modules,
  `*.test.ts(x)` beside the code — enforced by `unicorn/filename-case` with
  per-extension overrides in `vite.config.ts`.
- **Tests:** one behaviour, `app.waitUntil` instead of sleeps, stable
  `testID`s, clean up controllers and document sessions you create.
