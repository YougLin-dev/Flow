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
 ├─ pages/FlowPage.tsx      the workspace: document session, camera, overlays
 │   ├─ components/*        presentational views and the canvas surface
 │   ├─ flow/*              node kinds, execution, scene, camera, gestures
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
SQLite or write SQL. The canvas stays in TSX and owns only the scene model and
its views.

- `src/nsh.json` declares `"rust": "native"`; `App.tsx` remains the app entry.
- The database is SQLite with WAL, FTS5 (trigram tokenizer) and two RTree
  viewport indexes: node bounds and connector curve bounds. Node, edge, FTS
  and RTree rows change in one transaction.
- Schema version 2 is the node editor's breaking reset: the migration drops
  the version 1 document and recreates the tables (there is no data
  migration). Version 3 adds the connector index and fills it from the
  existing edges. The core also stores immutable result batches/items,
  ordered node inputs and content-addressed asset bytes under
  `<database dir>/assets/`. Its commands cover settings, manual text,
  connect/reconnect, input changes, runs and crash recovery.
  [The node editor contract](node-editor.md) records the data model and
  semantics.
- Ordinary tables are SeaORM entities; SeaQuery builds dynamic filters and
  joins. Only the FTS5/RTree virtual-table adapters (`schema.rs`, `search.rs`,
  `edge_index.rs`) contain static SQLite SQL.
- Database work runs on NSH's blocking pool, then through a handle to one
  dedicated database worker thread. That thread owns the connection, which
  keeps the single-writer design and avoids sending SeaORM's sync Rusqlite
  connection across threads. The in-memory undo/redo history lives in the same
  worker and is updated inside each command's job, so history order always
  matches write order.
- `FlowPage` opens the document at `host.params.databasePath`, then
  `FLOW_DB_PATH`, then `process.dataDir/flow.db`, falling back to `:memory:`
  in headless tests. `bun run dev` sets `FLOW_DB_PATH` to `.nsh/dev/flow.db`,
  so development data survives restarts; `src/nsh.json` grants exactly that
  one environment variable. An empty document is seeded from the demo flow.
- `FlowScene` is driven from `scene(rect, margin)` snapshots. Drag/resize,
  add, delete and connect each send one command; undo/redo return change sets.
  A card is stored as an axis-aligned world rectangle, so gestures commit a
  rectangle, never transformed bounds.
- Viewport reads are throttled to 80 ms and capped at low zoom (300/800/2000
  cards); selected cards stay in the scene when they leave the viewport.
  A connector is read when either of its cards is loaded or when the box
  around its cubic intersects the viewport, so it stays drawn while one card
  is beyond the read and also when both cards are beyond it but the curve
  crosses the visible area. Every read edge carries both endpoint ports; the
  far cards are not instantiated as views. A selected card pinned in the
  scene keeps its connectors even when a read omits them, so a mid-drag
  read, which sees only committed geometry, cannot blank the line. The
  connector index
  (`edge_index.rs`) is maintained in the same transaction as every edge
  write and every node move, resize or undo, and mirrors the UI's
  `connectionBounds` in `flow/connection.ts`. Nodes inside `rect` sort
  before margin-only nodes so prefetching cannot consume the budget, and a
  deterministic hash of the internal sequence spreads a capped low-zoom
  sample across the rectangle instead of one insertion strip. `bounds()`
  serves Fit without reading every node into TSX.
- The search palette (`components/SearchPalette.tsx`) is mounted only while
  open. It debounces input, calls `Document.search` with the selected kind
  filter, and renders FTS snippets; opening a hit calls `getNode(id)`, fits
  the camera to that card, reads the viewport and selects it. Its arrow-key
  bindings live with the mounted palette, so canvas shortcuts return when it
  closes.
- The decision and the phased migration are recorded in
  [ADR 0002](adr/0002-rust-document-core.md),
  [ADR 0003](adr/0003-orm-seaorm.md) and
  [the Rust core plan](plans/rust-core.md). The canvas itself is
  [ADR 0004](adr/0004-native-view-canvas.md).

## Node editor

M1 adds one generic executable node shape: one input port, one output port,
and many-to-many directed connections carrying typed text and image items. A
TSX kind registry (`flow/node-kinds.ts`) declares each kind's ports, defaults
and settings schema; `flow/execution.ts` owns its provider. Rust stores only
`kind` and opaque `settings_json`.

- Connecting an edge snapshots all current items of the source's batch into
  the target's inputs. Reconnecting rebuilds that snapshot, and deleting an
  edge removes exactly the inputs it contributed; a local upload can be
  deleted without deleting its edge.
- Result batches and their items are immutable. A rerun or manual text edit
  appends a batch and moves the node's output; old batches remain for
  downstream snapshots. Provider runs are not undo history, while connect,
  delete, input and manual-text edits are.
- Statuses are `idle`, `stale`, `running`, `done`, `failed`, `cancelled` and
  `interrupted`. A changed upstream marks an existing downstream result stale;
  startup turns abandoned runs into `interrupted`.
- The native canvas draws cards, ports, connectors and the connection preview.
  Selecting a card opens `NodeComposer`, a native panel anchored directly
  under the card and centred on it; the placement follows the card and never
  flips or clamps to stay inside the viewport. It is built from the same
  controls as the rest of the app. The inline text editor is a screen-space
  native overlay. The image node's body shows a thumbnail grid.
- Mock text and mock image providers exercise the run lifecycle and the
  provider seam. See [the node editor contract](node-editor.md) for the full
  M1 rules and non-goals.

## State

`store.ts` keeps its signals private and exports readers (`currentTool()`,
`zoomPercent()`) and actions (`setTool`, `togglePinned`). A page reads a
reader where the value is displayed; NSH tracks that read and updates only
the binding. Nothing writes another page's local state.

State that belongs to one mounted page stays there: `FlowPage` owns the
`FlowScene`, the `CanvasCamera`, the `CanvasController`, the stage size and the
document session, because they live and die with the workspace. Values the
chrome and overlays share (tool, zoom label, selection count, window pin) move
to the store. `App` binds the store's `isPinned`/`togglePinned` into
`TitleBar`, so the component stays reusable.

## The canvas

`FlowCanvas` is one native view with `testID="flow-canvas"`. It reads pointer
events and renders four kinds of children:

- **Grid** — a tiled dot-grid background in screen space, regenerated with the
  current `grid-dot` token when the appearance changes.
- **World** — a zero-size view translated and scaled by the camera
  (`transform: translate(x, y) scale(s)`, origin `0 0`). Its children are in
  world coordinates: one `FlowEdges` canvas for every connector, the selection
  frame and a `FlowCard` per visible node. The camera's transform is the only
  mapping from world to screen; the scene never caches screen geometry on a
  card. The frame and the cards share one stacking order: the frame draws
  above every unselected card and below the selected ones, so a swept area
  moves as one group; its padding and border are divided by the camera's scale
  to stay one screen point wide. The frame exists only for a marquee that ends
  with more than one card: a single card is selected as a press selects it,
  with no frame of its own. A press anywhere inside the frame—on empty space
  or a card border—drags the whole selection and shows the move cursor; a
  press outside it starts a new marquee. A multi-card frame replaces the
  cards' own pluses with one merged plus on each side: the left one is the
  group's input handle, the right one its output handle.
- **Selection overlay** — the marquee box in screen space, derived from the
  controller each time the drag changes. It does not take pointer events. The
  cards the box covers take the selected accent border while it sweeps, and
  the frame above appears on release when the box selected more than one
  card. A selected card itself shows the same
  rounded accent border it shows on hover, so no square outline is laid over
  it. The border is the resize zone: corners scale proportionally and any
  point along an edge resizes that axis, with the cursor naming the side, so
  the card shows no handle dots.
- **Interaction view** — a transparent, full-size view that owns the cursor
  and dispatches presses, moves and touches to the `CanvasController`. It is
  `WheelSurface`, a native component the Rust crate registers
  (`wheel_surface.rs`): the component draws nothing and takes no pointer, so
  presses reach the view as on any view, while NSH hands it the mouse wheel
  and touchpad scrolls over the canvas. The page turns each wheel event into
  a zoom about the pointer.

The canvas context menu (`components/CanvasContextMenu.tsx`) is a native-view
popup anchored at a secondary-button press: it adds a text or image card at
the pressed world point, or closes on a primary press or Escape. It is drawn
from ordinary views rather than opened with `Menu.popup`, because a system
menu takes the pointer and would prevent the right-button drag from panning;
`flow/context-menu.ts` wires the press, the pending press a release opens and
the item actions.

`FlowCard`'s root carries the node's world position and lays its chrome out
in card-local points (`flow/card-geometry.ts`). The rectangle reaches the card
as two memoized halves — position and size — so a drag wakes only the root's
`left`/`top` and a resize only the styles that read the size, instead of every
geometry-derived style on every pointer move. Its title, status and body come
from equality-gated values (`flow/card-content.ts`), so a viewport read that
carries the same card wakes nothing; that keeps a zoom or pan from resubmitting
every visible card's text. The body's rounded background, border and shadow
are a childless plate under the content, so the Windows renderer can skip
that paint when it is outside the damage rectangle, and a camera-scale detail
tier (`flow/card-detail.ts`) drops the shadow, body and status text below 35%
zoom and the title and image previews below 20%. The card renders the title and
status above the card, the body text or image thumbnails inside it (laid out
inside the body box), and one round plus button outside each side while the
card is hovered or selected. On a multi-card frame those per-card
pluses give way to the frame's merged ones. Per-card selection and connection
target flags come from `flow/keyed-flags.ts`, while `flow/hover-flags.ts`
separately holds the controller's hover and marquee-preview mirrors; their
source states write these flags in the same update round, so a change wakes
only the cards whose membership flipped. A plus rests just outside the
border; inside the side zone it eases toward the pointer in both axes, and it
springs back when the pointer leaves. The plus is only a drag handle:
connectors meet the card's own border. `FlowEdges` strokes every connector's
cubic from `flow/connection.ts` in one native-canvas layer with round caps;
the canvas rasterizer draws at the transformed resolution, so the lines stay
smooth and sharp at every camera scale instead of showing sampled joints, and
there is no arrowhead. The connectors of selected cards rest brighter and
thicker than the others and carry a comet of light (`flow/edge-flow.ts`):
the connector's cubic is split into short pieces (`splitConnector`), and
each piece's alpha is an animated value of the shared wave, so the light
travels from its source with a gradient trail behind its head and leaves
through the target, and the next comet starts. Every connector is stroked
from its source to its target, so the light flows into a selected target
and out of a selected source. A native stepped loop (`FLOW_STEPS` over one
1200 ms cycle) drives the shared wave only while at least one connector touches
the selection and Reduce Motion is off. Its requested 30 Hz frame cap is not a
fixed Windows rate: unchanged canvas slots skip re-recording. `CanvasCamera`
owns the moving flag for every pan, zoom and fit, settled by a 150 ms timer.
Above four flowing connectors, card/selection movement, camera settling and
following card/frame pluses suppress the expensive comet strokes while the
native phase continues. The brighter resting selection highlight remains.
The pulled connectors are one dashed `FlowPreviews`
canvas above the cards, holding one line per fixed end, so a group drag pulls
a line from every selected card. Both are presentational: props are
accessors, and the page passes scene signals to them.

The scene model (`flow/scene.ts`) is headless: it holds the visible nodes and
edges, the selection, transient drag geometry (`overrides`, read per card so
a drag updates only the cards it moves and their connectors), previews, the
connection previews and the card a pulled connector would snap to, and answers
world-space hit questions (`nodeAt`, `portZoneAt`, `edgeAt`). Selected cards
stack above every unselected one in selection order, so a pressed card comes
to the front at once and a marquee brings its whole group forward; hit
testing uses the same depth, and the connection previews stay above them all.
A card under the pointer hides a lower card's plus, just as it hides the card
itself.
`CanvasController` turns pointer events into commands: select/toggle, drag,
resize from a handle, marquee, pan with the hand tool, the following plus,
and the port/edge gestures. `CanvasCamera` stores logical `x`, `y` and
`scale`; `panBy`, `zoomAround` and `fit` rebuild the view from those values.

The dot grid and the cards follow the camera, but the composer does not: its
position is computed in screen points from the selected card's current screen
rectangle (`flow/overlay.ts`), so it keeps its size at every zoom and tracks
the card. It sits directly below the card, centred on it, and is allowed to
extend past the viewport rather than move somewhere else. The inline editor
is anchored inside the card body. A click on the selected card leaves the
composer mounted, so its native input keeps its draft and caret. Once a card
is dragged or resized past a small movement threshold, or a connector is
pulled away from its press point, the composer hides so the gesture and its
target stay visible.

## Input

`FlowCanvas` feeds NSH's press, mouse and touch events into
`CanvasController`:

- **Select** — a press selects a card (Shift toggles), starts a drag when the
  press lands on a selected card, starts a resize when it lands near any
  visible card's border (a corner or anywhere along an edge; the press selects
  that card first), and starts the connector gestures in a plus's side zone.
  A corner keeps the card's aspect ratio with the opposite corner fixed,
  scaling by the pointer's projection onto the card's diagonal, so passing one
  edge does not snap the card to its minimum. An edge resizes one axis. The
  side zones keep clear of the corners, so a plus never steals a corner
  resize. A press on empty canvas clears the selection and starts the
  marquee. A double-click on a text card opens its inline editor.
- **Hand** — presses pan the camera; nothing is selected.
- **Touch** — one finger behaves like the current tool; two fingers pinch-zoom
  around their center and pan with it.
- **Hover** — mouse movement updates the hovered card, the plus following the
  pointer in a side zone, and a cursor that reflects the tool, any card's
  resize border or a plus. A card under the pointer owns the hit: another
  card's border or plus never reacts through it.
- **Wheel** — the mouse wheel and touchpad zoom about the pointer, four
  notches per doubling, clamped to the camera's scale range. The wheel is a
  native-component event (the window's input never reaches TSX directly), so
  the pointer view owns a sensor that forwards it.
- **Secondary button** — holding the right button and dragging pans the
  camera with any tool, without selecting, starting a marquee or moving a
  card. A right click that stays put opens the canvas context menu on the
  button's release. NSH reports the press through `onContextMenu`, the moves
  while it is held, and the release through `onMouseUp`: a press that never
  moved past the drag threshold opens its menu at the pressed point, and a
  drag never opens one. The menu is the app's own view rather than
  `Menu.popup`, so it never takes the pointer from the drag.

Keyboard commands are declared in `flow/bindings.ts` (`bindFlowKeys`) and
bound once by the page: `mod+=`/`mod+-`/`mod+0`
zoom and fit, `v`/`h` switch tools, `n`/`i` add a text or image node, `l`
connects two selected cards, `mod+z`/`mod+shift+z` undo and redo,
Delete/Backspace delete the selected edge or cards, arrows pan, `mod+k` opens
search, and Escape dismisses the top layer (search, inline editor, selected
edge, composer, then the selection). Each command exists once.

Pointer gestures above the canvas: dragging a card's right plus previews a
forward connection and the left plus a reverse one; the preview is dashed
until the connection is written. While the pointer is on a card that accepts
the connection, the preview snaps to that card's port and the card's border
highlights like hover, and the preview follows the pointer again when it
leaves. Dragging either plus of a selected edge's endpoints moves that end
(source or target). A press on a connector selects it; double-clicking a text
card opens its inline editor.

## Window chrome

`lib/window-chrome.ts` hides the native title bar once, while `App` renders
(`currentWindow()` only answers there), and keeps the window ref for actions
outside a render. `TitleBar` draws the app name and pin button and reports the
space the system controls occupy through `titleBar()`, so the drag region and
buttons never sit under the traffic lights or caption buttons. The pin button
calls the store, which sets the window's `level` to `"floating"` or
`"normal"` through that ref.

Where `nsh/desktop` is unavailable (tests and non-desktop hosts), the title
bar is not mounted and `FlowPage` shows `BrandCard` instead, so the same app
code runs in the headless test engine.

## Sandbox

`src/nsh.json` declares `capabilities.network.hosts: []`: the app reads its
own bundled assets (`asset:` is always allowed) but may reach no remote host.
Its `capabilities.process.env` allow-list contains only `FLOW_DB_PATH`, the
development and smoke-test database override; `capabilities.windows.levels`
grants the `floating` level the pin sets on the main window, and
`capabilities.picker` is granted for local image uploads. NSH denies every capability not listed, so a
new integration that fetches or loads a remote image must add that host
deliberately. Adding the `capabilities` key is what changes the app from
unrestricted to allow-list; keep it in place.

## Extending

- **A new page** — one file in `pages/`, mounted by `App.tsx` (or a nav stack);
  share state through `store.ts`, never through another page.
- **A new node kind** — add it to `flow/node-kinds.ts` (ports, size, settings
  parsing, accent), give it a provider in `flow/execution.ts`, and extend
  `components/FlowCard.tsx` if the generic text/image body is not enough.
  Rust needs no change: `kind` and `settings_json` are opaque.
- **A new control** — a component in `components/` that takes values and
  callbacks as props; the page binds them to the store.
- **A new canvas feature** — keep pure geometry in `flow/selection.ts` or
  `flow/overlay.ts`, the model in `flow/scene.ts`, gestures in
  `flow/canvas-controller.ts`, and the view in the matching component. Add a
  unit test for the geometry or controller path and an app test flow when the
  user can reach it (a platform-sensitive one goes in `App.host.test.tsx`).
