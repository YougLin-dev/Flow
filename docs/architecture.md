# Architecture

Flow is an NSH app: NSH owns the window, the view tree, input, theming and
packaging. Leafer owns one thing — the canvas scene — and `leafer/` adapts it
to NSH's recording `Canvas`. Everything else composes those two.

App paths in this document are relative to `src/`, the NSH application root:
`src/App.tsx`, `src/nsh.json`, `src/theme.json` and `src/assets/` live
together, while the repository root holds `package.json`, `vite.config.ts`,
`tsconfig.json`, `scripts/`, `lint/`, `docs/` and CI.

## Layers

```
App.tsx                     app shell: title bar + page, nothing else
 ├─ pages/FlowPage.tsx      the workspace: camera, editor, input, overlays
 │   ├─ components/*        presentational controls (props only)
 │   ├─ flow/*              the scene: data, Leafer shapes, grid backdrop
 │   ├─ leafer/*            the canvas host, adapter and camera
 │   └─ store.ts            shared state behind readers and actions
 ├─ components/TitleBar.tsx window chrome (props only)
 ├─ store.ts                pinned state
 └─ tool.ts                 the Tool union shared by the store and controls
```

Dependencies point down only. `store.ts` and `components/` never import a
page or the shell; pages never import one another's internals. Shared state
crosses pages through `store.ts` — currently there is one page, but the rule
keeps the door open for more without rewiring. The `boundaries/no-upward-import`
Oxlint plugin (`lint/boundaries.js`) reports a violation while linting.

The app deliberately has no `NavStack`: a single-window canvas has nowhere to
navigate, so the shell mounts `FlowPage` directly. If a second page appears
(settings, a project list), wrap the pages in `createNavStack<Route>()` and
render them through `<NavStack>`; the page files and the store stay as they
are.

## Native document core

`src/native/` is a Rust crate in NSH's mixed-app mode. It owns the document
database, commands and undo, full-text search, viewport queries and asset
metadata. TSX imports its generated API from `@flow/native`; it must not open
SQLite or write SQL. Leafer stays in TSX and continues to own the scene,
editor, camera and input.

- `src/nsh.json` declares `"rust": "native"`; `App.tsx` remains the app entry.
- The database is SQLite with WAL, FTS5 (trigram tokenizer) and an RTree
  viewport index. Node, FTS and RTree rows change in one transaction.
- Ordinary tables are SeaORM entities; SeaQuery builds dynamic filters and
  joins. Only the FTS5/RTree virtual-table adapter (`schema.rs`/`search.rs`)
  contains static SQLite SQL.
- Database work runs on NSH's blocking pool, then through a handle to one
  dedicated database worker thread. That thread owns the connection, which
  keeps the single-writer design and avoids sending SeaORM's sync Rusqlite
  connection across threads.
- `FlowPage` opens the document at `host.params.databasePath`, then
  `FLOW_DB_PATH`, then `process.dataDir/flow.db`, falling back to `:memory:`
  in headless tests. `bun run dev` sets `FLOW_DB_PATH` to `.nsh/dev/flow.db`,
  so development data survives restarts; `src/nsh.json` grants exactly that
  one environment variable. An empty document is seeded from the demo flow.
- `FlowScene` is driven from `scene(rect, margin)` snapshots. Drag/resize,
  add, delete and connect each send one command; undo/redo return change sets.
- Viewport reads are throttled to 80 ms and capped at low zoom (300/800/2000
  cards); selected cards stay in the scene when they leave the viewport.
  Nodes inside `rect` sort before margin-only nodes so prefetching cannot
  consume the budget, and a deterministic hash of the internal sequence
  spreads a capped low-zoom sample across the rectangle instead of one
  insertion strip. `bounds()` serves Fit without reading every node into TSX.
