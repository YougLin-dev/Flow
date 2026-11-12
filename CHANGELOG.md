# Changelog

All notable changes to Flow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `bun run dev:release` runs the development app against the same persistent
  `.nsh/dev` document on an optimized host for meaningful performance checks.

- The mouse wheel and touchpad zoom the canvas about the pointer on every
  desktop: four notches double or halve the scale, within the camera's
  limits. The canvas's pointer surface hears them with `onWheel`, converting
  a precise device's points to notches, and the page zooms about the pointer.
- A minimap in the canvas's bottom-left corner shows the whole document's
  card silhouettes and the camera's current viewport; the hint bar moved above
  it. Dragging anywhere on the map pans the camera (a press alone does
  nothing), and the mouse wheel over the map zooms the canvas about the
  viewport's center. The drag keeps going after the pointer leaves the panel
  or the window, and a release outside ends it once the pointer returns. The
  map always frames the union of the content and the viewport, so pulling the
  view away from the content shrinks the silhouettes instead of hiding
  either. One coarse Rust read (`Document.overview()`) samples at most 400
  cards by the insertion hash, so cards outside the scene still appear
  without instantiating the document in the view tree. Selected cards take
  the primary color in the map and sit above the other silhouettes.
- Connectors rest faint, at a third of their port type's color. Selecting a
  card relights its connectors, and clicking a line selects it and lights it
  the same way: one point thicker at full brightness, without any animation;
  the earlier comet of light is gone.
- A secondary-button drag pans the canvas with any tool, without selecting,
  box-selecting or moving a card, and a right click opens the canvas context
  menu with Add text node and Add image node, placing the card at the pressed
  point. The menu is a native-view popup rather than the system menu, because
  a system menu takes the pointer and would break the right-drag pan; it opens
  on the button's release when the press never became a drag, and a drag
  dismisses it and pans. The canvas listens to `onMouseUp`, which the NSH pin
  provides for every desktop host.
- Moved the document core to Rust: a mixed NSH crate owns SQLite with WAL,
  SeaORM entities and SeaQuery, FTS5 search and RTree viewport reads. The
  canvas reads only the viewport, sends one command per gesture, and keeps
  selected cards pinned through low-zoom card caps.
- Undo/redo history with add, delete, move, resize, text and edge commands;
  deleting a node also records its edges so undo restores them.
- The `N`/`I`, `L`, Delete/Backspace and undo/redo keyboard paths, backed by
  the Rust change sets.
- A command palette (`⌘K` / `Ctrl+K`, or the Search button) backed by the Rust
  FTS5 index: debounced search over titles, bodies and tags, snippets and type
  filters, and opening a result fits the camera to and selects its card.
- Development data persists in `.nsh/dev/flow.db` through `bun run dev`; the
  document path is overridable with `FLOW_DB_PATH`.
- A frame-rate meter for performance checks: `FLOW_FPS=1 bun run dev` shows
  the rate the app renders at above the tool switch, counted from
  `requestAnimationFrame` callbacks twice a second. While the meter runs the
  app renders continuously, so the reading is the display's real rate;
  without it no measuring loop runs.
- `bun run test:100k` seeds 100,000 nodes and drives the real desktop host
  through pan, zoom, search, reveal and Fit.
- The ignored 100k benchmark now builds a versioned, file-backed fixture with
  100,000 grid nodes, 99,000 within-row connectors and 2,000 image batches
  linked to real PNG assets. It prints avg/p95/max with row counts for Fit,
  0.15 and 0.40 scene reads, previews, public 1,000-node set/undo/redo
  cycles, open/migrate and recovery, and the existing searches, with its
  measured table in `docs/plans/rust-core.md`. `bun run test:100k` now traces
  its development-host run, logs timestamped phases, and shares the text
  graph while deliberately omitting the image batches. These are measurement
  changes, not performance gains.
- Interface icons come from [Lucide](https://lucide.dev/) (`lucide` 1.70.0,
  ISC), drawn by a small native-canvas `Icon` view; the zoom, search, tool and
  add-node controls use them instead of text glyphs. The dependency decision
  is [ADR 0006](docs/adr/0006-lucide-icons.md).
- Hovering a port shows a compact pill above the icon with its name
  ("Prompt", "Image references"; a group port shows its type and side), since
  cards connect left to right and the sides stay with the connectors. The
  placement is configurable and a bubble that would leave the stage flips to
  the opposite side. A card mounts its ports only when selected, hovered, a
  snapped target, or connected and at least 56 on-screen points tall, so an
  idle fit-to-board overview of a large document mounts no port views.
