# Flow

An infinite flow canvas built with [Native Shell](https://nsh.dev/) (NSH). The
canvas is a native NSH view tree — cards, ports, selection and the composer
are ordinary views, so text, focus and accessibility are the platform's, while
hit testing is the scene model's. Connectors are stroked on native canvas
layers so the curves stay smooth and sharp at any zoom. A mixed-app Rust crate in `src/native/` owns the document
database, search and undo core; the canvas stays in TSX. `⌘K` / `Ctrl+K` (or
the Search button) opens a command palette over the Rust full-text index.

The app is sandboxed by `src/nsh.json`: it may read its own bundled assets but
no remote host. An integration that fetches or loads remote images adds that
host to `capabilities.network` deliberately.

## Architecture invariants

- `src/flow/canvas` is native: cards, ports, selection and the composer are
  ordinary NSH views, connectors are stroked in native canvas layers (one
  for committed edges, one for previews), never a retained scene, and hit
  testing stays in the scene model. The scene reconciles the viewport
  snapshot within its card budget while pinning selected cards and their
  connectors; never instantiate the whole document in the view tree.
- `src/flow/document` is the document side. Rust (`src/native/`) owns SQLite,
  full-text search, undo and asset metadata; TSX never opens SQLite or writes
  SQL. Keep FFI calls coarse-grained and route reads through the single
  worker.
- Loaders are single-flight through `flow/shared/async-drain.ts`; each
  loader keeps its own scheduling, revision fences and retry rule.
- Cross-area imports use the area facade (`flow/*/index.ts`, except the
  same-feature deep import and the `pages/flow` / `pages/projects`
  composition roots). Pages may use components and the store; components and
  `flow` never import the store.

## Requirements

- [Bun](https://bun.sh/) 1.4 or newer (`packageManager` pins the exact version)
- The `nsh` CLI 0.5.0 or newer; CI installs the upstream nightly because the
  app uses APIs newer than the latest stable (`wakeCount`, `App.wake`). The
  Rust core pins the fork at `e2479085c` (`src/native/Cargo.lock`), and a
  local host should match that pin.
- A Rust toolchain with Cargo (for the `src/native/` mixed-app crate)

## Quick start

```sh
bun install
bun run dev        # opens the app on this machine's development host
```

`bun run dev` points `FLOW_PROJECTS_ROOT` at `.nsh/dev/projects`, so
development data survives restarts and the app opens on its project list;
create a project to start a canvas. Each project is one self-contained
package (a SQLite database plus its `assets/` directory). Set `FLOW_DB_PATH`
to open the legacy single document at that path for a run instead. The app
otherwise prefers `host.params.databasePath`/`FLOW_DB_PATH`, then
`host.params.projectsRoot`/`FLOW_PROJECTS_ROOT`, then
`process.dataDir/projects`, falling back to an in-memory legacy document.
The `process.env` capability in `src/nsh.json` grants exactly
`FLOW_DB_PATH`, `FLOW_PROJECTS_ROOT` and `FLOW_FPS`.

The first `nsh` command writes `src/.nsh/types` (NSH's TypeScript
declarations) and `src/.nsh/tsconfig.json`. They are generated, git-ignored and
safe to delete. Build and installer output stay at `.nsh/out` in the
repository root.

## Commands

| Command              | What it does                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `bun run dev`        | Runs the app on this machine (`nsh run src`).                                            |
| `bun run build`      | Builds the bundle for deployment (`nsh build src`, output in `.nsh/out`).                |
| `bun run test`       | Runs Rust unit tests plus every app test (`*.test.ts(x)`) headless.                      |
| `bun run test:host`  | Runs the platform tests (`*.host.test.tsx`) on this machine's host.                      |
| `bun run test:lint`  | Runs the boundary and structure rule tests (`bun test lint scripts/structure.test.mjs`). |
| `bun run test:bench` | Runs the ignored 100k SQLite/FTS5/RTree benchmark.                                       |
| `bun run test:100k`  | Seeds 100k nodes and drives the real host UI against them.                               |
| `bun run typecheck`  | Type-checks with NSH's compiler settings (`nsh check src`).                              |
| `bun run lint`       | Checks types, then lints with Oxlint; `lint:fix` applies fixes.                          |
| `bun run fmt`        | Formats with Oxfmt (`vp fmt`); `fmt:rust` formats the native crate.                      |
| `bun run check`      | Format, lint, type-check, Rust fmt/clippy and boundary/structure tests.                  |
| `bun run check:fix`  | Same, applying every automatic fix.                                                      |
| `bun run package`    | Builds the native installer for this OS (`docs/packaging.md`).                           |

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
  pages/
    flow/
      index.ts         the page area facade
      FlowPage.tsx     the workspace: document session, camera, overlays
      workspace/
        bindings.ts    the global keyboard commands
        flow-actions.ts the key actions and the Escape layer order
        flow-effects.ts the selection and composer effects
        flow-workspace.ts the document session, scene, camera and controllers
        page-chrome.ts the page root's pointer and wheel forwarding
        save-drafts.ts  the close-time draft save
        search-navigation.ts revealing a search hit
    projects/
      index.ts         the page area facade
      ProjectsPage.tsx the project list: header, rows, menus and dialogs
      projects-home.ts the app-lifetime store, list and current project
      project-action-run.ts the dialog's in-flight action rule
      *Dialog.tsx      create, rename, duplicate, delete, import, backup, restore
  components/
    app/
      TitleBar.tsx     custom title bar (pin, drag, native window controls)
      BrandCard.tsx    branding where the desktop shell is absent
      FrameRate.tsx    the frame-rate readout
    primitives/
      Icon.tsx         one Lucide icon, drawn as a native canvas path
      icon-shape.ts    Lucide icon nodes as one SVG path
      panel.ts         the floating-panel chrome recipes
    canvas/
      FlowCanvas.tsx   the canvas: world-space cards and edges, gestures
      port-visuals.ts  the icon and theme token a port type uses everywhere
      selection/
        SelectionFrame.tsx   the multi-card selection frame
        SelectionOverlay.tsx selection borders, resize handles and the marquee
        SelectionPorts.tsx   the frame's typed group ports
        selection-visuals.ts its outline and wash
      editing/
        InlineTextEditor.tsx the screen-space text editor
        UploadButton.tsx     the upload card's Upload/Replace pill
      controls/
        NodeToolbar.tsx      floating add-node buttons
        ZoomControls.tsx     zoom in / out / fit
      feedback/
        PortTooltip.tsx      the hovered port's bubble
      context-menu/
        CanvasContextMenu.tsx the right-click menu
        CanvasMenuLayer.tsx   its page-mounted popup layer
      world/
        FlowCard.tsx         one card: title, status, body, ports
        FlowEdges.tsx        every connector, stroked as one native-canvas layer
        FlowPreviews.tsx     the pulled connection previews
        GridBackground.tsx   the dot-grid backdrop
        Port.tsx             one typed port, drawn as a native view
        ConnectorCanvas.tsx  the native canvas both connector layers share
        connector-layer.ts   its position/size/origin mapping
    composer/
      ComposerSheet.tsx  the shared prompt sheet both node kinds mount
      TextComposer.tsx   the text node's prompt, model and counter
      ImageComposer.tsx  the image node's prompt, model and image settings
      ComposerAttachments.tsx the sheet's add-image button and inputs
      ComposerFooter.tsx the sheet's variant controls and send button
      ComposerInputTile.tsx one attached image with its remove control
      ComposerModelSelect.tsx the model picker both sheets share
      detail-view.ts     the failure line and input URL helpers
    minimap/
      MiniMap.tsx        the document silhouettes and the camera's viewport
      MinimapDragOverlay.tsx the full-canvas capture during a drag
    search/
      SearchButton.tsx   floating search entry point
      SearchPalette.tsx  debounced full-text search, filters and result navigation
      search-filters.ts  the palette's one type filter definition
    probes/
      CanvasProbe.tsx    the selection and composer state a test reads
      ImageLoadProbe.tsx the last image event a test reads
      ZoomProbe.tsx      the camera scale a test reads
  flow/
    document/
      index.ts         the area facade: lifecycle, sessions and loaders
      assets/          asset URLs, preview and minimap loaders
      commands/        node/edge commands and the upload source
      lifecycle/       database path, document session and the seed
      session/         the node session, inline editor and composer reload policy
      test/            the native-test harness
      viewport/        the camera and viewport read loop
    composer/
      composer-state.ts the composer's settings draft
      placement.ts     the native composer's placement
    execution/
      runner.ts        starts and cancels one run per node
      providers.ts     the mock text/image providers and cancellation
    minimap/
      minimap.ts       the panel's world-to-panel mapping
      minimap-controller.ts the minimap drag state
    nodes/
      node-kinds.ts    the node kinds: ports, settings and model catalogs
    projects/
      index.ts         the area facade
      project-store.ts the native ProjectStore adapter
      project-session.ts the open-project lease
      project-list.ts  the frozen list order, status copy and relative time
      projects-root.ts the managed-root launch choice
    canvas/
      index.ts         the area facade: the model and geometry other areas use
      geometry/        connection curves, edge clipping, grid and preview cells,
                       selection handles, tooltip and culling math
      model/
        camera.ts      infinite-canvas camera (pan, zoom, fit)
        cursor.ts      the canvas cursor type
        edge-layer.ts  the connector canvas box
        scene/         the headless scene model, its record equality, ports and
                       reader types
        cards/         card content, geometry, layout, image events and the
                       inline editor's body anchor
      interaction/     the pointer router, connector/edge/hover gestures, the
                       context menu, resize handles and the selection frame
    shared/            the shared kernel: geometry, equality, DTO factories
  native/              mixed NSH Rust crate (SQLite/FTS5/RTree document core)
    Cargo.toml
    src/lib.rs         exports the @flow/native Document class
    src/db/mod.rs      database handle and command wrappers
    src/db/worker.rs   worker thread, connections, WAL and SQLite URLs
    src/db/open.rs     open entry points and managed package open
    src/db/session.rs  close, recovery state, saved view and live title
    src/db/verify.rs   integrity check and repair
    src/db/undo.rs     undo/redo and history helpers
    src/db/metadata.rs counts, bounds cache and emptiness
    src/entity/        SeaORM entities, one file per table
    src/schema/        frozen v1 DDL, open guard, package and maintenance
    src/mutation/      command families (nodes, edges, inputs, manual, runs,
                       seed, apply) with shared support and tx helpers
    src/rows.rs        Model → summary conversions shared by reads and writes
    src/search.rs      FTS5 search and the short-query fallback
    src/viewport.rs    RTree viewport reads
    src/scene.rs       visible nodes + edges, and document bounds
    src/history.rs     reversible undo/redo operations
  assets/              icons and images (imported by modules)
lint/
  boundaries.js        Oxlint JS plugin: dependencies flow down
scripts/
  package.mjs          installer build
  dev.mjs              dev host launcher with a persistent projects root
                       (FLOW_DB_PATH opens one legacy document instead)
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
flow down only (`src/App.tsx → pages → components → flow`), only the shell and
pages import the store, its signals stay private behind functions, and tests
normally sit beside the code they test.

## Documentation

- [Architecture](docs/architecture.md) — the layers, the native canvas, input
  and rendering.
- [Conventions](docs/conventions.md) — naming, imports, types, styling,
  comments and the checks that enforce them.
- [Testing](docs/testing.md) — headless vs host tests, the helpers, and what
  to test.
- [Packaging](docs/packaging.md) — installers, icons and signing per OS.
