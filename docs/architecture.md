# Architecture

Flow is an NSH app. NSH owns the window, the view tree, input, theming and
packaging; the canvas is a native view tree, so cards, connectors, selection
and the composer are ordinary NSH views rather than a drawn surface. A Rust
document core supplies only the nodes and edges the viewport needs. Everything
else composes those three.

App paths in this document are relative to `src/`, the NSH application root:
`src/App.tsx`, `src/nsh.json`, `src/theme.json` and `src/assets/` live
together, while the repository root holds `package.json`, `vite.config.ts`,
`tsconfig.json`, `scripts/`, `lint/`, `docs/` and CI.

## Layers

```
App.tsx                     app shell: title bar + page, nothing else
 ├─ pages/flow/FlowPage.tsx the page: workspace, effects and render
 │   ├─ pages/flow/workspace/* the workspace object, actions and effects
 │   ├─ components/*        presentational views and the canvas surface
 │   ├─ flow/*              node kinds, execution, scene, camera, gestures
 │   └─ store.ts            shared state behind readers and actions
 ├─ components/app/TitleBar.tsx window chrome (props only)
 └─ store.ts                zoom, selection count and pinned state
```

Dependencies point down only. `store.ts` and `components/` never import a
page or the shell; pages never import one another's internals. Shared state
crosses pages through `store.ts` — currently there is one page, but the rule
keeps the door open for more without rewiring. The `boundaries/no-upward-import`
Oxlint plugin (`lint/boundaries.js`) reports a violation while linting.

Inside those layers, code is grouped into **areas** with one `index.ts`
facade (`flow/canvas`, `flow/document`, `components/canvas`,
`components/composer`), and each area uses the reserved segments
`geometry/`, `model/`, `interaction/` and `test/` or a part folder named
after its job. The area map, allowed imports and owners are in
[code-map](code-map.md); the decision is
[ADR 0007](adr/0007-code-organization.md). The canvas is explicitly layered
`geometry → model → interaction → views → page`, with `FlowScene` still the
one state and batch owner. The shared kernel, the `flow/` areas, every
component area and the `pages/flow` page area use the area layout;
`pages/flow/workspace/` is the page's part folder. No module remains at the
`components/`, `flow/` or `pages/` root. [The plan](plans/code-organization.md)
holds the old → new map. New files follow the area rules; the structure report
fails a new module at those roots.

The app deliberately has no `NavStack`: a single-window canvas has nowhere to
navigate, so the shell mounts `FlowPage` directly. If a second page appears
(settings, a project list), wrap the pages in `createNavStack<Route>()` and
render them through `<NavStack>`; the page files and the store stay as they
are.

## Native document core

`src/native/` is a Rust crate in NSH's mixed-app mode. It owns the document
database, commands and undo, full-text search, viewport queries and asset
metadata. Only `flow/document` and `flow/projects` may call the generated API
from `@flow/native` at runtime; every other TSX module must import the types
through `flow/shared/native-types.ts`. TSX must not open SQLite or write SQL.
The canvas stays in TSX and owns only the scene model and its views.

- `src/nsh.json` declares `"rust": "native"`; `App.tsx` remains the app entry.
- The database is SQLite with WAL, FTS5 (trigram tokenizer) and two RTree
  viewport indexes: node bounds and connector curve bounds. Node, edge, FTS
  and RTree rows change in one transaction.
- Schema v1 is frozen in `schema/v1.sql`: one project package is one SQLite
  file with a singleton `document` row (project id, rev, counts, bounds,
  camera) and its content-addressed `assets/` directory. The opener checks
  `application_id` and `user_version` and refuses foreign, older or newer
  files before writing anything; pre-release development databases are reset,
  not migrated. The v1 triggers own the node/edge counts, bounds, FTS and
  RTree rows, and the core stores immutable result batches/items and ordered
  node inputs. Its commands cover settings, manual text, connect/reconnect,
  input changes, runs and crash recovery.
  [The node editor contract](node-editor.md) records the data model and
  semantics; [the database design](plans/database-design.md) records the
  frozen schema.
- Ordinary tables are SeaORM entities; SeaQuery builds dynamic filters and
  joins. Only the FTS5/RTree virtual-table adapters (`schema/v1.sql`,
  `schema/maintenance.rs`, `search.rs`, `edge_index.rs`) contain static
  SQLite SQL.
