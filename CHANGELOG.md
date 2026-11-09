# Changelog

All notable changes to Flow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
  document path is overridable with `FLOW_DB_PATH`, the only environment
  variable declared in `src/nsh.json`.
- `bun run test:100k` seeds 100,000 nodes and drives the real desktop host
  through pan, zoom, search, reveal and Fit.
- The engineering standard in `docs/standards.md`, an ADR template and this
  changelog.

### Changed

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
- Connectors render as densely sampled, overlapping line segments with rounded
  caps, and card ports are accent dots on a card-colored halo; connector
  arrowheads are gone.
- Selection no longer draws the eight resize handle dots or a square outline
  around the card: the card's own rounded accent border marks selection, and
  the handles remain invisible hit targets with resize cursors. A corner drag
  keeps the card's aspect ratio with its opposite corner fixed; an edge drag
  still resizes one axis.
- Any visible card can be resized without selecting it first: pressing its
  handle selects the card and starts the resize, and a card under the pointer
  keeps another card's covered handle from reacting through it.

### Removed

- Removed the Leafer platform adapter (`src/leafer/`), its tests and the
  `@leafer-ui/*` dependencies; the app no longer mounts an NSH `<Canvas>`.

### Fixed

- A corner resize no longer snaps to the minimum at an edge crossing: the
  scale follows the pointer's projection onto the card's diagonal, so passing
  the opposite top or left edge alone does not collapse the card.
- Image thumbnails stay inside an image card's body: preview cells are
  positioned relative to the body box instead of applying its inset twice.
- The composer hides while a card is dragged or resized, or a connector is
  pulled, so the gesture and its target stay visible.
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
