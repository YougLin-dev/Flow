# Plan 002: Apply each scene command and pointer event in one update round

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/flow/scene.ts src/flow/scene.test.ts src/flow/canvas-controller.ts src/flow/canvas-controller.test.ts src/flow/resize-handles.ts src/flow/resize-handles.test.ts docs/standards.md CHANGELOG.md plans/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. `plans/README.md` is
> advisor-maintained; the executor updates only their own plan's status row
> at the end.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan `plans/001-measure-in-release.md` is recommended first, for measuring)
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10

## Why this matters

NSH's reactivity (Solid 1.9 scheduling) runs one update round per signal write
unless the writes sit inside `batch`. `FlowScene.setOverrides` writes one
per-card signal per moved card outside any batch, so an 11-card group drag
runs 11 update rounds per pointer move, each re-running the connector layer's
draw, its six `box()` passes, `SelectionFrame` and `SelectionPluses`. That is
the user's measured 70–75 fps on a 240 Hz reference host (67 commits/s,
13–15 ms JS per commit, 48–56 mount items — debug host). Advisor probes at
`1956ebb` measured the same write at ≈6 ms JS per pointer move on the
optimized headless engine (≈14 ms in the debug host) versus **0.6 ms inside
one `batch`**; releasing or cancelling a drag with a selection costs up to
46 ms (11–13 update rounds, each re-recording the comet). A 300-card marquee
release mounts 602 `PortPlus` views and destroys 600 of them (11,151 mount
items) because `select(ids)` and `marqueeSelected` are written in separate
rounds. Batching each logical command makes every reader see one coherent
state and cuts the multi-round cost to one round.

## Current state

The relevant files:

- `src/flow/scene.ts` — the scene model: viewport snapshot, selection,
  transient drag geometry, previews. Owns no views.
- `src/flow/canvas-controller.ts` — the one pointer router: all mouse/touch
  gestures write its signals.
- `src/flow/scene.test.ts`, `src/flow/canvas-controller.test.ts` — unit tests
  beside the subjects; both already count `effect` runs.
- `docs/standards.md` §6.1 — the rule that `batch` groups one invariant.
- `CHANGELOG.md` — `## [Unreleased]` has `### Changed` at line 59.

The unbatched writes today (`src/flow/scene.ts`):

```ts
// scene.ts:155-159 — clears N override signals in N rounds
clearOverrides(): void {
  if (this.overrideRects.size === 0) return;
  this.overrideRects.clear();
  for (const override of this.overrideSignals.values()) override.set(undefined);
}

// scene.ts:162-170 — one signal write per moved card, outside any batch
setOverrides(next: ReadonlyMap<string, BoxGeometry>): void {
  const ids = new Set([...this.overrideRects.keys(), ...next.keys()]);
  this.overrideRects.clear();
  for (const [id, rect] of next) this.overrideRects.set(id, rect);
  // Only the cards whose geometry changed hear of it; the cards reading
  // their own rect stay untouched, which keeps a drag's re-render to what
  // it moves.
  for (const id of ids) this.overrideSignals.get(id)?.set(next.get(id));
}
```

`apply` (scene.ts:60-90) calls `prune()` (446-468), whose tail sets
`this.nodes.set([...this.byId.values()])` and
`this.edges.set([...this.edgeById.values()])` in two rounds after
`applyChangeSet` (93-127) already dropped overrides per card. `select`
(177-188) writes `selectedEdge` and `selection` in separate rounds when
selecting cards while an edge was selected.

In `src/flow/canvas-controller.ts`, `up()` on a marquee writes the selection
and the frame flag in separate rounds (385-420):

```ts
// canvas-controller.ts:411-420
if (gesture.mode === "marquee") {
  const box = normalizeRect(gesture.startX, gesture.startY, x, y);
  const ids = this.selectWithin(gesture, box); // scene.select(ids)
  this.marquee.set(null);
  this.clearPreview();
  // One card is a normal selection: the frame, its merged pluses and
  // its group drag are a multi-card selection's affordance.
  this.marqueeSelected.set(ids.length > 1);
  this.hover(x, y); // up to 4 more writes
  return;
}
```

