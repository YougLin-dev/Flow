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
queries keep FTS5/RTree as the outer table with `CROSS JOIN`, and the benchmark
covers the 100k-node path plus short CJK (LIKE) and CJK trigram searches.

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

`bun run test:100k` is a real-host smoke, not part of `bun run test`: it seeds
100,000 nodes into `.nsh/bench/flow-100k.db` through an ignored Rust test,
points the app at it with `FLOW_DB_PATH`, then pans, zooms, searches for the
last node, reveals and selects it, fits the document and saves screenshots
(`flow-100k-reveal.png`, `flow-100k-overview.png`). It exercises the whole
path — RTree viewport reads, card budget, hash sampling and search — against
the real window; review the screenshots manually and treat their artifacts as
git-ignored evidence. At the Fit scale (~5%) each card is only a few pixels
tall; the smoke checks the 6% overview instead. A minimum-size or cluster
representation at very low zoom is still to be designed.

## The test levels

| Level  | Where                                                                                                                                                                                                                                                                                                                                                                                                                                  | What it proves                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit   | `flow/camera.test.ts`, `flow/scene.test.ts`, `flow/selection.test.ts`, `flow/overlay.test.ts`, `flow/canvas-controller.test.ts`, `flow/frame-connection.test.ts`, `flow/right-gesture.test.ts`, `flow/context-menu.test.ts`, `flow/composer-state.test.ts`, `flow/grid.test.ts`, `flow/connection.test.ts`, `flow/preview-grid.test.ts`, `flow/data.test.ts`, `flow/database-path.test.ts`, `flow/node-kinds.test.ts`, `store.test.ts` | Pure logic, the scene model, gesture routing, camera math, placement, drafts, grid and preview coverage, connector geometry, right-button pan and menu placement. |
| Native | `native.test.ts`, `flow/node-session.native.test.ts`, Rust tests in `db.rs`, `search.rs`, `viewport.rs`                                                                                                                                                                                                                                                                                                                                | SeaORM schema/persistence, assets, FTS5/RTree plans, commands, history, undo, runs and the composer session.                                                      |
| App    | `App.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                         | The mounted app headless: text, presses, drags, keyboard, composer and inputs.                                                                                    |
| Host   | `App.host.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                    | The same app on the real window: rendering, native input, title bar, pinning and appearance repaint.                                                              |

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
- `CanvasController` in `flow/canvas-controller.test.ts`: press/drag/resize/
  marquee/pan/connect against a real scene and camera with a recorded host.
- `CanvasCamera` in `flow/camera.test.ts`: pan, zoom-around and fit invariants.
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
  world coordinates, and previews only include visible cards.
- `flow/camera.ts`: pan/zoom/fit invariants (the point under the cursor stays
  put, content stays centered), clamping and the view signal.
- `flow/selection.ts`: handle placement and reach, normalized rectangles,
  touching-edge intersections, and resizing that keeps the opposite edge fixed
  and never goes below the minimum.
- `flow/overlay.ts`: placement directly under the card, no viewport clamping
  and camera pan/zoom.
- `flow/canvas-controller.ts`: card press and drag commit, cancel, Shift
  toggle, marquee, hand pan, resize, new connections and reconnects.
- `flow/frame-connection.test.ts`: a multi-card frame's merged pluses, muted
  per-card zones, and the group connections pulled from either side.
- `flow/right-gesture.ts`: the right-drag threshold and pan, the still press
  left for the menu, and the refusal while another gesture owns the canvas.
- `flow/context-menu.ts`: menu placement at the press and its clamping at the
  stage edges. The menu's opening, items and Escape path are app tests.
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
  tree. The real-host 100k smoke exercises the camera reveal.
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