- Database work runs on NSH's blocking pool, then through a handle to one
  dedicated database worker thread. That thread owns the connection, which
  keeps the single-writer design and avoids sending SeaORM's sync Rusqlite
  connection across threads. The in-memory undo/redo history lives in the same
  worker and is updated inside each command's job, so history order always
  matches write order.
- The app starts on the project list when it has a managed root, chosen in
  this order: `host.params.projectsRoot`, `FLOW_PROJECTS_ROOT`, then
  `<dataDir>/projects`. An explicit document path (`host.params.databasePath`
  or `FLOW_DB_PATH`) keeps the legacy single-document canvas for that launch;
  the legacy path falls back to `process.dataDir/flow.db`, then `:memory:` in
  headless tests. `bun run dev` points `FLOW_PROJECTS_ROOT` at
  `.nsh/dev/projects`, so development data survives restarts and the dev host
  opens on the project list; an explicit `FLOW_DB_PATH` still selects the
  legacy document. `src/nsh.json` grants exactly those path variables and
  `FLOW_FPS`. A new, unseeded legacy document is seeded from the demo flow in
  one transaction; a managed project makes that decision at creation (a blank
  project records `demo_seeded=1`), and the `demo_seeded` flag keeps an
  emptied project from being reseeded. The v1 guard deliberately refuses a
  pre-v1 development database: before the first launch of this build, delete
  `.nsh/dev/flow.db` (and its `-wal`/`-shm` files) and `.nsh/dev/assets`.
- The package records its lifecycle. On quit the workspace stops in-flight
  runs (their batches settle cancelled), then saves the camera and
  checkpoints in one `closeWithView` job: the WAL is checkpointed,
  `clean_shutdown` is set and the file is released before the call resolves.
  A close marks the database closing: a read still in the worker queue is
  skipped and answered with "the database is closed" without touching
  SQLite, while a command accepted before the close request still runs in
  FIFO order, so a quit neither waits for stale reads nor drops an accepted
  write. The recovery state starts as `!openedClean`, the verify job stores
  its outcome on the worker, and the close job reads it there, so a failed
  verify keeps the next open due for recovery even when the user quit after
  it. `projectInfo` reports the flag the package had before this open; a
  `false` (unclean) value schedules `verify()` once the first scene read has
  settled and the shell has been responsive briefly, while a new or cleanly
  closed package does no integrity scan. `verify()` runs SQLite's integrity
  and foreign-key checks, compares and rebuilds the FTS index and both
  RTrees when they drifted, flushes leftover connector markers and compacts
  the document bounds. It checks for a pending close between its phases and
  aborts; a phase already running still holds the worker until it ends, so a
  quit that lands mid-phase can exhaust the shell's 200 ms quit budget. That
  exit leaves `clean_shutdown=0`, which the next open already treats as an
  unclean package. Open also runs one collection command before the first
  read: with the undo history empty it deletes terminal batches no node
  outputs, no input snapshots and that are not the newest batch of a live
  node incarnation, then unreferenced asset rows, then asset files with no
  row (after the row transaction commits, so a rollback can never leave a
  live row without bytes; a directory that resolves outside the package is
  never swept). The command refuses while history holds an entry; a sweep
  failure is reported but does not block the open. A saved camera is
  restored instead of fitting. The frozen schema has no saved-view marker,
  so the `0, 0, 1` default is the never-saved sentinel; a view saved at
  exactly that value is indistinguishable and refits.
- `FlowScene` is driven from `scene(rect, margin)` snapshots. Drag/resize,
  add, delete and connect each send one command; undo/redo return change sets.
  A card is stored as an axis-aligned world rectangle, so gestures commit a
  rectangle, never transformed bounds.