- The engineering standard in `docs/standards.md`, an ADR template and this
  changelog.

### Changed

- A selected card keeps its neutral border and shows a neutral selection ring
  just outside it instead of recoloring the card itself. Hovering no longer
  changes a card's border; a marquee sweep takes the same selection border,
  the marquee box and group frame use it with a faint foreground wash, and
  only a snapped connector keeps the accent outline. The selection gray meets
  the contrast the standard asks of state indicators.
- Nodes now expose named, typed ports instead of one aggregated input and
  output per card. The text and image kinds declare a `prompt` text input, an
  `image` references input with its own capacity (4 for text, 16 for image)
  and a typed output; every port has the type's icon and color, and no plus
  button remains. A connection records the exact output and input port plus
  each port's offset, so two edges between the same cards stay visually
  apart and the far endpoint needs no node lookup. The connector ends at the
  port icon's centre just outside the card, not on the card's border, and a
  far endpoint carried by the read is moved out by the same gap. Type
  mismatches, full
  inputs and duplicate port pairs never highlight as targets; a gesture that
  would overflow any port is rejected whole. Dragging a selected edge's
  endpoint moves that end to another port. The composer groups inputs by
  input port and shows the edge slots in use. A multi-card frame exposes one
  group port per input type and output type, icon only; dragging one fans the
  connection out to every matching selected port, and a full member disables
  the group port. Connectors, previews and the selected edge take their
  port type's color. Schema version 5 resets the document like version 2
  because typed ports are a breaking storage change; the app reseeds its
  example with the semantic port ids.
- Card previews now load a narrow node projection, read at most four result
  items per batch in one windowed query, read the exact item total separately,
  and resolve assets once per 400-node chunk. The displayed previews, item
  order and counts are unchanged; the old reader did the same output after
  loading every item and resolving assets once per card.
- Startup asks one `Document.isEmpty()` existence read after recovery instead
  of a node count plus an edge count. Schema version 4 adds partial indexes
  for the recovery queries' exact running-node and running-batch filters.
- A window resize on an automatic camera coalesces into one fit at the newest
  stage size, applied by the existing 80 ms viewport drain before its scene
  read. A user pan, zoom or explicit fit cancels a pending automatic fit.
- The dot grid moves as one container instead of rewriting every tile's screen
  position, and the selection frame and its group ports read a scale-only
  camera signal, so a pan updates two wrapper styles and leaves those overlays
  alone.

- Cards paint less on large boards: the body's rounded background, border and
  shadow live in a childless plate the Windows renderer can skip when it is
  outside the damage area; a resized card's
  width and height are now whole points so consecutive frames share the
  shadow cache. The card's decoration is unchanged at every zoom.

- Preview and composer images now use one cached `blob:` URL per asset
  instead of building and decoding a base64 data URL on every mount; NSH
  resolves the blob's native image bytes once, and the cache owns their
  revocation until the page closes.

- The canvas keeps at most one viewport read (and one preview read) in
  flight; a pan or zoom that arrives while a read is pending coalesces into
  one follow-up instead of queuing on the document worker.

- Hit testing behaves as before but does less work: a connector press skips
  exact curve sampling for edges whose padded control-point box cannot reach
  the pointer, connection checks read a lazily rebuilt pair index instead of
  walking every edge, and hover resolves the card under the pointer once
  while the outside-handle fallback avoids a screen rectangle per candidate.

- Viewport reads and command results now keep unchanged card and connector
  records identical, so a read that changes nothing wakes no card, composer,
  frame or connector binding. A card's geometry is published through one
  signal per card, so a change set wakes only the cards it actually moved,
  and an unchanged image preview is neither reloaded nor republished.

- Selection, hover, marquee-preview and connection-target changes now rebuild
  only the cards whose own state flipped, rather than every visible card's
  ports and border. In a 2000-card measurement this reduced hover work from
  roughly 10 ms to 0.1 ms.

- The shared connector layer computes its padded and rounded canvas box once
  per geometry change instead of separately for every style binding and the
  drawing origin, and resolves each connector's ports once per draw for every
  stroke.

- Dragging a selection updates the connectors, the selection frame and its
  group ports once per pointer move instead of once per moved card, and
  releasing a box selection no longer mounts and immediately unmounts every
  selected card's ports.

