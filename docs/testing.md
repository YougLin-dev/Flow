# Testing

Tests are `*.test.ts` / `*.test.tsx` files beside the code they test, run with
`nsh test src` (the app root is `src/`). NSH opens each app on an engine of
its own, headless by default, and `await`s the test callback, so tests can be
`async`.

```sh
bun run test                       # every test, headless
bun run test -- --filter camera    # tests whose name contains "camera"
nsh test src/leafer/camera.test.ts # one file
bun run test:host                  # on this machine's real host (Windows, macOS or Linux)
bun run test:web                   # in a headless browser host
bun run test:junit                 # also write src/.nsh/junit.xml for CI
```

Test paths below are relative to `src/`.

Headless is the default gate: fast, deterministic and identical on every OS.
The host target runs the same steps through the platform's real input and
window; use it when changing title-bar geometry, window levels or anything
that only exists on a real desktop.

## The three levels

| Level       | Where                                                                                                             | What it proves                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Unit        | `leafer/camera.test.ts`, `leafer/nsh-platform.test.ts`, `flow/grid.test.ts`, `flow/data.test.ts`, `store.test.ts` | Pure logic, the canvas adapter and data invariants, no NSH app.                  |
| Integration | `leafer/editor.test.ts`, `leafer/culling.test.ts`, `flow/scene.test.ts`                                           | Leafer's real editor/interaction and the built scene against `NshCanvasSurface`. |
| End-to-end  | `App.test.tsx`                                                                                                    | The mounted app: text, presses, drags, keyboard.                                 |

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
- No sleeps, no retries, no shared mutable state between tests.
- Destroy Leafer `App`s/`Leafer`s you create (`app.destroy()`), or the next
  test in the file may inherit timers.
- Assert on outcomes (text, selection, position), not internal call counts,
  unless you are testing the adapter itself.
- A bug fix comes with a test that fails before it and passes after.
- Do not add `any` to make a test compile; build a typed stand-in and cast
  through `unknown` where a full DOM canvas cannot exist.

## Coverage expectations

- `leafer/nsh-platform.ts`: every newly supported canvas feature gets a test
  that records a call, replays it, and asserts the effect (patterns,
  gradients, snapshots, hit tests).
- `leafer/camera.ts`: pan/zoom/fit invariants (the point under the cursor
  stays put, content stays centered).
- `pages/FlowPage.tsx`: through `App.test.tsx` for interaction flows, not
  through unit tests of its closures.
- `store.ts`: through the page/overlays; the signals are private by design.