- Viewport reads are throttled to 80 ms and capped at low zoom (300/800/2000
  cards); selected cards stay in the scene when they leave the viewport.
  A connector is read when either of its cards is loaded; a complete read
  also reads the ones whose cubic box intersects the viewport, so a curve
  crossing the visible area stays drawn when both its cards are beyond the
  read. The read fetches one row past its card budget: a truncated low-zoom
  read (300/800/2000 cards) skips that second half, because its RTree
  matches can exceed the card budget, while a read that exactly fills its
  budget did not drop a card and keeps crossing connectors. The crossing
  half is itself capped at 4,000 connectors; above the cap the retained
  subset follows the index's physical order and can change after a geometry
  flush, while the response order stays by edge id. Every read edge carries
  both endpoint ports; the far cards are not instantiated as views. A selected
  card pinned in the scene keeps its connectors even when a read omits them,
  so a mid-drag read, which sees only committed geometry, cannot blank the
  line. The connector index (`edge_index.rs`) is maintained in the same
  transaction as every edge write and every node move, resize or undo, and
  mirrors the UI's `connectionBounds` in
  `flow/canvas/geometry/connection.ts`. The RTree cell is only a prefilter:
  it is padded and 32-bit, so the exact f64 rectangle decides membership and
  the in-view ordering and rounding cannot add or promote a card outside the
  read. Nodes inside `rect` sort before margin-only nodes so prefetching
  cannot consume the budget, and a deterministic hash of the internal
  sequence spreads a truncated low-zoom sample across the rectangle instead
  of one insertion strip. `bounds()` serves Fit without reading every node
  into TSX.
- The search palette (`components/search/SearchPalette.tsx`) is mounted only while
  open. It debounces input, calls `Document.search` with the selected kind
  filter, and renders FTS snippets; opening a hit calls `getNode(id)`, fits
  the camera to that card, reads the viewport and selects it. Terms of three
  or more characters use the FTS index; shorter terms are `LIKE` post-filters
  on a mixed query, and an all-short query falls back to a capped scan of at
  most eight terms. Its arrow-key bindings live with the mounted palette, so
  canvas shortcuts return when it closes.
- The project layer sits above packages. A managed root
  (`<dataDir>/projects`) holds self-contained `<project_id>/` directories
  (`project.db` plus `assets/`), a rebuildable `catalog.json`, and
  `.locks/`. Packs become visible by one rename of a fully written temp
  directory; delete renames into `.trash-*` before purging; duplicate and
  import snapshot with `VACUUM INTO` and verify every asset hash before the
  commit rename, and mint an identity when the source's is taken. The catalog
  is derived and validated strictly (root-relative 32-hex paths only); any
  doubt rebuilds it from the directories, unreadable packages and packages
  whose document identity disagrees with their directory stay visible as
  fallback rows keyed by the directory, and a valid catalog is reconciled
  without reopening readable known packages (a fallback row or one whose
  identity disagrees with its directory is re-read on every list, and an
  explicit catalog refresh reopens them all). The lock lives in `<root>/.locks/<id>.lock`, not inside
  the package, because Windows refuses to rename a directory while any
  handle inside it is open; its owner is the OS lock, so process death
  frees it and no stale-lock protocol exists. `ProjectStore` hands out one
  `ProjectLease` per window; the workspace opens that lease's
  `databasePath` with `Document.openPackage(path, projectId)`, which refuses
  a missing or empty file without creating it and marks the package dirty
  only after the document identity matches. A close that fails before its
  job runs keeps the lease: a leaked lock is better than two writers. A
  close that ran but could not checkpoint (the recovery-warning marker)
  releases it — the worker dropped its connection and the dirty package
  verifies on the next open. The lease is released after the document
  worker acknowledged the close. A managed project's
  seed decision is made at creation (`demo_seeded=1` when created blank),
  and a managed open (one with a project id) defaults `seedDemo` to false,
  so an imported empty package is not filled in later. Delete needs only a
  real package directory under its lock, not a readable identity, so
  fallback rows remain removable; rename and duplicate still require the
  identity. Rename is closed-package only in this slice, changes only
  title/`updated_at`, and never moves the directory;
  imports accept an unpacked package directory, not an archive; pre-v1
  packages are refused rather than migrated. The app starts on the projects
  screen (`pages/projects`) when it has a managed root: the list shows
  recency, an open-in-another-window badge and unreadable fallback rows, and
  creates, renames, duplicates, deletes and imports projects through the same
  store (rename and duplicate are hidden for an unreadable row; delete stays
  available so a damaged package can be removed). Opening a project hands
  its lease to the flow workspace, which closes the document before releasing
  the package; the canvas's leading `Projects` control returns to the list,
  and the window title bar names the open project. A catalog watch policy and
  zipped-package import remain.