- A viewport read that carries a card unchanged no longer resubmits its
  title, status, body or stacking: the card reads them through
  equality-gated values (`flow/card-content.ts`), so a zoom or pan over many
  cards wakes only the cards whose content actually changed instead of every
  visible card's text.
- A card's root now carries its world position while its title, body and
  ports are laid out in card-local points (`flow/card-geometry.ts`).
  The card's rectangle is split into equality-gated position and size memos,
  so moving a selection submits one style update per moved card instead of
  every geometry-derived style (eight per text card, eight plus one per
  thumbnail for an image card), and a viewport read that leaves a card where
  it was wakes none of its styles.
- Connectors rest at a third of their port type's color and relight while a
  card at either end is selected or the connector is clicked: the selected
  line is one point thicker and fully opaque. The earlier comet of light is
  gone. Above a few flowing connectors the selection relight still draws, but
  only the resting stroke, because the canvas re-records on every pointer
  move.
- Migrated to NSH's main window API: `App` captures `currentWindow()` while it
  renders and the title bar's hidden style and the pin's window `level` go
  through that `WindowRef` (`Window.setTitleBar`/`Window.setLevel` are gone);
  `src/nsh.json` grants the `floating` level whose attributes the pin sets.
- `bun run test:host` now runs only the `*.host.test.tsx` platform tests
  instead of repeating every headless test file on the native host. The app's
  window, native-input, rendering and desktop-API checks moved to
  `App.host.test.tsx`; all other tests stay headless in `bun run test`.

- `bun run test:host` runs each app test file in its own host process;
  `native.test.ts` stays in the headless suite because the host cannot load
  the native module from a test bundle.
- Replaced the Leafer canvas with a native view canvas: cards, ports,
  connectors, selection, resize handles and the composer are ordinary NSH
  views driven by a headless scene model, the camera and a gesture controller.
  The composer follows its card in screen space and is fully keyboard- and
  screen-reader-accessible without a separate inspector.
- The boundary rule now fails closed when the importing module itself is
  unclassified, not only when its target is.
- Connectors are stroked as cubics in one native-canvas layer, so every line
  stays smooth and sharp at any zoom instead of showing sampled joints;
  connector arrowheads are gone. Typed ports sit just outside a card's left
  and right borders: they follow the pointer in a side zone through native
  animated values and spring back when it leaves. The pulled preview is
  dashed until the connection is written; it snaps to a valid card's port,
  gives that card the accent border, and unsnaps when the pointer
  leaves. Connectors end at the port icon's centre, not on the card border.
- A card's title and status now sit above the card instead of inside it, and
  the body uses the full card area.
- Selection no longer draws the eight resize handle dots or a square outline
  around the card: a neutral ring outside it marks selection, and
  its border stays a resize zone. A card resizes from anywhere along an edge,
  not only at the eight handle points; corners still win where an edge meets
  a corner. A corner drag keeps the card's aspect ratio with its opposite
  corner fixed; an edge drag still resizes one axis.
- Clicking a card raises it above every unselected card as soon as the press
  selects it, and a marquee raises the whole selected group in selection
  order. Hit testing follows the same stacking, so the card that draws on top
  is the card that takes the press, and the pulled connector stays above even
  a large elevated selection.
- Box selection previews its result while the pointer drags: every card the
  box covers takes the selection border immediately. Releasing over more
  than one card keeps a translucent neutral frame around them, matching the
  marquee's fill and border; it includes their title rows, draws above every
  unselected card and below the selected ones so the swept area moves as one
  group, and clears on a press outside it. Pressing anywhere inside the frame
  drags the whole selection, including the empty space between its cards and
  their borders, instead of starting a new box or resizing one card; the
  frame shows the move cursor throughout. A box that ends with a single card
  is just that card's selection: no frame, no group drag, its own ports.
- A multi-card frame exposes one typed group port per input and output type
  on its sides. Dragging one pulls a dashed line from every selected card's
  matching port and connects them all to the release target, or connects the
  target to every selected input; a full member disables the input group.
  The whole group is written in one Rust command, so one undo removes it in
  one step.
- Any visible card can be resized without selecting it first: pressing its
  border selects the card and starts the resize, hovering shows the resize
  cursor along any edge, and a card under the pointer keeps another card's
  covered border from reacting through it.

### Removed