`hover` (453-503) writes up to four signals (`framePlus`, `hovered`,
`portPlus`, `cursor`), each its own round, on every idle mouse move.

Public methods of `CanvasController` and how they are reached (verified by
reading every caller in `src/`):

| Entry point                     | Called from                                                                                                | Writes 2+ signals?                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `down(x, y, shift, clickCount)` | `FlowCanvas.tsx:110,194`; tests                                                                            | yes (`gesturing`, `portPlus`, `framePlus`, `marqueePreview`, `gesturing`, scene selection, `cursor`, ...) |
| `move(x, y)`                    | `FlowCanvas.tsx:142,224`; tests                                                                            | yes (scene overrides + `cursor`, or `marquee` + `marqueePreview`, or edge preview + target)               |
| `up(x, y)`                      | `FlowCanvas.tsx:119,167,236`; tests                                                                        | yes (see excerpt)                                                                                         |
| `cancel()`                      | `FlowCanvas.tsx:180,200,245`; tests                                                                        | yes (up to 8 writes)                                                                                      |
| `leave()`                       | `FlowCanvas.tsx:171`; tests                                                                                | yes (`hovered`, `portPlus`, `framePlus`, `cursor`)                                                        |
| `hover(x, y)`                   | `FlowCanvas.tsx:145`, internally from `move`/`up`; tests                                                   | yes (up to 4)                                                                                             |
| `beginPan(x, y)`                | only inside this class (240) and the `RightGesture` host callback (101)                                    | one (`cursor`) — no batch needed                                                                          |
| `right` (`RightGesture`)        | `CanvasMenuController.press/release/move` (`src/flow/context-menu.ts:93,106,120`) and `FlowCanvas.tsx:130` | delegates to `beginPan`/`move`/`up`, which this plan batches — **no change to `right-gesture.ts`**        |
| `edges` (`EdgeGestures`)        | only inside `down`/`move`/`up`/`cancel`                                                                    | writes `connectionPreviews`/`connectionTarget` — covered by batching those entry points                   |

Every pointer event reaches the controller through one of the six batched
entry points above, so no other file needs a batch.

Conventions that apply (from `docs/standards.md`):

- §6.1 (lines 220-221): "Use one `batch` only when several writes form one
  invariant; `batch` is not a performance ritual."
- §6.2 (lines 225-242): a component body is one-time setup; derived values
  use `computed`, and an effect must not write a signal it reads. This plan
  adds no effects and no derived state.
- §7.1/§7.2 (lines 285-333): `FlowScene` is the only scene model and
  `CanvasController` is the one pointer router — batching belongs in those
  two classes, not in `FlowCanvas.tsx` event handlers.
- §9: tests beside the subject, one behaviour per test, and "A
  deterministically reproducible bug fix MUST add a regression test that
  fails before it and passes after" (466-468). The work-count tests in this
  plan are those regression tests.