- The decision and the phased migration are recorded in
  [ADR 0002](adr/0002-rust-document-core.md),
  [ADR 0003](adr/0003-orm-seaorm.md) and
  [the Rust core plan](plans/rust-core.md). The canvas itself is
  [ADR 0004](adr/0004-native-view-canvas.md).

## Node editor

M1 adds one generic executable node shape: several named, typed input and
output ports, and many-to-many directed connections carrying typed text and
image items. A TSX kind registry (`flow/nodes/node-kinds.ts`) declares each kind's
appearance, per-input capacity, defaults and settings schema, and resolves
each node's ports from its settings (`portsOfNode`); `flow/execution/` owns
the provider for a runnable kind. An upload node has no inputs and derives
one output per media kind it holds, so its output port appears with its
first upload. Rust stores only `kind`, opaque `settings_json`, the immutable
result batches and the assets.

- A connection binds one output port to one input port; only ports of the
  same item type can join. Connecting snapshots the source items whose
  `portId` matches the edge's output port into the target's matching input
  port. Reconnecting rebuilds that snapshot, and deleting an edge removes
  exactly the inputs it contributed; a local upload can be deleted without
  deleting its edge.
- An input port declares how many incoming edges it accepts (a prompt one,
  the image references up to 4 or 16 by kind). A gesture is rejected whole
  when any proposed edge would overflow a port; no partial fan-out is
  written. Parallel edges between two cards are legal when their ports
  differ, and one port pair appears at most once.
- Result batches and their items are immutable. A rerun or manual text edit
  appends a batch and moves the node's output; old batches remain for
  downstream snapshots. Provider runs are not undo history, while connect,
  delete, input and manual-text edits are. A run invalidates pending history
  on the nodes and batches it touches, including direct downstream targets
  with an output, so undo never restores an older output or input snapshot
  over the run.
- Statuses are `idle`, `stale`, `running`, `done`, `failed`, `cancelled` and
  `interrupted`. A changed upstream marks an existing downstream result stale;
  startup turns abandoned runs into `interrupted`.
