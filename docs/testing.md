# Testing

Tests under `src/` are `*.test.ts` / `*.test.tsx` files beside the code they
test, run with `nsh test src` (the app root is `src/`). NSH opens each app on an
engine of its own, headless by default, and `await`s the test callback, so tests
can be `async`. The local dependency-boundary rule has its own Bun test,
`lint/boundaries.test.js`; it runs without NSH and proves the rule's reports.

```sh
bun run test                       # every app test, headless
bun run test -- --filter camera    # tests whose name contains "camera"
nsh test src/flow/camera.test.ts   # one file
bun run test:host                  # the *.host.test.tsx platform tests on this machine's host
bun run test:host -- --filter zoom # one host behaviour (extra args go to nsh test)
bun run test:lint                  # the boundary rule's tests (also part of check)
bun run test:bench                 # the ignored 100k SQLite/FTS5/RTree benchmark
bun run test:100k                  # seeds 100k nodes, then drives the real host UI
bun run test:junit                 # also write src/.nsh/junit.xml for CI
```

Rust tests live beside the native crate in `src/native/src/`. `nsh test src`
runs `cargo test` before the TSX tests; `bun run test:bench` runs the release
benchmark that is ignored by the normal suite. The database tests open a real
SeaORM/SQLite database; `search.rs` and `viewport.rs` assert that the generated
queries keep FTS5/RTree as the outer table with `CROSS JOIN`,
`edge_index.rs` checks the connector box against the UI's curve geometry, and
`db.rs` covers a scene read between two off-screen cards plus its maintenance
through moves, deletes and undo.

The benchmark is manual evidence, not part of the gate. `bun run test:bench`
runs every ignored test; run the 100k fixture alone with:

```sh
cargo test --manifest-path src/native/Cargo.toml --release \
  db::tests::hundred_thousand_nodes_benchmark -- --ignored --nocapture --test-threads=1
```