- The search palette (`components/SearchPalette.tsx`) is mounted only while
  open. It debounces input, calls `Document.search` with the selected kind
  filter, and renders FTS snippets; opening a hit calls `getNode(id)`, fits
  the camera to that card, reads the viewport and selects it. Its arrow-key
  bindings live with the mounted palette, so canvas shortcuts return when it
  closes.
- The decision and the phased migration are recorded in
  [ADR 0002](adr/0002-rust-document-core.md),
  [ADR 0003](adr/0003-orm-seaorm.md) and
  [the Rust core plan](plans/rust-core.md).

## State

`store.ts` keeps its signals private and exports readers (`currentTool()`,
`zoomPercent()`) and actions (`setTool`, `togglePinned`). A page reads a
reader where the value is displayed; NSH tracks that read and updates only
the binding. Nothing writes another page's local state.

State that belongs to one mounted page stays there: `FlowPage` owns the
`CanvasCamera` and the Leafer `IEditorBase`, because they live and die with
the canvas. Values the chrome and overlays share (tool, zoom label,
selection count, window pin) move to the store. `App` binds the store's
`isPinned`/`togglePinned` into `TitleBar`, so the component stays reusable.

## The canvas host

`LeaferView` is an NSH `<Canvas>`. On the first `draw` it builds a Leafer
`App` over an `NshCanvasSurface`; every frame after that replays Leafer's
drawing onto the NSH context. `App` stacks three layers:

- `tree` — the scene built by `flow/scene.ts` (cards, images, edges),
- `sky` — Leafer's editor (selection box and handles),
- the app itself — composites the two.

The editor gets its own layer so its handles never take part in scene hit
testing and box selection can start on empty canvas.

### The platform adapter

`leafer/nsh-platform.ts` makes Leafer believe it runs in a browser. The file
is the adapter's public facade; `leafer/platform/` holds the implementation,
split by responsibility:

| Module                  | Responsibility                                              |
| ----------------------- | ----------------------------------------------------------- |
| `geometry.ts`           | points, matrices, clamping                                  |
| `path.ts`               | path recording and curve flattening                         |
| `hit-test.ts`           | winding/stroke tests and recorded hit regions               |
| `paint.ts`              | gradient and pattern records                                |
| `snapshot.ts`           | offscreen canvas snapshots                                  |
| `replay.ts`             | replaying recorded operations onto NSH's context            |
| `recording-context.ts`  | the Canvas 2D context Leafer draws through                  |
| `canvas.ts`, `op.ts`    | context/gradient types and recorded-operation shape         |
| `measure.ts`            | text measurement through the frame's native context         |
| `surface.ts`            | the canvas element Leafer creates offscreen and on the view |
| `host.ts`               | Platform/Creator installation, frame host and pointer data  |
| `frame.ts`              | Leafer's hidden per-frame render-mark reset                 |
| `image.ts`, `values.ts` | image URLs/density and narrowing helpers                    |

- **Recording context.** `NshCanvasSurface` is a canvas whose 2D context
  records every call (`[0, property, value]` / `[1, method, ...args]`).
  `replayOps` replays them onto the real NSH context, translating the things
  NSH's canvas lacks: gradients, patterns (clipped and tiled by hand), and
  offscreen canvases (snapshotted as vectors).
- **Hit testing.** Hit canvases record path geometry in JS instead of pixels;
  `isPointInPath`, `isPointInStroke` and `getImageData` answer from that
  geometry (polygons, stroke distance, winding).
- **Platform hooks.** `Platform.origin` creates canvases, loads images and
  content; `Platform.requestRender` schedules an NSH frame; `Creator` builds
  Leafer's canvas and interaction without a DOM; `devicePixelRatio` is 1
  because NSH draws in points.
- **Assets.** `loadImage` divides pixel sizes by the `@2x`/`@3x` in an asset's
  file name (or by the screen ratio for remote images), so the scene works in
  points like the rest of the app.