- The native canvas draws cards, typed ports, connectors and the connection
  preview. Ports are circles in the item type's color and icon, spread evenly
  over each card side like `justify-evenly`; a hovered port springs a few
  points toward the pointer while its connector anchor (the icon's centre)
  stays fixed, so a line meets the port circle rather than the card's border.
  A press on a port starts a connection from that specific port. Selecting a
  card opens its composer (`TextComposer` or `ImageComposer`, both mounted
  through the shared `ComposerSheet`), a native panel anchored directly under
  the card and centred on it; the placement follows the card and never flips or
  clamps to stay inside the viewport. A text node's sheet is chat-style: an
  add-image button and the node's image inputs on top, the prompt with its
  character counter below, then the model select (DeepSeek V4.1 Flash, the
  design's default, or the mock) and a round send button; its generated text
  appears on the card, never in the sheet. The image node's
  sheet is the same: its image inputs on top, the prompt below, and a model
  select, an aspect/resolution panel, a count select and a round send button
  in the bottom row; its images appear on the card. Both are built from the same controls
  as the rest of the app. A double-click edits a text card in place: a borderless
  input takes the body's own inset, size, type and line height, laid out at
  world type and scaled around the body's screen origin, so its font,
  wrapping and box match the card's text exactly at every zoom. Image cards
  and uploads with images show a thumbnail grid; an upload without an output
  shows its upload empty state.
- Mock text and mock image providers exercise the run lifecycle and the
  provider seam. See [the node editor contract](node-editor.md) for the full
  M1 rules and non-goals.

## State

`store.ts` keeps its signals private and exports readers (`currentTool()`,
`zoomPercent()`) and actions (`setTool`, `togglePinned`). A page reads a
reader where the value is displayed; NSH tracks that read and updates only
the binding. Nothing writes another page's local state.

State that belongs to one mounted page stays there: the page's workspace
object (`pages/flow/workspace/flow-workspace.ts`) owns the `FlowScene`, the
`CanvasCamera`, the `CanvasController`, the stage size and the document
session, because they live and die with the page. Values the
chrome and overlays share (zoom label, selection count, window pin) move to
the store. `App` binds the store's `isPinned`/`togglePinned` into
`TitleBar`, so the component stays reusable.

## The canvas

`FlowCanvas` is one native view with `testID="flow-canvas"`. It reads pointer
events and renders these layers:

- **Grid** — a tiled dot-grid background in screen space, regenerated with the
  current `grid-dot` token when the appearance changes.
- **World** — a zero-size view translated and scaled by the camera
  (`transform: translate(x, y) scale(s)`, origin `0 0`). Its children are in
  world coordinates: one `FlowEdges` canvas for every connector, the selection
  frame and a `FlowCard` per visible node. The camera's transform is the only
  mapping from world to screen; the scene never caches screen geometry on a
  card. The world takes no pointer events, so its chrome never holds a press;
  the interaction surface above it owns canvas gestures. The selected upload
  card's own button lives instead in a world-point controls layer above that
  surface, so it is the one native control here that takes a press. The frame draws above every selected card, so its neutral outline and
  wash cover the whole swept group; only its group ports and a pulled
  connector stay above it. Its padding clears the cards' ports, and its
  border is divided by the camera's scale to stay one screen point wide. The frame exists only for a marquee that ends
  with more than one card: a single card is selected as a press selects it,
  with no frame of its own. A press anywhere inside the frame—on empty space
  or a card border—drags the whole selection and shows the move cursor; a
  press outside it starts a new marquee, and a press on a card's own port
  still starts that card's connection. A multi-card frame adds one group port
  per distinct input type on its left and one per distinct output type on its
  right, alongside the cards' own ports. A group port represents
  every selected card's port of that type: dragging it pulls one preview per
  member and fans the connection out to the one external target port; a full
  member input disables the group port before the gesture starts.
- **Selection overlay** — the marquee box in screen space, derived from the
  controller each time the drag changes. It does not take pointer events. The
  box and the group frame above it keep the selection-gray outline and a faint
  foreground wash above the cards, tinting the swept or selected group. The cards
  the box covers take the selection ring, the lifted stacking and the lit
  connectors their selection will have while it sweeps, and the frame appears
  on release when the box selected more than one card. A selected card blends
  its one-point border into the body and draws a
  selection-gray ring outside it, so one outline frames the node instead of
  recoloring it. The card's border is the resize zone: corners scale
  proportionally and any point along an edge resizes that axis, with the
  cursor naming the side, so the card shows no handle dots.
- **Interaction view** — a transparent, full-size view above the world that
  owns the cursor and dispatches presses, moves and touches to the
  `CanvasController`. The canvas root listens with `onWheel`: NSH hands the
  nearest listener the mouse wheel and touchpad scrolls, so the root converts
  each one to notches and the page zooms about the pointer.
- **Upload controls** — a world-point layer above the interaction view,
  rendered only for the one selected upload card and `box-none` itself: only
  its native Upload/Replace button takes presses, so the camera scales the
  button with the card while every other point still reaches the canvas.

The minimap (`components/minimap/MiniMap.tsx`) is a screen-space panel rendered by
`FlowPage` beside `FlowCanvas`, not inside it, in the bottom-left corner and
desktop-only. It maps the union of the document's bounds and the camera's
visible rectangle into the panel, so the content and the view are always both
shown: pulling the view away from the content zooms the silhouettes down
instead of moving the viewport frame out of the panel. The silhouettes come
from `Document.overview()`, a coarse Rust read that samples at most 400 cards
by the insertion hash the viewport reads use (not by stacking), so it shows
cards outside the scene and costs one read per burst of geometry changes; the
panel never instantiates the whole document. A selected card's silhouette
takes the primary color and sits above the others, so the map shows what the
canvas has selected. Dragging anywhere in the panel
pans the camera by the pointer's movement (a press alone changes nothing); the
drag converts its deltas with the scale captured at press, so the map's own
rescaling cannot feed back into the drag. While a drag runs, a transparent
full-canvas surface above the page takes the pointer, so it may leave the
small panel and keep dragging; a pointer that leaves the window pauses the
drag but does not end it. The panel listens with its own `onWheel`, so the
wheel over it zooms the canvas about the viewport's center.

The canvas context menu (`components/canvas/context-menu/CanvasContextMenu.tsx`)
is a native-view
popup anchored at a secondary-button press: on empty canvas it adds a text or
image card at the pressed world point, on a card it copies or deletes the
pressed card, on a connector it deletes that connector, and it closes on a
primary press or Escape. Opening a card's menu selects that card (a card
already inside a multiple selection keeps the selection) without opening its
composer, and opening a connector's menu selects that connector, so the menu
visibly names what its items act on. A card under the press wins over a
connector drawn behind it. It is drawn from ordinary views rather than opened
with `Menu.popup`, because a system menu takes the pointer and would prevent
the right-button drag from panning;
`flow/canvas/interaction/context-menu.ts` wires the press, the pending press
a release opens, the dismissal when the camera or the pressed card or
connector moves away, and the item actions;
`flow/document/commands/node-commands.ts` performs the copy (writing an open editor's drafts
first) and delete commands.

`FlowCard`'s root carries the node's world position and lays its chrome out
in card-local points (`flow/canvas/model/cards/card-geometry.ts`). The rectangle reaches the card
as two memoized halves — position and size — so a drag wakes only the root's
`left`/`top` and a resize only the styles that read the size, instead of every
geometry-derived style on every pointer move. Its title, status and body come
from equality-gated values (`flow/canvas/model/cards/card-content.ts`), so a viewport read that
carries the same card wakes nothing; that keeps a zoom or pan from resubmitting
every visible card's text. The body's rounded background, border and shadow
are a childless plate under the content, so the Windows renderer can skip
that paint when it is outside the damage rectangle. The card renders the title and
status above the card, the body text or image thumbnails inside it (laid out
inside the body box), and one typed port circle outside each side, shown when
the card is selected, hovered, a connection target, or connected and readable
on screen. A multi-card frame keeps those per-card ports while they are
readable and adds the frame's group ports on its sides. Per-card selection and connection
target flags come from `flow/shared/keyed-flags.ts`, while `flow/canvas/interaction/hover-flags.ts`
separately holds the controller's hover and marquee-preview mirrors; their
source states write these flags in the same update round, so a change wakes
only the cards whose membership flipped. A port rests just outside the
border; when hovered it springs toward the pointer within a small reach in
both axes, and it springs back when the pointer leaves, while its connector
anchor — the icon's centre — stays fixed. A compatible port under a dragged
connector end leans out the same way inside its magnet field, and the
preview eases onto the leaned icon (`flow/canvas/geometry/connection.ts`). `FlowEdges`
strokes every connector's cubic from `flow/canvas/geometry/connection.ts` in one
native-canvas layer with round caps;
the canvas rasterizer draws at the transformed resolution, so the lines stay
smooth and sharp at every camera scale instead of showing sampled joints, and
there is no arrowhead. The canvas covers only the connector box clipped to the
camera's view plus a margin, and a connector that crosses the view is stroked
as the visible runs of its cubic (`flow/canvas/geometry/edge-clip.ts`), sampled against the
view's width: at 250% the stroked geometry stays about one screen long instead
of tessellating document-long curves that the clip would discard. A connector
rests faint, at a third of its port type's color; the clicked edge and every
connector touching a selected card are stroked one point thicker and fully
lit, so selecting a card or a line relights its connectors and nothing
animates while the board is idle. `CanvasCamera` owns the moving flag for every
pan, zoom and fit, settled by a 150 ms timer, for overlays that suppress
expensive work while the camera moves.
A selected card outside the camera's view stays in the scene for the group
frame and its connectors, but its view is fully transparent, so NSH skips the
card's paint subtree while its text stays in the accessibility tree.
The pulled connectors are one dashed `FlowPreviews`
canvas above the cards, holding one line per fixed end, so a group drag pulls
a line from every selected card. Both are presentational: props are
accessors, and the page passes scene signals to them.

The scene model (`flow/canvas/model/scene/scene.ts`) is headless: it holds the visible nodes and
edges, the selection, transient drag geometry (`overrides`, read per card so
a drag updates only the cards it moves and their connectors), previews, the
connection previews and the card a pulled connector would join, and answers
world-space hit questions (`nodeAt`, `edgeAt`); the typed-port queries
(`portAt`, `nearestPort`, `portOffsetAt` in `flow/canvas/model/scene/scene-ports.ts`) read it
through that surface. Selected cards stack above every unselected one in
selection order, so a pressed card comes to the front at once and a marquee
brings its whole group forward; the cards a marquee covers take their final
ranks while it sweeps, so the preview and the release share one stacking.
Hit testing uses the same depth, and the
connection previews stay above them all. A card under the pointer hides a
lower card's port, just as it hides the card itself.
`CanvasController` turns pointer events into commands: select/toggle, drag,
resize from a handle, marquee, the following port, and the port/edge
gestures; the secondary button's drag pans. `CanvasCamera` stores logical `x`, `y` and
`scale`; `panBy`, `zoomAround` and `fit` rebuild the view from those values.

The dot grid and the cards follow the camera, but the composer does not: its
position is computed in screen points from the selected card's current screen
rectangle (`flow/composer/placement.ts`), so it keeps its size at every zoom and tracks
the card. It sits directly below the card, centred on it, and is allowed to
extend past the viewport rather than move somewhere else. The inline editor
is the card body itself: a borderless input at the body's world inset, size
and type, anchored at the body's screen origin and scaled there by the
camera, so its text stays exactly where the static text was. A click on the
selected card leaves the
composer mounted, so its native input keeps its draft and caret. Once a card
is dragged or resized past a small movement threshold, or a connector is
pulled away from its press point, the composer hides so the gesture and its
target stay visible.

## Input

`FlowCanvas` feeds NSH's press, mouse and touch events into
`CanvasController`. NSH also reports a mouse press to the touch handlers, so a
single-pointer gesture starts from the press event — which carries Shift and
the click count — while the touch events drive its moves, release and a second
finger:

- **Pointer** — a press selects a card (Shift toggles), starts a drag when the
  press lands on a selected card, starts a resize when it lands near any
  visible card's border (a corner or anywhere along an edge; the press selects
  that card first), and starts the connector gestures on a typed port. A
  corner keeps the card's aspect ratio with the opposite corner fixed,
  scaling by the pointer's projection onto the card's diagonal, so passing one
  edge does not snap the card to its minimum. An edge resizes one axis. Ports
  take precedence over the resize handles they overlap. A press on empty
  canvas clears the selection and starts the marquee. A double-click on a
  text card opens its inline editor.