Exemplar for the test style — `src/flow/scene.test.ts:305-325` ("a drag's
overrides notify only the cards it moves") constructs a scene, attaches
`effect` counters, and asserts exact run counts:

```ts
const scene = new FlowScene();
scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
let runsA = 0;
let runsB = 0;
effect(() => {
  scene.cardRect("a");
  runsA += 1;
});
effect(() => {
  scene.cardRect("b");
  runsB += 1;
});
scene.setOverrides(new Map([["a", { x: 90, y: 40, width: 200, height: 84 }]]));
expect(runsA).toBe(2);
expect(runsB).toBe(1);
```

`src/flow/card-geometry.test.ts:32-45` has the same pattern as a `wakes()`
helper. Controller tests use `setup(...)` from
`src/flow/canvas-controller.test.ts:45-92`, which builds a real `FlowScene`,
`CanvasCamera` and a recording `CanvasHost`.

NSH API (from `src/.nsh/types/nsh/index.d.ts:581`): `batch<T>(fn: () => T): T`
— "Runs `fn`, applying its writes together at the end." Reads inside a batch
see the new values. It is already imported elsewhere from `"nsh"`; nothing
new is added to the dependency graph.

## Commands you will need

| Purpose                                       | Command                                                                         | Expected on success                         |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Full gate (typecheck, format, lint, Rust)     | `bun run check`                                                                 | exit 0, zero warnings                       |
| All tests (Rust + headless TSX)               | `bun run test`                                                                  | exit 0, all pass                            |
| Scene tests only                              | `nsh test src/flow/scene.test.ts`                                               | all pass                                    |
| Controller tests only                         | `nsh test src/flow/canvas-controller.test.ts`                                   | all pass                                    |
| Tests by name                                 | `nsh test src/flow/canvas-controller.test.ts --filter "one round"`              | matching tests pass                         |
| Per-step commit counts (optional measurement) | `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace` | prints commits/JS ms/mount items per step   |
| Format check of edited docs                   | `./node_modules/.bin/vp fmt --check docs/standards.md CHANGELOG.md`             | "All matched files use the correct format." |
| Resize-handles tests (step 3b)                | `nsh test src/flow/resize-handles.test.ts`                                      | all pass                                    |

## Scope

**In scope** (the only files you should modify):

- `src/flow/scene.ts`
- `src/flow/scene.test.ts`
- `src/flow/canvas-controller.ts`
- `src/flow/canvas-controller.test.ts`
- `src/flow/resize-handles.ts` (create — step 3b)
- `src/flow/resize-handles.test.ts` (create — step 3b)
- `docs/standards.md` (§6.1 only)
- `CHANGELOG.md` (`### Changed` under `## [Unreleased]`)
- `plans/README.md` (advisor-maintained; the executor updates only this plan's own status row, at the end)

**Out of scope** (do NOT touch, even though they look related):

- `src/components/FlowCanvas.tsx`, `FlowCard.tsx`, `FlowEdges.tsx`,
  `SelectionFrame.tsx`, `SelectionPluses.tsx` — batching at the view layer
  would hide the ownership boundary; these are handled by other work.
- `src/flow/right-gesture.ts`, `edge-gestures.ts`, `connection-gesture.ts`,
  `context-menu.ts` — their writes are already funneled through the entry
  points this plan batches.
- `src/pages/FlowPage.tsx` and every other scene reader — behaviour must not
  need to change there; if a test says otherwise, STOP.
- `src/flow/card-geometry.ts`, `card-content.ts`, `viewport-controller.ts` —
  equality gating of reads is a separate change.
- `src/flow/selection.ts`, `src/flow/card-geometry.ts` — read-only
  dependencies; `resize-handles.ts` IMPORTS the existing helpers
  (`handleAt`, `resizedRect`, `ResizeHandle`) from `src/flow/selection.ts`
  and the geometry helpers it already uses; this plan does NOT modify them.
- No new dependencies, no `any`, no casts. The only new modules are
  `src/flow/resize-handles.ts` and its test, created in step 3b.

## Git workflow

- Branch: `advisor/002-batch-scene-writes` from `main`.
- Commit per logical step (scene batching; controller batching + tests;
  docs/changelog). Conventional Commits with a lower-case imperative subject
  and an explanatory body, matching `git log` — e.g.
  `perf: apply each scene command in one update round` with a body naming the
  measured cost, in the style of `1956ebb perf: keep canvas gestures to one
  update per moved card`.
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line. This is a standing project rule.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md` (the formatter checks Markdown
  and realigns tables; `bun run check` fails on an unformatted README).

## Steps

### Step 1: Add failing regression tests for one-round scene commands

Add to `src/flow/scene.test.ts` (imports already include `effect` from
`"nsh"`; the `node(...)`, `edge(...)`, `snapshot(...)` fixtures at lines 7-33
are reused). These tests FAIL at HEAD and PASS after step 2:

1. **"a group drag step wakes a reader of every moved card once"** — scene
   with cards `a`, `b`, `c`; one `effect` reads `scene.cardRect("a")`,
   `scene.cardRect("b")`, `scene.cardRect("c")` and increments `runs` (1
   initial run). Call `scene.setOverrides(new Map(...))` with a moved rect
   for all three. `expect(runs).toBe(2)` — today it is 4 (one round per
   card). Assert the new rects are visible (`scene.cardRect("a")?.x`).
2. **"dropping a group's overrides wakes its readers once"** — same
   three-card effect; first `setOverrides` for all three, record `runs`,
   then `scene.clearOverrides()`; expect exactly one further run
   (`runs === before + 1`), not three.
3. **"a snapshot updates the selected edge and the lists in one round"** —
   scene with cards `a`, `b` and `edge("a-b", "a", "b")`; `scene.selectEdge("a-b")`;
   one `effect` reads `scene.selectedEdge()`, `scene.nodes().length` and
   `scene.edges().length`. Apply `snapshot([node("a", 40, 40)], [])`. Expect
   exactly one further run (today two: `selectedEdge` clears inside `prune`
   before `nodes`/`edges` are set). After it, `scene.selectedEdge()` is null
   and `scene.edgeCount()` is 0.

**Verify**: `nsh test src/flow/scene.test.ts` (NO `--filter`) → all three
new tests FAIL with the observed run counts (e.g. `expected 2, received 4`),
all pre-existing tests pass. The three new test names are:

1. "a group drag step wakes a reader of every moved card once"
2. "dropping a group's overrides wakes its readers once"
3. "a snapshot updates the selected edge and the lists in one round"

Do NOT use `--filter "once"` — that substring does not appear in the third
test's name, so it would be skipped rather than observed failing. This
failing-first pass is the required before/after evidence; keep the output
for the commit body.

### Step 2: Batch the FlowScene commands

In `src/flow/scene.ts`:

- Change line 7 to `import { batch, signal, type Signal } from "nsh";`.
- Wrap the bodies of `apply`, `applyChangeSet`, `setOverrides`,
  `clearOverrides` and `select` in `batch(() => { ... })`. `apply`'s local
  `const nodes`/`const seen` move inside the arrow. `select`'s early `return`
  (line 186) stays as-is — returning from the arrow is correct; `batch`
  returns the arrow's value, and these methods return `void`.
- Keep every early-out guard (`clearOverrides`'s size check, `select`'s
  equality return) **outside** or inside the batch — but keep them before the
  writes, unchanged in behaviour.
- Replace the per-method "why one invariant" reasoning in one short comment
  each, per §6.1 (comments explain why, not what):
  - `apply`: one viewport snapshot must be visible atomically — readers must
    never see new nodes with old edges.
  - `applyChangeSet`: one command result is one invariant, including the
    overrides it resolves.
  - `setOverrides`: one gesture step's geometry is one state; per-card
    signals stay the granularity of _notification_, not of rounds.
  - `clearOverrides`: a release/cancel restores every card in the same round
    so the connector layer re-records once.
  - `select`: the card selection and the cleared edge selection are one
    selection state.
- Do NOT batch `setConnectionPreviews`, `setConnectionTarget`, `selectEdge`,
  `toggleSelected` (it only calls `select`), or `applyPreviews` — each writes
  one signal, and §6.1 forbids ritual batches.

**Verify**: `nsh test src/flow/scene.test.ts` → all pass, including the three
step-1 tests. `bun run typecheck` (=`nsh check src`) exits 0.

Commit this step (tests + implementation together so the commit is green).

### Step 3: Add failing regression tests for one-round pointer events, then batch the controller entry points

First add to `src/flow/canvas-controller.test.ts` (add `effect` to the
`nsh/test`/`nsh` imports: `import { effect } from "nsh";`):

1. **"a box selection's release never shows a multi-card selection without its frame"** —
   `const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);`
   then `const broken: boolean[] = [];`
   `effect(() => { broken.push(scene.selection().length > 1 && !controller.multiFrame()); });`
   Drive `controller.down(50, 50, false, 1)`, `controller.move(650, 220)`,
   `controller.up(650, 220)`. Finally
   `expect(broken).not.toContain(true)` and
   `expect(controller.multiFrame()).toBe(true)`. At HEAD the effect runs
   after `select(["a","b"])` while `marqueeSelected` is still false, so the
   array contains `true`.
2. **"an idle move onto a card's plus zone updates hover state in one round"** —
   `setup([node("a", 0, 0)])`; an effect reads `controller.hovered()`,
   `controller.portPlus()`, `controller.framePlus()` and `controller.cursor()`
   and counts runs. Call `controller.hover(210, 30)` (the out plus zone, same
   coordinates as the existing test at line 436). Expect exactly one further
   run; also assert `controller.portPlus()` is the expected object
   (`{ nodeId: "a", side: "out", point: { x: 210, y: 30 } }`).

**Verify**: `nsh test src/flow/canvas-controller.test.ts --filter "one round"` →
the hover test fails; `--filter "never shows"` → the frame test fails; all
existing tests pass.

Then in `src/flow/canvas-controller.ts` change line 7 to
`import { batch, signal, type ViewStyle } from "nsh";` and wrap the bodies of
exactly these six public methods in `batch(() => { ... })`:

- `down` (207-315) — a press is one invariant: it must never publish a half-
  updated gesture state.
- `move` (317-383) — one pointer move is one gesture step; the idle branch
  calls `hover`, whose batch then nests (nested batches join the outer
  round).
- `up` (385-425) — a release publishes the selection, the frame flag and the
  resting hover together; this is what stops the plus-mount flash.
- `cancel` (427-442) — a cancelled gesture restores one idle state.
- `leave` (445-450) — pointer exit clears hover, pluses and cursor together.
- `hover` (453-503) — hover state is one derived UI state, not four.

Add one short comment above the group (or at each method) citing the
invariant: a pointer event is one state transition, and readers (selection
frame, pluses, connector layer) must see its final state only. Keep all early
`return`s — they return from the arrow, ending that event's round. Do not
batch `beginPan` (one write), `startDrag`/`selectWithin`/`setPreview`/
`clearPreview` (private helpers already running inside a batched entry
point), `screenRect`, `selectionBounds`, `multiFrame` (readers), or anything
in `right-gesture.ts` / `edge-gestures.ts`.

**Verify**: `nsh test src/flow/canvas-controller.test.ts` → all pass,
including the two new tests. `nsh test src/flow/frame-connection.test.ts` and
`nsh test src/flow/right-gesture.test.ts` → all pass (they drive the same
entry points through the edge gestures and the right-button pan).

Commit this step.

### Step 3b: Extract resize-handle geometry + hit testing into `src/flow/resize-handles.ts` (separate commit, required for the max-lines cap)

Step 3's `batch(() => { ... })` wrappers add roughly 20 code lines to
`src/flow/canvas-controller.ts`. The module is ~484 code lines at HEAD
(non-blank, non-comment) and the `max-lines` rule caps a module at 500, so
the controller would land at approximately 505 code lines and fail
`bun run check`. Move the resize-handle geometry and hit testing into a new
foundation module (`src/flow/`) BEFORE running the full gate. This is a pure
code-motion refactor — no behaviour change — so plan 005's hover-flags mirror
and any later controller plan start from a controller that is comfortably
below the cap.

**Create `src/flow/resize-handles.ts`** as a pure-function foundation module
(imports from `src/flow/selection.ts` and `src/flow/card-geometry.ts` only;
never imports a page, a component, or the store). It owns:

1. `screenRect(scene, camera, id)` — moved verbatim from
   `CanvasController.screenRect` (canvas-controller.ts:117-128). The method
   body uses `this.host.scene()` and `this.host.camera()`; the function
   takes those as explicit parameters and returns the same
   `ScreenRect | null` shape.
2. `handleAtPoint(scene, camera, nodes, x, y)` — moved verbatim from the
   private `CanvasController.handleAtPoint` (canvas-controller.ts:182-205),
   including its "topmost first, a card under the point owns the decision"
   comment. Parameters: the scene (for `nodeAt`, `cardDepth`), the camera
   (for `toWorld`), the live `scene.nodes()` array (passing it in keeps the
   function pure and makes the dependency explicit), and the screen `x, y`.
   Returns the same `{ id: string; side: ResizeHandle } | null`.
3. `cursorForHandle(handle)` — moved verbatim from the module-local
   `cursorFor` function (canvas-controller.ts:583-600), exported.
4. Re-export nothing else; `handleAt` and `resizedRect` continue to be
   imported directly from `src/flow/selection.ts` by callers.

**Update `src/flow/canvas-controller.ts`**:

1. Delete the `screenRect` method, the `handleAtPoint` method and the
   module-local `cursorFor` function.
2. Add `import { screenRect, handleAtPoint, cursorForHandle } from "./resize-handles";`
   alongside the existing flow imports. Remove `handleAt`, `resizedRect`,
   `ScreenRect` etc. from the controller's type imports ONLY if they are now
   unused — the controller still uses `resizedRect` in `move` (line 380),
   so that import stays.
3. Rewrite the three call sites as free-function calls:
   - The `target` / `base` branch inside `down` (canvas-controller.ts:273-291)
     becomes `const target = handleAtPoint(scene, camera, scene.nodes(), x, y);`
     and `cursorFor(target.side)` becomes `cursorForHandle(target.side)`.
     The surrounding `gesturing.set(true)` / `this.gesture = { ... mode: "resize" ... }`
     block stays in `down` (it is controller state, not foundation logic).
   - The hover branch that recomputes the resize cursor at :492-497 calls
     the same two imported functions.
   - `CanvasController.screenRect(id)` is referenced by external callers
     (`src/pages/FlowPage.tsx`, `src/components/...`) — KEEP a thin
     delegating method with the same name and shape, forwarding to the new
     free function:
     ```ts
     /** The screen rectangle of a card, or null when it is not in the scene. */
     screenRect(id: string): ScreenRect | null {
       return screenRect(this.host.scene(), this.host.camera(), id);
     }
     ```
     This keeps the public controller API stable for callers; the lines
     saved come from `handleAtPoint` and `cursorFor` moving out. If a future
     plan wants to drop the delegating method it must update those callers
     itself; do NOT do that here.
   - The `resizedRect(base, side, ...)` call site in `move`
     (canvas-controller.ts:373-381) is unchanged — `resizedRect` is still
     imported from `./selection` as today.

**Create `src/flow/resize-handles.test.ts`** mirroring the existing resize
cases in `src/flow/canvas-controller.test.ts` (search it for `"resizes"` to
find them: "resizes the card from its handle without selecting it first",
"shows a resize cursor over any card's handle", "resizes from anywhere along
an edge", "starts a resize from just outside a corner", "does not resize a
card through the card above it", "prefers a side zone over the east resize
handle"). Each new test:

1. `"screenRect projects a card's world rect through the camera"` — build a
   minimal scene + camera (reuse the setup pattern from
   `canvas-controller.test.ts:45-92`, but you only need a `FlowScene` with
   one `apply`'d card and a `CanvasCamera`), call
   `screenRect(scene, camera, "a")`, assert the projected ScreenRect equals
   the camera-projected world rect; assert `screenRect(scene, camera, "missing")`
   returns `null`.
2. `"handleAtPoint picks the handle of the card under the point"` — place a
   card at a known world rect, call `handleAtPoint` at its `nw`/`ne`/`se`/`sw`
   corners with `radius = 7`, assert each returns `{ id, side }` with the
   expected side; assert a centre-point call returns `null`.
3. `"handleAtPoint prefers the card under the point over a handle that reaches through"` —
   mirror the controller test "does not resize a card through the card above
   it": two stacked cards, point at the upper card's body (not a handle) but
   within reach of the lower card's handle; assert the function returns
   `null` (not the lower card's handle).
4. `"handleAtPoint falls back to the topmost handle in reach when no card is under the point"` —
   point outside every card but within reach of two handles; the card with
   greater `cardDepth` wins.
5. `"cursorForHandle maps each side to its CSS cursor"` — exhaustive over
   `ResizeHandle`: nw/se → `"nwse-resize"`, ne/sw → `"nesw-resize"`, n/s →
   `"ns-resize"`, e/w → `"ew-resize"`. (Covers the switch at
   canvas-controller.ts:583-600.)

These tests are pure-function unit tests; they do not drive a
`CanvasController`, do not need `effect`, and do not need `setup()`.

**Verify**:

- `nsh test src/flow/resize-handles.test.ts` → all five new tests pass.
- `nsh test src/flow/canvas-controller.test.ts` → all pass, INCLUDING the
  pre-existing resize tests at HEAD (the controller's own resize suite must
  still drive the extracted code through `down`/`move`/`hover` and observe
  identical behaviour).
- `bun run check` → exit 0. In particular, `canvas-controller.ts` is now
  comfortably below the 500-code-line cap, leaving headroom for plan 005's
  hover-flags integration.
- `grep -n "function screenRect\|function handleAtPoint\|function cursorFor" src/flow/canvas-controller.ts`
  produces empty output (the implementations have moved out).

Commit this step with subject
`refactor: extract resize-handle geometry from the canvas controller`. The
commit body names the max-lines motivation and that behaviour is unchanged.

### Step 4: Run the whole suite and check for behaviour changes

Batching moves every reader's observation to the end of the pointer event.
The page's selection effect (`src/pages/FlowPage.tsx:377-395`, which opens
the composer when the selection becomes one card) now runs once at the end
of an event instead of between its writes. No assertion should depend on the
old intermediate states.

**Verify**: `bun run test` → exit 0, all Rust and TSX tests pass. If an App
test now fails because it observed an intermediate state, STOP and report
the test name and the assertion — do not adjust the app to preserve the
intermediate state.

### Step 5: Document the invariant rule and the changelog

In `docs/standards.md` §6.1, keep the sentence "Use one `batch` only when
several writes form one invariant; `batch` is not a performance ritual."
(lines 220-221) verbatim and append to the same paragraph: a viewport
snapshot, a change set, one gesture step and one pointer event are each one
invariant, which `FlowScene`'s commands and `CanvasController`'s entry points
therefore batch; a method that writes a single signal stays unbatched.

In `CHANGELOG.md` under `## [Unreleased]` → `### Changed`, add one prose
bullet in the style of the existing entries: dragging a selection updates
the connectors, the selection frame and the merged pluses once per pointer
move instead of once per moved card, and releasing a box selection no longer
mounts and immediately unmounts every selected card's plus buttons.

**Verify**: `./node_modules/.bin/vp fmt --check docs/standards.md CHANGELOG.md`
→ "All matched files use the correct format." Then `bun run check` → exit 0
(zero warnings).

Commit this step.

## Test plan

New tests, all beside their subjects, all required by standards §9 as
regression tests that fail before and pass after:

- `src/flow/scene.test.ts`
  - "a group drag step wakes a reader of every moved card once" (3 cards,
    `setOverrides`, effect run count).
  - "dropping a group's overrides wakes its readers once" (`clearOverrides`).
  - "a snapshot updates the selected edge and the lists in one round"
    (effect over `selectedEdge`/`nodes`/`edges`, then `apply`).
- `src/flow/canvas-controller.test.ts`
  - "a box selection's release never shows a multi-card selection without its
    frame" (effect records the broken intermediate state; asserts it never
    occurred).
  - "an idle move onto a card's plus zone updates hover state in one round"
    (effect over the four hover signals).
