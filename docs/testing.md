# Testing

Tests under `src/` are `*.test.ts` / `*.test.tsx` files beside the code they
test, run with `nsh test src` (the app root is `src/`). NSH opens each app on an
engine of its own, headless by default, and `await`s the test callback, so tests
can be `async`. The local dependency-boundary rule has its own Bun test,
`lint/boundaries.test.js`; it runs without NSH and proves the rule's reports.

```sh
bun run test                       # every app test, headless
bun run test -- --filter camera    # tests whose name contains "camera"
nsh test src/leafer/camera.test.ts # one file
bun run test:host                  # on this machine's real host (Windows, macOS or Linux)
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
The host target runs the same steps through the platform's real input and
window; use it when changing title-bar geometry, window levels or anything
that only exists on a real desktop. `scripts/test-host.mjs` runs each
`*.test.ts(x)` file in its own `nsh test` process, because the host loads a
test bundle before an app registers its native module. That means
`native.test.ts` cannot load on the host; it is headless-only and the script
skips it. Adding a test file that imports `@flow/native` at run time has the
same limitation.

`bun run test:100k` is a real-host smoke, not part of `bun run test`: it seeds
100,000 nodes into `.nsh/bench/flow-100k.db` through an ignored Rust test,
points the app at it with `FLOW_DB_PATH`, then pans, zooms, searches for the
last node, reveals and selects it, fits the document and takes screenshots
(`flow-100k-reveal.png`, `flow-100k-overview.png`). It proves the whole path
— RTree viewport reads, card budget, hash sampling and search — against the
real window; its artifacts are git-ignored. At the Fit scale (~5%) Leafer
renders no cards because each is only a few pixels tall; the smoke checks the
6% overview, where sampled cards are visible, instead. A minimum-size or
cluster representation at very low zoom is still to be designed.

## The test levels

| Level       | Where                                                                                                             | What it proves                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unit        | `leafer/camera.test.ts`, `leafer/nsh-platform.test.ts`, `flow/grid.test.ts`, `flow/data.test.ts`, `store.test.ts` | Pure logic, the canvas adapter and data invariants, no NSH app.        |
| Native      | `native.test.ts`, Rust tests in `db.rs`, `search.rs`, `viewport.rs`, `scene.rs`                                   | SeaORM schema/persistence, FTS5/RTree plans, commands, edges and undo. |
| Integration | `leafer/editor.test.ts`, `leafer/culling.test.ts`, `flow/scene.test.ts`                                           | Leafer's real editor and the viewport-driven card/edge reconciliation. |
| End-to-end  | `App.test.tsx`                                                                                                    | The mounted app: text, presses, drags, keyboard.                       |

Prefer the lowest level that can catch the bug. The adapter tests construct a
`NshCanvasSurface` directly and inspect recorded ops or replay effects; the
editor tests build a Leafer `App` with the adapter and drive
`interaction.pointerDown/Move/Up`; only behaviour that needs the real view
tree belongs in `App.test.tsx`.

## Writing an app test

```tsx
import { expect, open, test } from "nsh/test";

test("clears the selection with Escape", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => app.texts().some((text) => text.includes("card selected")));

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
  `app.screenshot()` cover the rest.
- Wait with `app.waitUntil(predicate)`, never `setTimeout`. Canvas rendering
  and the editor update on later frames, so a state that follows a drag needs
  a wait.
- `app.waitUntil` has a timeout; a predicate that never becomes true fails with
  the wait, not a hang.

## Testing the canvas

The canvas is a single NSH element (`testID="flow-canvas"`); its contents are
not in the view tree. To test scene behaviour, either:

- test the scene and camera directly (`buildScene`, `CanvasCamera`), or
- drive Leafer's editor through the adapter in an integration test, or
- assert on the app's overlays — selection count, zoom percentage, tool state —
  which reflect the canvas state in the native view tree.

The zoom label is the easiest observable: it is `—` before the first fit and
`<n>%` afterwards. `App.test.tsx` parses it to compute world-to-screen deltas
for drags.

## Rules

- One behaviour per test; the name says what the user does ("clears the
  selection with Escape"), not which function runs.
- App tests use `app.waitUntil`, never a sleep; no retries, no shared mutable
  state between tests. A real timer is allowed only where the behavior is
  timer-based: `editor.test.ts` has one documented 200 ms double-click spacing
  timer, and a new one needs the same comment and reviewer approval.
- Destroy Leafer `App`s/`Leafer`s you create (`app.destroy()`), or the next
  test in the file may inherit timers.
- Assert on outcomes (text, selection, position), not internal call counts,
  unless you are testing the adapter itself.
- A bug fix comes with a test that fails before it and passes after.
- Do not add `any` to make a test compile; build a typed stand-in and cast
  through `unknown` where a full DOM canvas cannot exist.

## Coverage expectations

- `leafer/nsh-platform.test.ts` covers the `leafer/platform/` modules: every
  newly supported canvas feature gets a test that records a call, replays it,
  and asserts the effect (patterns, gradients, snapshots, hit tests).
- `leafer/camera.ts`: pan/zoom/fit invariants (the point under the cursor
  stays put, content stays centered).
- `pages/FlowPage.tsx`: through `App.test.tsx` for interaction flows, not
  through unit tests of its closures.
- `components/SearchPalette.tsx`: through `App.test.tsx` — opening by shortcut
  and button, typing, filters, clicking a result, Enter, Escape and the camera
  fit/selection that follows a hit.
- `store.ts`: readers and actions directly in `store.test.ts`, and their page
  wiring through `App.test.tsx`; the signals stay private by design.
- `lint/boundaries.js`: `lint/boundaries.test.js` covers layer classification,
  bare-directory targets, upward reports and the fail-closed `unknown` report.
  Extend it when adding a directory, facade or layer.