- **Touch** — one finger selects, drags, resizes, connects and box-selects as
  the pointer does; two fingers pinch-zoom around their center and pan with it.
- **Hover** — mouse movement updates the hovered card, the typed port whose
  icon follows the pointer, and a cursor that reflects any card's resize
  border or a port. A card under the pointer owns the hit: another
  card's border or port never reacts through it.
- **Wheel** — the mouse wheel and touchpad zoom about the pointer, four
  notches per doubling, clamped to the camera's scale range. NSH delivers the
  window's wheel to the nearest view listening with `onWheel`, so the pointer
  view owns the listener and converts a precise device's points to notches.
  Over the composer and the page's other chrome the page root hears it and
  zooms about the pointer; the minimap keeps its own listener and zooms about
  the viewport's center. A scroll view under the pointer wins, and a listener
  around one only observes: NSH still calls it while the view scrolls. A
  multiline field therefore listens itself (`keepsWheel` in
  `flow/shared/wheel.ts`), so the wheel scrolls the field and the page does not
  zoom as well; the open context menu keeps its own wheel the same way.
- **Secondary button** — holding the right button and dragging pans the
  camera, without selecting, starting a marquee or moving a card. A right click that stays put opens the context menu for what it pressed on the
  button's release: a card's copy/delete menu, a connector's delete menu, or
  the canvas's add-card menu. NSH reports the press through `onContextMenu`, the moves
  while it is held, and the release through `onMouseUp`: a press that never
  moved past the drag threshold opens its menu at the pressed point, and a
  drag never opens one. Over the composer, its dock and the minimap the page
  forwards the same gesture itself, because those views sit above the canvas
  overlay: a right drag there still pans, and a still press opens no menu. The menu is the app's own view rather than
  `Menu.popup`, so it never takes the pointer from the drag.

