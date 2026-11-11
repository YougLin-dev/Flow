# Flow

An infinite flow canvas built with [Native Shell](https://nsh.dev/) (NSH). The
canvas is a native NSH view tree — cards, ports, selection and the composer
are ordinary views, so text, focus and accessibility are the platform's, while
hit testing is the scene model's. Connectors are stroked on a native canvas
layer so the curves stay smooth and sharp at any zoom. A mixed-app Rust crate in `src/native/` owns the document
database, search and undo core; the canvas stays in TSX. `⌘K` / `Ctrl+K` (or
the Search button) opens a command palette over the Rust full-text index.

The app is sandboxed by `src/nsh.json`: it may read its own bundled assets but
no remote host. An integration that fetches or loads remote images adds that
host to `capabilities.network` deliberately.

## Requirements

- [Bun](https://bun.sh/) 1.4 or newer (`packageManager` pins the exact version)
- The `nsh` CLI 0.4.0 or newer (CI pins `v0.4.0`)
- A Rust toolchain with Cargo (for the `src/native/` mixed-app crate)

## Quick start

```sh
bun install
bun run dev        # opens the app on this machine's development host
```

`bun run dev` sets `FLOW_DB_PATH` to `.nsh/dev/flow.db`, so development data
survives restarts; delete that file to start from the demo document again.
Other runs open `host.params.databasePath`, then `FLOW_DB_PATH`, then
`process.dataDir/flow.db`, falling back to an in-memory database. The
`process.env` capability in `src/nsh.json` grants only `FLOW_DB_PATH`.

The first `nsh` command writes `src/.nsh/types` (NSH's TypeScript
declarations) and `src/.nsh/tsconfig.json`. They are generated, git-ignored and
safe to delete. Build and installer output stay at `.nsh/out` in the
repository root.

## Commands

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `bun run dev`        | Runs the app on this machine (`nsh run src`).                             |
| `bun run build`      | Builds the bundle for deployment (`nsh build src`, output in `.nsh/out`). |
| `bun run test`       | Runs Rust unit tests plus every app test (`*.test.ts(x)`) headless.       |
| `bun run test:host`  | Runs the platform tests (`*.host.test.tsx`) on this machine's host.       |
| `bun run test:lint`  | Runs the dependency-boundary rule's tests (`bun test lint`).              |
| `bun run test:bench` | Runs the ignored 100k SQLite/FTS5/RTree benchmark.                        |
| `bun run test:100k`  | Seeds 100k nodes and drives the real host UI against them.                |
| `bun run typecheck`  | Type-checks with NSH's compiler settings (`nsh check src`).               |
| `bun run lint`       | Checks types, then lints with Oxlint; `lint:fix` applies fixes.           |
| `bun run fmt`        | Formats with Oxfmt (`vp fmt`); `fmt:rust` formats the native crate.       |
| `bun run check`      | Format, lint, type-check, Rust fmt/clippy and boundary-rule tests.        |
| `bun run check:fix`  | Same, applying every automatic fix.                                       |
| `bun run package`    | Builds the native installer for this OS (`docs/packaging.md`).            |

`bun run test:host` runs only the `*.host.test.tsx` platform tests, each in its
own native host process; `bun run test` already runs them headless along with
every other test. Modules that import `@flow/native` stay headless-only
(`*.native.test.ts`), because the host cannot load the module before an app
registers it. `bun run test:100k` is a real-host smoke and writes screenshots
under `.nsh/bench/` for manual review.

`bun run check` is what CI runs. `vp check` (Vite+) drives the formatter,
Oxlint (type-aware, with full type checking) and the TypeScript check, and then
`bun run test:lint` proves the boundary rule itself can fail; warnings fail the
gate (`--deny-warnings`). File names are part of lint
(`unicorn/filename-case`, configured per extension), and the one-way
dependency rule is a project Oxlint JS plugin (`lint/boundaries.js`), so a
single command enforces all of it.

The normative engineering standard is [docs/standards.md](docs/standards.md):
read it before changing architecture, the native canvas, state ownership or
release tooling.

## Project layout

```
package.json           scripts, dependencies, package manager
vite.config.ts         Vite+ lint/format: type-aware, no `any`
tsconfig.json          extends the app's TS settings, includes src/
src/                   the NSH app: its root, entry, config and assets
  App.tsx              entry: mount(App); the shell composes the title bar and page
  App.test.tsx         end-to-end app tests (headless)
  App.host.test.tsx    platform tests also run on the real host
  nsh.json             app metadata (name, id, version, icon, theme)
  theme.json           design tokens (light and dark)
  tsconfig.json        NSH's TypeScript settings
  store.ts             app state: private signals behind readers and actions
  tool.ts              the Tool union shared by the store and the controls
  pages/
    FlowPage.tsx       the workspace: document session, camera, overlays
  components/
    FlowCanvas.tsx     the canvas: world-space cards and edges, gestures
    FlowCard.tsx       one card: title, status, body, ports
    Icon.tsx           one Lucide icon, drawn as a native canvas path
    FlowEdges.tsx      every connector, stroked as one native-canvas layer
    FlowEdge.tsx       the connection preview, one canvas stroke
    GridBackground.tsx the dot-grid backdrop
    SelectionOverlay.tsx selection borders, resize handles and the marquee
    NodeComposer.tsx   the native composer attached to the selected card
    InlineTextEditor.tsx the screen-space text editor
    NodeToolbar.tsx    floating add-node buttons
    TitleBar.tsx       custom title bar (pin, drag, native window controls)
    ZoomControls.tsx   zoom in / out / fit
    SearchButton.tsx   floating search entry point
    SearchPalette.tsx  debounced full-text search, filters and result navigation
    SelectionBadge.tsx selection count
    BrandCard.tsx      branding shown where the desktop shell is absent
  flow/
    data.ts            the demo nodes/edges used to seed an empty document
    database-path.ts   resolves the document path from host/env/data-dir
    scene.ts           headless scene model: cards, edges, selection, previews
    camera.ts          infinite-canvas camera (pan, zoom, fit)
    grid.ts            the dot grid's screen-space tile layout
    canvas-controller.ts pointer gestures: select, drag, resize, marquee, connect
    selection.ts       selection handles, resize and marquee geometry
    icon-shape.ts      Lucide icon nodes as one SVG path
    overlay.ts         composer and inline-editor placement
    composer-state.ts  the composer's drafts
  native/              mixed NSH Rust crate (SQLite/FTS5/RTree document core)
    Cargo.toml
    src/lib.rs         exports the @flow/native Document class
    src/db.rs          database handle, worker thread, WAL
    src/entity/        SeaORM entities, one file per table
    src/schema.rs      table creation and the virtual-table adapter
    src/mutation.rs    transactional commands and undo payloads
    src/search.rs      FTS5 search and the short-query fallback
    src/viewport.rs    RTree viewport reads
    src/scene.rs       visible nodes + edges, and document bounds
    src/history.rs     reversible undo/redo operations
  lib/
    window-chrome.ts   hides the native title bar and reports its metrics
  assets/              icons and images (imported by modules)
lint/
  boundaries.js        Oxlint JS plugin: dependencies flow down
scripts/
  package.mjs          installer build
  dev.mjs              dev host launcher with a persistent FLOW_DB_PATH
  test-host.mjs        native test host for this OS
  smoke-100k.mjs       100k-node seed + real-host UI smoke
.github/workflows/     CI and installer builds
docs/                  standards, architecture, conventions, testing, packaging, ADRs
CHANGELOG.md           Keep a Changelog history and unreleased changes
```

`src/` is the NSH application root: `nsh.json`, `theme.json`, the entry
module and its assets all live together, as NSH expects, while the repository
root keeps the toolchain (`package.json`, `vite.config.ts`, `tsconfig.json`,
`scripts/`, CI).

The structure follows NSH's [project structure](https://nsh.dev/zh-CN/docs/project-structure/)
and [coding guides](https://nsh.dev/zh-CN/docs/coding-guides/): dependencies
flow down only (`src/App.tsx → pages/ → components/ → nsh`), the store's
signals stay private behind functions, and tests sit beside the code they
test.

## Documentation

- [Architecture](docs/architecture.md) — the layers, the native canvas, input
  and rendering.
- [Conventions](docs/conventions.md) — naming, imports, types, styling,
  comments and the checks that enforce them.
- [Testing](docs/testing.md) — headless vs host tests, the helpers, and what
  to test.
- [Packaging](docs/packaging.md) — installers, icons and signing per OS.