The `100k-grid-edges-images-v1` fixture is file-backed and builds 100,000 grid
nodes, 99,000 within-row connectors, and 2,000 image nodes with four-item
image batches linked to real PNG assets. It prints avg/p95/max with row counts
for Fit, 0.15 and 0.40 scene reads (nodes and edges), previews, public
1,000-node set/undo/redo cycles, open/migrate plus recovery, and the common
and CJK searches. It asserts counts, geometry and stable row shapes, never
timings. The measured table, with its machine and build provenance, is in
[`plans/rust-core.md`](plans/rust-core.md#full-fixture-100k-grid-edges-images-v1).

Test paths below are relative to `src/` unless stated otherwise.

Headless is the default gate: fast, deterministic and identical on every OS.
The host target repeats only the platform tests (`*.host.test.tsx`) through
the real input, window and desktop APIs; use it when changing title-bar
geometry, window levels, appearance repainting, real pointer/keyboard plumbing
or anything that only exists on a real desktop. `scripts/test-host.mjs` runs
each host test file in its own `nsh test` process with `--target`, because the
host loads a test bundle before an app registers its native module. That also
means a test file that imports `@flow/native` at run time cannot run there:
name it `*.native.test.ts` (for example `flow/node-session.native.test.ts`)
and keep it headless. Test the TSX side of those modules through that headless
test instead of duplicating the run in an app test.

Every host test also runs headless in `bun run test`, so its logic regresses
in the fast gate; the host run only repeats the platform-sensitive checks.
Pure unit tests are never sent to the host: they cannot observe a platform
difference, so a second run there would only cost time.

`bun run test:100k` is a real-host smoke, not part of `bun run test`: an
ignored Rust seed writes the same 100,000-node / 99,000-edge text graph as the
release benchmark's `100k-grid-edges-images-v1` fixture into
`.nsh/bench/flow-100k.db`, but deliberately leaves its 2,000 image nodes as
text and stores no image batches. (At this commit image previews are data URLs
that QuickJS and native `Image` decode; that separate cost would mask graph
and canvas work. The Rust benchmark still reads the persisted image assets.)
The smoke points the app at the database with `FLOW_DB_PATH`, then pans,
zooms, searches for the last node, reveals and selects it, closes that card's
composer, fits the document and saves screenshots (`flow-100k-reveal.png`,
`flow-100k-overview.png`). It runs `nsh test` with `--target`, `--trace`,
`--fps` and `--verbose`, so it emits timestamped `100k smoke marker:` phase
lines, mount batches per step, engine `nsh::perf` records and `nsh::fps`
monitor lines. That is a **development-host** profile, not the release Rust
benchmark: it includes test-host setup and paint, and its wall times are
observations, not thresholds. Review the screenshots manually and treat their
artifacts as git-ignored evidence. At the Fit scale (~5%) each card is only a
few pixels tall; the smoke checks the 6% overview instead. A minimum-size or
cluster representation at very low zoom is still to be designed.

## Measuring performance

Use `bun run dev:release -- --fps -v` on the real desktop for performance
investigations. This optimizes the generated host and app Rust core; normal
`bun dev` leaves those hot crates at `-O0`. It uses the same persistent
`.nsh/dev` document as `bun dev`. Record the machine, OS, commit, window size,
display refresh rate, host profile, document/card/connector counts, and
selection size with every measurement.

Let startup settle and discard cold readings. After a short warmup, observe
for several seconds and repeat the same gesture several times. Report ranges
and work counts; do not promote one noisy run to an optimization result.
The monitor excludes its first four frames and four commits as cold. Each
four-number duration is **mean/p50/p95/max in milliseconds**:

- `fps shown/refresh` is the number of refreshes that changed something per
  second over the last second, followed by the display's refresh rate. Low
  `fps` while idle is not slowness. This host's monitor closes frames on each
  refresh.
- `frame` is main-thread work per shown frame, excluding presentation; `tick`
  is the compositor-paced ticker (animations and frame callbacks); `drain`
  applies arriving engine batches; `paint` draws the Direct2D tree;
  `present` queues the swap-chain frame; `canvas` is canvas recording and
  replay within paint; `gap` is time between shown frames.
- `over` is the percentage of retained shown frames whose main-thread work
  exceeded one refresh, not a count of dropped input events.
- `commits` is engine wake-ups that produced commits per second over the last
  second. `js` is app code (handlers, timers, microtasks, list binds, and
  render decoding); `core` applies ops, expands components, typesets, lays
  out, and diffs to mount items. `items` is mean mount items per commit.
- `engine` is the engine-thread busy share over the last second; `cpu` is
  process CPU over wall time as a percentage of one core (150% is 1.5 cores
  busy); `mem` is the working set in MB on Windows.

The two FPS mechanisms are separate: `--fps -v` enables the Windows `nsh::fps`
monitor and its logging. `FLOW_FPS=1` separately mounts the app's `FrameRate`
overlay (`FLOW_FPS=1 bun run dev:release -- --fps -v` enables both). `FrameRate`
asks for continuous display frames, so leave `FLOW_FPS` unset when measuring
idle wakeups or comparing the app's unforced frame rate.

Headless tracing is a separate mechanism:

```sh
nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace
```

It prints mount batches with item counts under named steps, such as
`── press(Fit): N items`, and logs engine `nsh::perf` records separately.
Those records include per-commit op counts, total core-side commit duration,
list-binding JS time, mount items, and node counts; event-handler JS time is
a separate `event js` record. Compare counts and timings across repeated runs
rather than assuming percentile distributions. Headless traces exclude
Windows presentation and real-input/paint work: they provide engine work
counts, not substitutes for release-host measurements.

The real-host `bun run test:100k` smoke passes `--trace`, `--fps` and
`--verbose` to `nsh test`; `--verbose` is required because the nonverbose
logger suppresses `nsh::fps` monitor records. Host `--trace` prints mount
batches under the step they came in and the time of each commit. Treat commit
and `event js` as separate `nsh::perf` records while the batches identify the
steps; do not promise every composite under a step. `--fps` real-host
frame/paint/canvas records supplement a headless `nsh test <file> --trace`
trace. The smoke uses a development host and is a separate profile from the
release Rust benchmark; use `bun run dev:release -- --fps -v` (above) for
release-host measurements, and record the fixture revision with any
comparison.

On system time, endless native animations do not block an app-test step's
quiet wait. Manual-clock settling instead checks whether the engine is idle;
reading an animated native value through an action may advance the clock by
one display frame before its result publishes. Keep loop and scheduler policies
deterministic with explicit clocks/fakes, and keep trace/timing budgets as
manual evidence rather than CI assertions.

The budgets in [§8.2](standards.md#82-performance) are manual SHOULD targets,
not CI assertions without a stable benchmark. Record these scenarios and their
response metrics:

- **Framed group drag**: reveal enough cards, drag a rectangle around several
  to select them, and drag the group by its selection frame. Record
  card/connector/selection counts, `commits`, `js`, `items`, `frame`, `paint`,
  `canvas`, and `engine` before and after a change.
- **Pan/zoom with selected cards**: keep the same group selected, pan with a
  secondary-button drag, and zoom around the pointer. Record the same fields
  plus `fps shown/refresh` and `over`; do not infer smoothness from `fps`
  alone. Repeat while idle to measure baseline engine wakeups.
- **Large document/low zoom**: run `bun run test:100k`, review its ignored
  screenshots, and inspect the timestamped phases plus the pan, zoom,
  search-reveal, Fit and trace/fps costs. Its database is the text-only
  variant of the synthetic `100k-grid-edges-images-v1` fixture; the ignored
  release Rust benchmark covers the image-rich file-backed variant. Record
  which fixture revision and host profile generated a run when comparing.
  Future benchmark additions are manual evidence, not CI timing gates.

### Before baseline

These observations are to reproduce, not thresholds or CI assertions:

- Advisor probe of the real development document (11 cards, 26 connectors),
  1800×1180 release/LTO Windows host at Flow `1956ebb` / NSH `f0b4659`: all
  cards selected with 26 flowing connectors cost about 2.5 ms main-thread work
  per comet wave step (paint 2.4–2.7 ms, canvas about 0.8 ms). The same probe
  on the debug dev host measured about 6.2 ms/step. A separate optimized
  headless 11-card group-drag probe measured unbatched `setOverrides` at
  about 6 ms JS versus about 0.6 ms batched; a separate debug-host observation
  was about 14 ms. These distinct setups are not a universal 2.5× multiplier
  on every operation.
- A `bun dev -- --fps -v` log on the **debug dev host** with a 240 Hz display:
  dragging the framed 11-card selection reported 70–75/240 fps, 67 commits/s,
  13–15 ms JS per commit, 48–56 mount items per commit, and 97–100% engine
  busy. These debug readings prompted this measurement recipe; re-measure in
  release before choosing follow-up work.
- The separate [release-database baseline](plans/rust-core.md#p0-measured-results)
  has its own provenance; do not use its older search figures as canvas-host
  evidence.

## The test levels

| Level  | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | What it proves                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit   | `flow/camera.test.ts`, `flow/minimap.test.ts`, `flow/minimap-controller.test.ts`, `flow/minimap-loader.test.ts`, `flow/search-navigation.test.ts`, `flow/keyed-flags.test.ts`, `flow/hover-flags.test.ts`, `flow/scene.test.ts`, `flow/selection.test.ts`, `flow/overlay.test.ts`, `flow/canvas-controller.test.ts`, `flow/frame-connection.test.ts`, `flow/right-gesture.test.ts`, `flow/context-menu.test.ts`, `flow/composer-state.test.ts`, `flow/grid.test.ts`, `flow/connection.test.ts`, `flow/edge-flow.test.ts`, `flow/preview-grid.test.ts`, `flow/data.test.ts`, `flow/database-path.test.ts`, `flow/node-kinds.test.ts`, `store.test.ts` | Pure logic, the scene model, gesture routing, camera math, placement, drafts, grid and preview coverage, minimap mapping, sampling and dragging, search reveals, connector geometry, right-button pan and menu placement. |
| Native | `native.test.ts`, `flow/node-session.native.test.ts`, Rust tests in `db.rs`, `search.rs`, `viewport.rs`, `edge_index.rs`, `schema.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | SeaORM schema/persistence, assets, FTS5/RTree plans, connector curve bounds and migrations, commands, history, undo, runs and the composer session.                                                                       |
| App    | `App.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The mounted app headless: text, presses, drags, keyboard, composer and inputs.                                                                                                                                            |
| Host   | `App.host.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The same app on the real window: rendering, native input, title bar, pinning and appearance repaint.                                                                                                                      |

Prefer the lowest level that can catch the bug. The scene and controller unit
tests construct a `FlowScene` and `CanvasCamera` and drive the controller's
pointer methods directly; only behaviour that needs the mounted view tree
belongs in `App.test.tsx`, and only behaviour whose subject is the platform
belongs in `App.host.test.tsx`.

## Writing an app test

```tsx
import { open, test } from "nsh/test";

test("clears the selection with Escape", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => app.texts().some((text) => /^\d+%$/.test(text)));

  // A new node is selected and its composer is open; the first Escape closes
  // the composer, the second clears the selection.
  await app.keyboard.press("n");
  await app.waitUntil(() => app.shows("id:node-composer"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().some((text) => text.includes("Esc to clear")));

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("card selected")));
});
```

- `open(entry)` mounts the app; each test gets a fresh engine and module state.
- Find elements by `testID` (`app.press("id:flow-canvas")`,
  `app.drag("id:flow-canvas", { x, y })`) or by visible text
  (`app.press("Fit")`). Avoid positional selectors.
- `app.drag(target, { x, y })` moves by a delta from the element's center;
  `app.press`, `app.hover`, `app.keyboard.press`, `app.texts()` and
  `app.screenshot()` cover the rest. Mouse buttons need a desktop platform:
  open with `{ platform: "windows" }` (or another desktop) before
  `app.rightClick`; the default headless app is a phone and has no secondary
  button. Right-button drags cannot be driven by the test API, so that path
  is unit-tested.
- Wait with `app.waitUntil(predicate)`, never `setTimeout`. The viewport
  refresh and preview reads land on later turns, so a state that follows a
  drag needs a wait.
- `app.waitUntil` has a timeout; a predicate that never becomes true fails with
  the wait, not a hang.

## Testing the canvas

Cards and the composer are ordinary views, so their text appears in
`app.texts()` and their controls are found by `testID` or label. Pointer
interaction still goes through the canvas: `app.drag("id:flow-canvas", delta)`
moves the pointer, and the page's overlays (selection count, zoom percentage,
tool state) reflect the scene.

For behaviour below the pointer, test the pieces directly:

- `FlowScene` in `flow/scene.test.ts`: viewport reconciliation, pinning,
  change sets, overrides, selection and world-space hit tests.
- `CardGeometry` in `flow/card-geometry.test.ts`: a move wakes only the
  position memo and a resize only the size memo, an unchanged rectangle wakes
  neither, a missing rectangle clears both, and the card-local chrome and
  port points compose back onto the world point they came from.
- `CardContent` in `flow/card-content.test.ts`: a viewport read with the same
  fields wakes nothing, a new title or body wakes only itself, a status wakes
  the status and its label, and a kind wakes the accent and the image check.
- `CanvasController` in `flow/canvas-controller.test.ts`: press/drag/resize/
  marquee/pan/connect against a real scene and camera with a recorded host.
- `HoverFlags` in `flow/hover-flags.test.ts`: hover and marquee gestures wake
  only the cards whose own flags changed.
- `CanvasCamera` in `flow/camera.test.ts`: pan, zoom-around, fit and centering
  invariants.
- `minimapLayout`/`minimapRect`/`minimapViewport`/`unionBounds`/`sameBounds`
  and `minimapDragCenter` in `flow/minimap.test.ts`: uniform fitting, the
  content-plus-viewport union (a pulled-away view shrinks the silhouettes),
  the minimum silhouette size, the viewport rectangle clamped into the panel,
  the press-scale drag mapping and a finite empty-document layout.
- `MinimapController` in `flow/minimap-controller.test.ts`: a press alone
  moves nothing, a drag centers by its pointer delta, and moves without a
  drag (or with a zero scale) do nothing.
- `MinimapLoader` in `flow/minimap-loader.test.ts`: one overview read per
  burst of changes, a stale revision dropped with one follow-up, an unchanged
  overview not republished, a read scheduled only for a change that can move
  a silhouette, and a failed read not spinning.
- `composerAnchor`/`inlineAnchor` in `flow/overlay.test.ts`: placement and
  clamping.
- `ComposerState` in `flow/composer-state.test.ts`: drafts, reloads and saves.

`App.test.tsx` drives the mounted path end to end: box selection, pan, zoom,
search reveal, opening the native composer, running a node, editing the body,
removing an input and switching nodes. `App.host.test.tsx` repeats the subset
whose subject is the platform itself (window, real input, rendering, desktop
APIs); it is also the only file `bun run test:host` runs. The zoom label is the
easiest observable: it is `—` before the first fit and `<n>%` afterwards.

## Rules

- One behaviour per test; the name says what the user does ("clears the
  selection with Escape"), not which function runs.
- A test whose subject is the real platform (window, native input, rendering,
  desktop APIs) goes in a `*.host.test.tsx` file and therefore also runs under
  `bun run test:host`; everything else stays headless-only. `bun run test`
  still runs both, so logic regressions fail without a host.
- App tests use `app.waitUntil`, never a sleep; no retries, no shared mutable
  state between tests. A real timer is allowed only where the behavior is
  timer-based, with a comment and reviewer approval.
- Assert on outcomes (text, selection, position), not internal call counts,
  unless you are testing the controller or scene directly.
- A bug fix comes with a test that fails before it and passes after.
- Do not add `any` to make a test compile; build a typed stand-in and cast
  through `unknown` where a full platform object cannot exist.

## Coverage expectations

- `flow/scene.ts`: a snapshot prunes and pins, change sets apply, overrides
  win until committed, selection ignores unknown ids, ports/edges hit test in
  world coordinates, a connector keeps the ports the read carried when its
  far card left the scene or both cards did, a selected card pinned through
  a read that reports neither end keeps its connectors, an edge with no
  ports and no cards is dropped, and previews only include visible cards.
- `flow/card-geometry.ts`: a drag override or command move wakes only the
  moved card's position memo, a resize wakes only its size memo, a viewport
  read that leaves a card where it was wakes neither, and the chrome and port
  helpers work in card-local points.
- `flow/card-content.ts`: the same through every card text: a viewport read
  that carries a card's fields unchanged wakes no value, and each value
  wakes only what reads it.
- `flow/camera.ts`: pan/zoom/fit invariants (the point under the cursor stays
  put, content stays centered), centering a world point, wheel notch factors,
  clamping and the view signal. The wheel itself is a native-component event
  with no test driver; the real host proves the sensor is registered (an
  unknown name logs a warning), and the notch-to-factor math is unit-tested.
- `flow/minimap.ts` and `flow/minimap-loader.ts`: the document-to-panel
  mapping, press-to-world round trip, the debounced overview read and its
  revision guard. The overview query itself is covered in Rust: every card
  with its geometry and bounds, the 400-card cap on a larger document, a
  sample that is neither the first inserted nor the top stacked cards, and an
  empty document.
- `flow/selection.ts`: handle placement and reach, normalized rectangles,
  touching-edge intersections, and resizing that keeps the opposite edge fixed
  and never goes below the minimum.
- `flow/overlay.ts`: placement directly under the card, no viewport clamping
  and camera pan/zoom.
- `flow/canvas-controller.ts`: card press and drag commit, cancel, Shift
  toggle, marquee (a single-card box leaving a normal selection), hand pan,
  resize, new connections and reconnects.
- `flow/frame-connection.test.ts`: a multi-card frame's typed group ports
  (their ordering, capacity state and mixed-kind union), muted per-card
  ports, a still press that writes nothing, and the group connections pulled
  from either side.
- `flow/right-gesture.ts`: the right-drag threshold and pan, the still press
  a release opens its menu for, and the refusal while another gesture owns
  the canvas.
- `flow/context-menu.ts`: menu placement at the press and its clamping at the
  stage edges, a press that opens its menu only on release, a drag that leaves
  none, the move fallback for a release the host did not report, and
  re-anchoring an open menu. The menu's items and Escape path are app tests.
- `flow/composer-state.ts`: draft loading, same-node sync, reset, count
  clamping and saving settings/body.
- `flow/grid.ts`: the tile count covers the stage at every wrapped camera
  offset, including a 4K width, and an invalid tile side falls back to one.
- `pages/FlowPage.tsx`: through `App.test.tsx` for interaction flows, not
  through unit tests of its closures. Composer selection, runs, input removal,
  body edits and switching nodes are app tests.
- `components/NodeComposer.tsx`: through `App.test.tsx`, where its controls
  must re-read session signals inside JSX (components run once).
- `components/SearchPalette.tsx`: through `App.test.tsx` — opening by shortcut
  and button, typing, switching filters, choosing a result by click or Enter,
  Escape and the selection that follows a hit. Kind filtering itself is
  asserted through the Rust search tests; the palette's arrow bindings are
  wired to the visible active row but are not asserted through the native view
  tree. The real-host 100k smoke exercises the camera reveal and records
  timestamped phases plus trace/fps evidence.
- `flow/node-kinds.ts` and `flow/connection.ts`: direct unit tests for settings
  parsing/clamping, connection rules, port points, sampled curves and hit
  distances.
- `flow/icon-shape.ts`: direct unit tests for Lucide node conversion — paths,
  circles, ellipses, rects with corner radii, lines, polylines/polygons and
  malformed values.
- `flow/node-session.ts` and `flow/execution.ts`: `node-session.native.test.ts`
  drives the real Rust document through a mock picker and the mock providers:
  runs, stale propagation, manual text, inline editing and uploads. Provider
  output goes through the immutable batch/asset path, not a fake.
- `store.ts`: readers and actions directly in `store.test.ts`, and their page
  wiring through `App.test.tsx`; the signals stay private by design.
- `lint/boundaries.js`: `lint/boundaries.test.js` covers layer classification,
  bare-directory targets, upward reports and the fail-closed `unknown` report.
  Extend it when adding a directory or layer.