- `src/flow/resize-handles.test.ts` (step 3b)
  - "screenRect projects a card's world rect through the camera"
  - "handleAtPoint picks the handle of the card under the point"
  - "handleAtPoint prefers the card under the point over a handle that reaches through"
  - "handleAtPoint falls back to the topmost handle in reach when no card is under the point"
  - "cursorForHandle maps each side to its CSS cursor"

Structural patterns to copy: `src/flow/scene.test.ts:305-325` (effect run
counters) and `src/flow/canvas-controller.test.ts:164-177` ("box-selects only
the cards the marquee covers") for the down/move/up driving style and the
`setup()` host.

Existing suites that are the safety net and must stay green: all of
`src/flow/*.test.ts`, `src/App.test.tsx`, and the Rust tests.

Verification: `bun run test` → exit 0 with the 5 batching regression tests
plus the 5 resize-handles unit tests (10 new tests total) included and
passing.

## Done criteria

- [ ] `grep -n "batch(" src/flow/scene.ts` shows the import plus batches in `apply`, `applyChangeSet`, `setOverrides`, `clearOverrides`, `select`.
- [ ] `grep -n "batch(" src/flow/canvas-controller.ts` shows the import plus batches in `down`, `move`, `up`, `cancel`, `leave`, `hover`.
- [ ] `src/flow/resize-handles.ts` and `src/flow/resize-handles.test.ts` exist; `grep -n "function screenRect\|function handleAtPoint\|function cursorFor" src/flow/canvas-controller.ts` prints empty output (the implementations moved out).
- [ ] `bun run test` exits 0; the five batching regression tests and the five resize-handles unit tests exist and pass (and each regression test was observed failing at the base commit).
- [ ] `bun run check` exits 0 with zero warnings (includes the 500-code-line cap on `scene.ts`, `canvas-controller.ts` and the new `resize-handles.ts`).
- [ ] `docs/standards.md` §6.1 still contains "batch is not a performance ritual" and names the four invariants.
- [ ] `CHANGELOG.md` has the new `### Changed` bullet.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row (this plan only) updated and formatted; the rest of the index is the advisor's.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (the codebase
  drifted since `1956ebb`), in particular if `setOverrides`, `clearOverrides`
  or `hover` gained or lost writes.