Navigation is the page's and object interaction is the canvas's. `FlowPage`
decides every pan and zoom (the camera is page state), so the page root
forwards navigation for its own views through `pages/flow/workspace/page-chrome.ts`; a view
that consumes or keeps the wheel declares its own listener instead.
Presses, hovers and the marquee stay on the canvas interaction view, because
they hit-test world geometry.

The page creates one workspace object (`pages/flow/workspace/flow-workspace.ts`)
synchronously in its body; that object owns the document session, scene,
camera, controllers and loaders, and its `dispose` runs in the page's cleanup.
`flow-effects.ts` supplies the selection, composer and menu-dismissal effects
the page registers, and `flow-actions.ts` the key-action set the page binds.

Keyboard commands are declared in `pages/flow/workspace/bindings.ts` (`bindFlowKeys`) and
bound once by the page: `mod+=`/`mod+-`/`mod+0`
zoom and fit, `mod+z`/`mod+shift+z` undo and redo, Delete/Backspace delete
the selected edge or cards, arrows pan, `mod+k` opens search, and Escape
dismisses the top layer (search, inline editor, selected edge, composer, then
the selection). The toolbar's Text and Image buttons add nodes. Each command
exists once.

Pointer gestures above the canvas: dragging an output port previews a
forward connection and an input port a reverse one; the preview is dashed
until the connection is written. A compatible port inside the dragged end's
magnet field (48 world points) leans its icon toward the pointer on the same
spring as a hovered port, and the preview eases onto it, so the field has no
snap threshold at its edge; releasing inside it joins the two. The target
card takes the accent border, and on leaving the field the icon and the
preview return smoothly to the pointer. A full input, a type mismatch and an
already-connected pair never highlight, and a still press on a port writes
nothing. Dragging either typed port of a selected edge's endpoints moves
that end (source or target). A multi-card frame shows one group port per
type on each side; dragging one
fans the connection out to every matching selected port (or connects the
target to every selected input). A press on a connector selects it;
double-clicking a text card opens its inline editor.

