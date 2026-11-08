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
- The `N`, `L`, Delete/Backspace and undo/redo keyboard paths, backed by the
  Rust change sets.
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
- The Leafer adapter rasterizes offscreen layers whose compositing must stay
  inside them — alpha masks, erasers, blend copies, group opacity, grayscale
  masks, patterned strokes and text — as one self-contained SVG image, so each
  effect composites once. Pattern tiles keep Leafer's gap. This path needs the
  NSH build in `docs/nsh.md`; the plain scene stays vector.

### Changed

- `bun run test:host` runs each app test file in its own host process;
  `native.test.ts` stays in the headless suite because the host cannot load
  the native module from a test bundle.
- Split Leafer's platform adapter into a public facade and focused modules
  under `src/leafer/platform/`; behavior and the facade's public names are
  preserved.
- The boundary rule now fails closed when the importing module itself is
  unclassified, not only when its target is.

### Fixed

- Undo history is mutated inside the same serialized database worker job as
  the write it describes; an undo can no longer pop an older entry while a
  command is still in flight and wedge the history.
- Short queries search every whitespace-separated term instead of one literal
  string, so mixed queries such as `AI image` or `图像 生成` no longer miss
  documents that contain the terms separately.
- Relative database paths (including paths with spaces or a colon) resolve
  against the working directory before becoming SQLite file URIs.
- Editor rotation, skew and flip are disabled, and gesture commits read the
  card's logical geometry, so an unsupported transform can no longer be
  persisted as an oversized axis-aligned box.
- A command's change set creates cards for newly inserted or restored nodes,
  and connectors stay while both endpoint cards remain selected, so a capped
  low-zoom snapshot cannot make them disappear.
- A full-canvas offscreen clear inside a save starts a new layer recording, so
  Leafer's per-frame `tree`/`sky` layer renders stay vector instead of being
  serialized to asynchronously loaded images; a hover or other repaint no
  longer blanks the cards.
- A viewport read skipped during a card drag is retried after the gesture, and
  a fit-in-progress no longer overrides a newer pan or zoom.
- The search palette clears stale rows as soon as the query or filter changes,
  so Enter cannot open a result from the previous query.
- Text measurement now uses the recording context's font instead of the
  frame's last font.
- Offscreen composites preserve the layer's opacity and a snapshot's internal
  transform; snapshots are clipped to their destination and source rectangles,
  and replay a balanced save/restore stack so an open layer save cannot clip
  later drawing.
- Viewport reads return nodes inside the visible rectangle before
  margin-only nodes, and capped low-zoom reads sample by a hash of the
  insertion sequence, so prefetch or one row-clustered strip cannot fill the
  card budget.
- Connectors recompute after Leafer's layout instead of reading stale bounds
  during an editor drag or resize.
- The editor's selection box follows the camera while panning or zooming,
  including when several elements are selected.
- Zoom-out no longer zooms in when the fitted scale is below the manual zoom
  floor; fitting and manual zoom share one scale range.
- Touch pinch anchors at canvas coordinates, and touch/mouse gesture state is
  reset correctly when switching tools or ending a pinch.
- `roundRect` hit geometry matches Canvas for missing and oversized radii;
  arcs normalize sweeps beyond one turn; `beginPath` resets the current point;
  butt-capped strokes stop at their endpoints.
- The title bar truncates instead of overlapping the system caption buttons,
  controls have a visible focus state, the pin control is hidden where NSH
  cannot set a window level, and hints use the platform's modifier key.
- Boundary lint classifies bare directory imports and fails closed for
  unclassified modules; Oxlint's import plugin is enabled.
- The macOS installer reads NSH's real `.app` output path; the release
  workflow checks the tag against `src/nsh.json`; the packager is pinned.