- An `App.test.tsx` test fails after step 4 because it observed an
  intermediate state within one pointer event (e.g. a selection without its
  frame, or a composer opened mid-event). Report the test and assertion;
  do not "fix" it by un-batching or by changing the app's expected behaviour.
- A new regression test passes at the base commit — then it is not testing
  the batching and must be rewritten before proceeding.
- Batching appears to require touching `right-gesture.ts`, `edge-gestures.ts`,
  a component, or the page: those were verified to be covered by the six
  entry points; if that proves false, the plan's premise is wrong.
- A step's verification fails twice after a reasonable fix attempt.
- `bun run check` reports a `max-lines` violation in `scene.ts` after your
  edits: stop and report; scene restructuring is a separate plan.
- `bun run check` reports a `max-lines` violation in `canvas-controller.ts`
  AFTER step 3b landed (the resize-handles extraction was already meant to
  bring it under 500): stop and report; do NOT further compress the module.

## Maintenance notes

- Any new `FlowScene` command or `CanvasController` entry point that writes
  two or more signals must wrap those writes in one `batch`, with a comment
  naming the invariant. Single-signal writers stay unbatched (§6.1).
- Follow-up work builds directly on this: keyed per-card selection/hover
  flags (a separate plan) are written inside these same batches, in the
  writer methods — never from an effect, which would glitch one round behind
  and flash the plus buttons.
- An identical-viewport read still re-runs every reader once (round
  elimination is a separate change about record identity and per-card rect
  signals); this plan only removes the _multiple_ rounds per event.
- Measuring: the advisor's numbers came from the optimized headless engine
  (`nsh test ... --trace`) and a release Windows host; `bun run dev` is a
  debug host and reads ≈2.5× high. Frame budgets are manual targets and
  MUST NOT be asserted in CI (standards §8.2).
- A reviewer should check that no reader depended on the old intermediate
  states, that early returns still return from the batch arrow (not skipping
  any write), and that no single-signal method grew a ritual batch.