## Window chrome

`src/nsh.json`'s `window.titleBar` hides the native title bar before the
first frame (32 points, close to the system caption's height), so the
platform applies the app's own bar; the system keeps its window controls.
`TitleBar` draws the app name and pin button and reports the space the system
controls occupy through `titleBar()`, so the drag region and buttons never
sit under the traffic lights or caption buttons. While it renders — the only
time the window API answers — it sets the window's `level` from the `pinned`
prop to `"floating"` or `"normal"`; the pin button calls the store, which
flips that state.

Where `nsh/desktop` is unavailable (tests and non-desktop hosts), the title
bar is not mounted and `FlowPage` shows `BrandCard` instead, so the same app
code runs in the headless test engine.

## Sandbox

`src/nsh.json` declares `capabilities.network.hosts: []`: the app reads its
own bundled assets (`asset:` is always allowed) but may reach no remote host.
`capabilities.application` is granted because the app acts on its own main
window: the pin changes the window's `level`, and NSH gates every main-window
desktop command behind that capability (the hidden title bar itself is
declared in `window.titleBar`, which the platform applies at launch). Its
`capabilities.process.env` allow-list contains `FLOW_DB_PATH` and
`FLOW_PROJECTS_ROOT`, the development, test and smoke path overrides, and
`FLOW_FPS`, the frame-rate probe switch;
`capabilities.windows.levels` grants the `floating` level the pin sets on the
main window, and `capabilities.picker` is granted for local image uploads.
NSH denies every capability not listed, so a new integration that fetches or
loads a remote image must add that host deliberately. Adding the
`capabilities` key is what changes the app from unrestricted to allow-list;
keep it in place.

## Extending

Paths below are the post-migration homes. Until a move lands, Appendix A of
[the plan](plans/code-organization.md) maps the current file.

- **A new page** — `pages/<name>/` with its `index.ts` facade, mounted by
  `App.tsx` (or a nav stack); share state through `store.ts`, never through
  another page. Until a second page exists, the one page is
  `pages/flow/FlowPage.tsx`.
- **A new node kind** — add it to `flow/nodes/node-kinds.ts` (appearance,
  settings parsing, ports through its resolver), give it a provider in
  `flow/execution/providers.ts` if it runs, and extend
  `components/canvas/world/FlowCard.tsx` if the generic text/image body is
  not enough. Rust needs no schema change: `kind` and `settings_json` are
  opaque. A source kind that writes local output needs a command like
  `Document.setManualUpload`, which stores its batch, derived settings and
  body in one undoable transaction.
- **A new control** — a component in the owning area under
  `components/<area>/`; it takes values and callbacks as props, and the page
  binds them to the store.
- **A new canvas feature** — pure geometry in `flow/canvas/geometry/`, the
  model in `flow/canvas/model/`, gestures in
  `flow/canvas/interaction/`, and the view in `components/canvas/`. Add a
  unit test for the geometry or controller path and an app test flow when the
  user can reach it (a platform-sensitive one goes in `App.host.test.tsx`).