- Removed the Leafer platform adapter (`src/leafer/`), its tests and the
  `@leafer-ui/*` dependencies; the app no longer mounts an NSH `<Canvas>`.

### Fixed

- Clicking an already selected card no longer unmounts its composer: the
  panel hides only once the gesture actually moves, so a typed draft and the
  native input's caret no longer blink away on every click.
- Dragging a card no longer re-renders every visible card: the drag's
  transient geometry is read per card, so only the cards it moves and their
  connectors update, and the un-moved cards keep the same geometry objects
  across viewport reads. The connectors' canvas rounds its box outward in
  whole steps, so a drag redraws the connectors without resizing the canvas
  surface on every pointer move.
- A click on the canvas no longer swallows the secondary click that follows
  it within half a second: NSH reports a mouse press to `onTouch` listeners
  too, so the click's touch end armed the post-touch suppression the canvas
  keeps for the press events some platforms emulate. The menu's press no
  longer consults it — a secondary press is an action of its own.
- A connector no longer disappears when its cards leave the viewport read.
  Every edge touching the viewport carries both endpoint ports, so it is
  drawn and hit-tested while either card is loaded, and a second RTree stores
  each connector's curve bounds (schema version 3, filled from existing
  edges), so a long connector is drawn even when both of its cards are
  outside the read while its curve crosses the visible area. Neither case
  adds the far card to the scene or the view tree.
- A selected card pinned in the scene keeps its connectors through a
  viewport read that no longer reports either end, such as a read landing
  while the card is dragged: one pinned endpoint plus the carried far port is
  enough to keep the line drawn, and releasing the drag no longer leaves it
  missing.
- Undo and redo change sets carry both endpoint ports for a restored or
  replaced connector, so it reappears at once instead of after the next
  viewport read when its cards are outside the scene.
- A hovered card's plus buttons no longer restart their follow when the
  viewport refreshes: the hover and selection checks use the row's id instead
  of the node record each refresh replaces, so the plus stays one instance
  while it follows. A gesture that ends elsewhere, or the pointer leaving the
  canvas, now re-reads the hover instead of keeping the card the gesture
  started on, so a plus cannot stay where the pointer left it while its card
  is still highlighted.
- A corner resize no longer snaps to the minimum at an edge crossing: the
  scale follows the pointer's projection onto the card's diagonal, so passing
  the opposite top or left edge alone does not collapse the card.
- Image thumbnails stay inside an image card's body: preview cells are
  positioned relative to the body box instead of applying its inset twice.
- The composer hides while a card is dragged or resized, or a connector is
  pulled, so the gesture and its target stay visible.
- The composer always opens directly below the selected card, centred on it.
  It no longer flips above or beside a card near a viewport edge or clamps
  into the stage, so it follows the card and may extend past the window.
- Undo history is mutated inside the same serialized database worker job as
  the write it describes; an undo can no longer pop an older entry while a
  command is still in flight and wedge the history.
- Short queries search every whitespace-separated term instead of one literal
  string, so mixed queries such as `AI image` or `图像 生成` no longer miss
  documents that contain the terms separately.
- Relative database paths (including paths with spaces or a colon) resolve
  against the working directory before becoming SQLite file URIs.
- A command's change set creates cards for newly inserted or restored nodes,
  and connectors stay while both endpoint cards remain selected, so a capped
  low-zoom snapshot cannot make them disappear.
- A fit in progress no longer overrides a newer pan or zoom.
- The search palette clears stale rows as soon as the query or filter changes,
  so Enter cannot open a result from the previous query.
- Viewport reads return nodes inside the visible rectangle before
  margin-only nodes, and capped low-zoom reads sample by a hash of the
  insertion sequence, so prefetch or one row-clustered strip cannot fill the
  card budget.
- Zoom-out no longer zooms in when the fitted scale is below the manual zoom
  floor; fitting and manual zoom share one scale range.
- Touch pinch anchors at canvas coordinates, and touch/mouse gesture state is
  reset correctly when switching tools or ending a pinch.
- The title bar truncates instead of overlapping the system caption buttons,
  controls have a visible focus state, the pin control is hidden where NSH
  cannot set a window level, and hints use the platform's modifier key.
- Boundary lint classifies bare directory imports and fails closed for
  unclassified modules; Oxlint's import plugin is enabled.
- The macOS installer reads NSH's real `.app` output path; the release
  workflow checks the tag against `src/nsh.json`; the packager is pinned.