The recording is deliberately a subset: unsupported calls are skipped, never
crashed. Anything new that Leafer starts calling has to be added to the
matching `platform/` module, with a test in `leafer/nsh-platform.test.ts`.

### Frames

Leafer marks itself dirty and calls `Platform.requestRender`; the view
coalesces that into one `requestAnimationFrame`. NSH then calls `draw`, which
begins a fresh recording, draws the backdrop, asks Leafer for a full frame,
replays it, and clears Leafer's per-frame render marks. Clearing the marks is
what lets the next change ask for another frame — otherwise Leafer believes
its frame is still pending. There is no browser loop: every NSH frame is a
full frame, and Leafer's culling keeps off-screen work near zero.

## Camera and scene

The scene is built once in world coordinates. `CanvasCamera` wraps the group
that contains it and exposes `x`, `y`, `scale`, `toWorld`, `toScreen`,
`panBy`, `zoomAround` and `fit`. Moving the camera moves that group; Leafer
culls what falls outside the canvas.

The dot grid is not part of the scene: `flow/grid.ts` draws it in screen
space before the replay, using the camera transform and spacing that adapts
to zoom (dots stay 36–72 points apart). The scene itself uses theme tokens
through `token()`. Leafer nodes keep the values they were built with, so
`FlowPage` tracks `colorScheme()` and calls the scene's `recolor()` when the
system appearance changes; that repaint also asks Leafer for a frame, which
redraws the grid with the new tokens.

Adding a scene element means extending `flow/data.ts` and `flow/scene.ts`, not
the adapter. Crop or move things in world coordinates; the camera takes care
of the rest.

## Input

`LeaferView` feeds NSH's press/mouse/touch events into Leafer's interaction
with `pointerData()`:

- **Select** — presses go to Leafer (selection, drag, resize, Shift multi-
  select, box select on empty canvas). Cursor state mirrors what Leafer
  would show (`grab`, `move`, resize handles).
- **Hand** — presses pan the camera here; Leafer never receives the press, so
  no accidental selection happens.
- **Touch** — one finger behaves like the current tool; two fingers pinch-zoom
  around their center and pan with it.
- **Touch vs mouse** — platforms with both send mouse events alongside touch
  events; the view ignores those until shortly after the touches end, and
  carries modifier keys from whichever event has them.

Keyboard commands live on the page (`keymap.bind`): `mod+=`/`mod+-`/`mod+0`
zoom and fit, `v`/`h` switch tools, arrows pan, Escape cancels the editor.
Each command exists once.

## Window chrome

`lib/window-chrome.ts` hides the native title bar and reserves its height.
`TitleBar` draws the app name and pin button and reports the space the system
controls occupy through `titleBar()`, so the drag region and buttons never sit
under the traffic lights or caption buttons. The pin button calls the store,
which calls `Window.setLevel("floating" | "normal")`.

Where `nsh/desktop` is unavailable (tests and non-desktop hosts), the title
bar is not mounted and `FlowPage` shows `BrandCard` instead, so the same app
code runs in the headless test engine.

## Sandbox

`src/nsh.json` declares `capabilities.network.hosts: []`: the app reads its
own bundled assets (`asset:` is always allowed) but may reach no remote host.
NSH denies every capability not listed, so a new integration that fetches or
loads a remote image must add that host deliberately. Adding the
`capabilities` key is what changes the app from unrestricted to allow-list;
keep it in place.

## Extending

- **A new page** — one file in `pages/`, mounted by `App.tsx` (or a nav stack);
  share state through `store.ts`, never through another page.
- **A new control** — a component in `components/` that takes values and
  callbacks as props; the page binds them to the store.
- **A new canvas feature** — first check whether Leafer supports it; then map
  its platform needs into the matching `leafer/platform/` module (the facade
  stays `leafer/nsh-platform.ts`) and add a test. Keep hand-written input
  minimal: extend the adapter and Leafer's editor instead of drawing
  interactions by hand.
