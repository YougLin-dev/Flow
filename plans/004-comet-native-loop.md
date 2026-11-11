# Plan 004: Run the connector comet as a native loop that pauses and respects Reduce Motion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/components/FlowEdges.tsx src/components/FlowCanvas.tsx src/flow/edge-flow.ts src/flow/edge-flow.test.ts src/flow/edge-layer.ts src/flow/edge-layer.test.ts src/flow/camera.ts src/flow/camera.test.ts src/flow/viewport-controller.ts CHANGELOG.md docs/architecture.md docs/testing.md plans/README.md`
> `plans/README.md` exists and is advisor-maintained; a parallel executor does
> not edit the index, while a standalone executor updates only this plan's
> status row at completion.
> **Dependency**: `plans/003-edge-geometry-once.md` must be DONE. Its changes
> are expected: `FlowEdges.tsx` uses `connectorLayerBox(props.scene)` and one
> saved `{ edge, ports }` array for its baseline/comet loops, and creates the
> new `edge-layer.ts`/test. Confirm its DONE row in `plans/README.md` too.
> Compare only the remaining excerpts below. Any mismatch NOT explained by
> 003 is a STOP condition. Do not undo 003's box computation while merging.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/003-edge-geometry-once.md`
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Revised**: commit `c56ba0e`, 2026-11-10 after the first execution — the
  Escape-trace criterion measured the wrong quantity. The selecting drag's
  11–13 commits are marquee-preview/hover/selection work that is identical at
  the base (measured: ~11 there); the comet never runs before the selection.
  The measurable win is the whole-scenario runtime (5.2 s at the base versus
  1.3 s after this plan) and the disappearance of the repeated 1-op timer
  commits that the old JS interval emitted after selection. The criterion now
  asks for those facts rather than an absolute drag-step commit count.

## Why this matters

The connector comet is stepped by a JS interval approximately every 33 ms
whenever any card is selected, even an unconnected card or an invisible comet.
These repeated updates keep headless app-test steps waiting for quiet: at
`1956ebb` the measured Escape scenario took 5.2 s (previously 1.4 s), with 56
and 44 commits under two selection-related steps. The comet currently ignores
`reduceMotion()`, and its strokes are guarded only for card drags, not camera
pans/zooms/fits or following plus buttons.

Use an NSH native 36-step loop on the same animated wave, retaining all 48
pieces, the trail, and resting selected-connector highlight. Run the loop only
when at least one connector touches the selection and Reduce Motion is off.
Suppress the expensive comet strokes above the existing four-connector
threshold during card or camera movement and plus-follow, but let the native
phase continue. This should restore fast idle settling and respect the user's
motion preference without changing the design.

## Current state

### Plan 003 state and the code that remains

`src/flow/edge-layer.ts` must already expose `connectorLayerBox(scene)`.
`FlowEdges.tsx` still has the existing animated alpha graph, theme-driven
baseline draw, and `GESTURE_FLOW_EDGES = 4`; only its box handling and
per-draw duplicate port resolutions were removed by 003.

At `1956ebb`, `src/components/FlowEdges.tsx:38-44` defines:

```ts
const FLOW_THICKNESS = EDGE_THICKNESS + 1;

/** Above this many flowing connectors, a gesture that moves or resizes
 * cards draws the resting highlight only ... */
const GESTURE_FLOW_EDGES = 4;
```

The interval owner at lines 64-92 is the code this plan removes:

```ts
const wave = createAnimatedValue(1);
let step: number | null = null;
let began = 0;
const stopWave = (): void => {
  if (step === null) return;
  clearInterval(step);
  step = null;
};
cleanup(stopWave);
effect(() => {
  if (props.scene.selection().length > 0) {
    if (step !== null) return;
    began = Date.now();
    step = setInterval(() => {
      wave.set(flowWave(Date.now() - began));
    }, FLOW_STEP_MS);
    return;
  }
  stopWave();
  wave.set(1);
});
```

The next lines 94-100 build the shared alpha timeline; retain them exactly:

```ts
const alphas: readonly AnimatedNode[] = Array.from({ length: FLOW_SEGMENTS }, (_, index) =>
  wave.interpolate(flowPass(index)),
);
```

The comment at lines 65-70 incorrectly mentions `lineDashOffset` and an
approximately 30 Hz timer; replace it with the new native explanation.

In the current drawing, `new Set(props.scene.selection())` and
`edgeFlows(edge, flowing)` decide all highlighted connectors, counting
`flowingEdges`. A selected-edge accent takes priority. The comet guard at
lines 172-177 is only:

```ts
if (flowing.size === 0) return;
if (props.scene.overrides().size > 0 && flowingEdges > GESTURE_FLOW_EDGES) return;
```

Keep drawing the baseline resting highlight even when the animated pieces
are hidden. 003's saved `{ edge, ports }` array supplies the same loops; do
not reintroduce `edgePorts` calls while changing their flow condition.

`src/flow/edge-flow.ts:14-36` owns `FLOW_CYCLE_MS = 1200`,
`FLOW_SEGMENTS = 48`, `FLOW_TRAIL = 0.24`, `FLOW_HEAD_ALPHA = 0.9`, and
`FLOW_REST_ALPHA = 0.5`. Lines 38-45 contain the obsolete timer helper:

```ts
export const FLOW_STEP_MS = 33;

export function flowWave(elapsed: number): number {
  const cycle = FLOW_CYCLE_MS;
  const phase = ((elapsed % cycle) + cycle) % cycle;
  return 1 - (2 * phase) / cycle;
}
```

Delete `flowWave` and its dedicated sequence test (`src/flow/edge-flow.test.ts:
82-100`). Keep `flowPass`, `edgeFlows`, all trail/head assertions, and the
complete edge fixture at lines 15-25. Define `FLOW_STEPS = 36` with a comment
that it is a CSS `steps()` count (approximate old 33 ms cadence), not a timer
interval. Preserve the approximate 33 ms cadence through that step count;
do not retain unused timer constants.

### Every camera mutation has a single verified owner

The moving flag belongs on **`CanvasCamera`**, not `ViewportController`. That
is a deliberate, minimal departure from the suggested viewport location: it
is the one object all camera writes reach.

`src/flow/camera.ts:40-42` declares:

```ts
export class CanvasCamera {
  readonly view = signal<CameraView>({ x: 0, y: 0, scale: 1 });
```

Its mutation points are:

- `panBy` at `src/flow/camera.ts:93-97`: zero deltas return; otherwise set
  `view` once.
- `zoomAround` at 103-113: rejects non-finite/non-positive factors, clamping
  no-ops and reversed clamps; a real zoom sets `view` and returns true.
- `fit` at 115-138: returns current scale without a write for invalid bounds,
  otherwise sets a centered, finite view.
- private `set` at 140-149, used by the x/y/scale setters: after finite and
  no-change checks, it sets `view` once.

All app routes reach these methods:

- `src/flow/viewport-controller.ts:119-136`: `zoomAround`/`panBy`, including
  keyboard, hand-tool, and right-drag panning.
- `viewport-controller.ts:85-111,152-156`: Fit, resize fitting, and search
  reveal's `focusBounds` reach `camera.fit`.
- `src/components/FlowCanvas.tsx:208-215`: pinch invokes its `onZoom` and
  `onPan`; `src/pages/FlowPage.tsx:435-437` wires them to the viewport.
- `src/pages/FlowPage.tsx:429,287`: first layout and an open-failure fallback
  call `camera.fit` directly; this is why a viewport-local moving flag would
  be incomplete.
- `src/flow/right-gesture.ts:59-72` delegates to CanvasController's
  beginPan/move/up; it needs no new camera state or timer.

The page currently owns the camera but disposes only the viewport at
`src/pages/FlowPage.tsx:401-413`. **Do not edit FlowPage.** Put a single call
to `this.host.camera()?.dispose()` in `ViewportController.dispose` (lines
138-142), after its own `cancelAnimationFrame` and timeout cleanup. This gives
the page-owned camera exactly one disposal path without a second signal or
state owner. Tests constructing camera alone dispose it in their own cleanup.
Do not also call `camera.dispose` from the page.

### NSH facts verified at the pinned engine revision

Generated declarations in `src/.nsh/types/nsh/index.d.ts` supply
`Animated.loop(animation, { resetBeforeIteration? })`, `TimingConfig.frameRate`,
`Easing.steps(count, position?)`, `CompositeAnimation.start`/"Runs it (again)",
and the reactive `reduceMotion: Accessor<boolean>`. The engine pin is
`f0b4659`; do not edit its generated types or that pin.

A tiny external headless probe at
`C:\Users\Y\AppData\Local\Temp\claude\E--code-mine-oflow\plan-probes\004`
confirmed this exact configuration:

```ts
const wave = createAnimatedValue(1);
const loop = Animated.loop(
  Animated.timing(wave, {
    toValue: -1,
    duration: 1200,
    easing: Easing.steps(36),
    frameRate: 30,
  }),
  { resetBeforeIteration: true },
);
```

Its final `nsh test App.test.tsx` passed both cases in 0.355 s total:

- A system-clock `press("Start")` followed by `press("Stop")` took 0.336 s,
  not repeated 2 s quiet timeouts. The loop was actually mounted/started by
  the app, not merely described by imported test objects.
- Manual-clock samples showed correct step-end descent; at 1,200 ms the wave
  reset to `1`, then fell normally through the next cycle. `stop(); wave.set(1)`
  parked it at `1`, and a following `loop.start()` began again at `1`.
- Reading a native value through a press can advance the manual clock by one
  display frame before the promise publishes its result. Do not introduce
  fragile exact-cycle-time App assertions from this probe.
- `frameRate: 30` lowers frame frequency only on platforms capable of doing
  so. `nsh-pr/docs/dev/animation.md:126-133` explicitly says Windows runs at
  the screen's rate.
- `nsh-pr/crates/nsh-core/src/animation/graph.rs:338-364` restores the first
  run's starting values before every iteration when reset is true.
- `nsh-pr/crates/nsh-testing/src/headless/mod.rs:1213-1224` ignores endless
  animations for quiet on system time; manual-clock settling checks engine
  idle rather than waiting out the native loop.

On Windows `nsh-pr/crates/nsh-platform-windows/src/canvas.rs:269-312` returns
`Damage::None` when no canvas animation slot's value changed. Between CSS
steps there should therefore be no re-record; headless does not prove paint,
so the real Windows check and STOP condition in Step 5 are mandatory.

### Repository rules, quoted for this change

- `docs/standards.md` §6.2 lines 227-240: "Values derivable from other state
  MUST use `computed` (or a cheap closure), not a second signal written by an
  effect. An effect MUST synchronize an external system ... and MUST NOT write
  a signal it also reads." "NSH does not accept signal writes from inside the
  canvas draw/layout computation". The native loop effect is therefore only
  lifecycle synchronization; `draw` never writes `wave` or another signal.
- §6.3 lines 275-277: "new camera animation MUST honor `reduceMotion()`".
  This comet also must: reduced motion leaves the resting highlight but no
  animated pieces or native loop.
- §7.1 lines 294-307: CanvasCamera owns logical x/y/scale and changes the
  camera transform, not cards; no second screen mapping or per-card camera
  motion code.
- §7.3 lines 336-342: every owned timer/resource has exactly one idempotent
  cleanup.
- §8.2 lines 375-384: "App code MUST NOT ... write a signal every frame."
  Performance budgets are measured manually and "MUST NOT be asserted in CI
  without a stable benchmark".
- §9 lines 443-474: tests are beside their subject, use `nsh/test`, one
  behavior each, manual clocks instead of sleeps, and canvas scene/camera or
  overlay evidence rather than pixels.
- §3.2 lines 83-101: foundations never import pages/stores; components do
  not import the store. Use named exports, strict types, no `any`, `!` or
  unsafe narrowing.
- §10 lines 476-502: behavior changes update canonical docs and the
  changelog; no ADR is needed for this performance/lifecycle refactor.

ADR 0005 (`docs/adr/0005-connector-canvas-strokes.md:25-35`) retains one
shared native `<Canvas>` for connectors. No second canvas, new connector
view layer, retained scene, or per-frame Rust/FFI path belongs here.

`docs/architecture.md:211-225` currently describes the comet's timer-like
step behavior. Update that section with native loop ownership and draw
suppression. `docs/testing.md:156-157` already warns about real timer tests;
keep new scheduler tests deterministic and only add the manual-clock/endless
animation facts if plan 001 has not already documented them.

## Commands you will need

| Purpose                  | Command                                                                             | Expected on success                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Pure flow policies       | `nsh test src/flow/edge-flow.test.ts`                                               | exit 0, all decision tests pass                                                      |
| Camera settling          | `nsh test src/flow/camera.test.ts`                                                  | exit 0, all fake-scheduler tests pass                                                |
| 003 regression           | `nsh test src/flow/edge-layer.test.ts`                                              | exit 0                                                                               |
| App regressions          | `nsh test src/App.test.tsx`                                                         | exit 0                                                                               |
| Manual slow-flow trace   | `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace`     | exit 0; selection drag under 10 commits and total under 2.5 s, measured not asserted |
| Type check               | `nsh check src`                                                                     | exit 0                                                                               |
| Full static gate         | `bun run check`                                                                     | exit 0, no warnings                                                                  |
| Rust and TSX test gate   | `bun run test`                                                                      | exit 0, all pass                                                                     |
| Real desktop tests       | `bun run test:host`                                                                 | exit 0; report actual OS/evidence                                                    |
| Plan Markdown formatting | `./node_modules/.bin/vp fmt --check plans/004-comet-native-loop.md plans/README.md` | exit 0                                                                               |

For idle profiling run `bun run dev -- --fps -v`; use `bun run dev:release --
--fps -v` if plan 001 has provided that optimized-host command. Do not set
`FLOW_FPS=1` while measuring idle: its overlay forces every display refresh.

## Scope

**In scope** (only these files may be edited):

- `src/components/FlowEdges.tsx`
- `src/components/FlowCanvas.tsx`
- `src/flow/edge-flow.ts`
- `src/flow/edge-flow.test.ts`
- `src/flow/camera.ts`
- `src/flow/camera.test.ts`
- `src/flow/viewport-controller.ts` — only the single camera-disposal call
- `CHANGELOG.md`
- `docs/architecture.md`
- `docs/testing.md`
- `plans/README.md` — only this plan's final status row

`src/App.test.tsx` is deliberately not in scope: retain the existing Escape
flow as regression evidence and test policy at the pure layer. If an App test
fails, investigate the actual regression rather than modifying its timer
expectations in this plan.

**Out of scope** (read/drift-check only, or do not change):

- `src/flow/edge-layer.ts` and `edge-layer.test.ts` — 003 dependency.
- `src/pages/FlowPage.tsx` — no new moving flag, camera callback, or cleanup
  duplicate. Its existing viewport/camera wiring is sufficient.
- `src/flow/canvas-controller.ts`, `src/flow/right-gesture.ts`,
  `src/flow/scene.ts`, other components and per-card bindings.
- `src/native/**`, `src/.nsh/**`, `package.json`, `bun.lock`, NSH fork and
  engine pin. Do not create a new runtime dependency.
- A new connector canvas, lower segment count, changed trail, new animation,
  or per-frame FFI. No committed wall-clock or FPS budget assertions.

## Git workflow

- Branch from `main` at a base with 003 integrated: `git switch -c
  advisor/004-comet-native-loop`.
- Commit per logical step with conventional imperative subjects and bodies;
  match `1956ebb perf: keep canvas gestures to one update per moved card`.
  Example: `perf: drive the connector comet natively`.
- Suggested commits: camera settling; pure decisions; native loop/pause/docs;
  the fallback only if profiling necessitates it. Keep gate green at each
  commit where practical.
- NEVER add AI attribution: no AI `Co-Authored-By:` trailer and no
  "Generated with ..." line, as a standing project rule.
- Do not push or open a PR.
- At completion update only this plan's status row in `plans/README.md`,
  then run `./node_modules/.bin/vp fmt plans/README.md`; do not construct
  the advisor's index if it is absent — report that.

## Steps

### Step 1: Add a camera-wide 150 ms moving flag with a fake scheduler

In `src/flow/camera.ts`, export `CAMERA_MOVE_SETTLE_MS = 150` and add a
private `moving` signal, public `moving: Accessor<boolean>`, one stored
settle timer, and idempotent `dispose()`. Use named types and import
`type Accessor` from `nsh`.

Use constructor options instead of global mocks. `CameraScheduler` (an
interface) exposes `schedule(callback, delay)` returning a handle and
`cancel(handle)`. The handle type may be `ReturnType<typeof setTimeout>`,
with production using global `setTimeout`/`clearTimeout`; a fake then matches
it using an appropriately typed test handle, without `any` or casting to
narrow. Alternatively define a minimal exported `CameraTimer` object
interface so production wraps its real handle and tests use their own object.
`CameraOptions` (also an interface) may provide `scheduler` and `settleMs`,
both optional; production defaults are 150 ms and real timers. Keep the
constructor callable as `new CanvasCamera()`, existing tests included.

Every _real_ view write must call one private `changed()` immediately after
it sets `view`. It marks moving true, cancels the previous timer, and arms
one delayed callback that clears the handle and sets moving false. Connect
all three paths: `panBy`, `zoomAround`, and the private `set` used by x/y/
scale/fit. A rejected/no-op mutation must not start or extend motion; keep
clamp/finite behavior and return values unchanged.

`dispose()` only cancels the outstanding timer and sets moving false; it
preserves `view`, permits repeated calls, and prevents an old canceled callback
from doing later work. Do not make the native renderer call `moving` on each
frame; components read this small accessor only when drawing is invalidated.

Add the one lifecycle hook at `src/flow/viewport-controller.ts:138-142` in
`dispose()`:

```ts
this.host.camera()?.dispose();
```

Do not put another camera dispose in FlowPage. There is no new `moving` state
in ViewportController; it just owns the page's camera lifetime through this
existing cleanup point.

In `src/flow/camera.test.ts`, add a fake scheduler that tracks the one active
handle/callback, last delay, writes/cancel calls, and exposes a manual `fire`
operation. Give each test a local camera and call `dispose` in its body or
`afterEach`, without sharing a camera between tests.

Add distinct cases (using existing tests at `camera.test.ts:40-51` as style):

1. A real `panBy` makes moving true, another write replaces the one timer,
   and firing the latest callback makes it false; delay equals 150.
2. Direct x/y/scale, a real zoom, and a real fit all start the moving state.
3. Zero pan, rejected non-finite values, a clamped no-op zoom, invalid fit,
   and assigning identical view values do not start/extend motion.
4. `dispose` cancels an active timer and repeated dispose is harmless; manual
   invocation of an old canceled fake callback cannot turn it moving again.
5. Once fired, the next real camera change re-arms correctly.

Never use a real `app.wait`, `Date.now`, sleep, or frame time to test this.

**Verify**: `nsh test src/flow/camera.test.ts && nsh check src` → all
real/no-op and fake-scheduler tests pass and types/errors are clean.
`grep -n "dispose" src/flow/viewport-controller.ts` shows the one added
camera-cleanup call outside the method name itself.

### Step 2: Make flow eligibility and pause decisions pure and testable

In `src/flow/edge-flow.ts`, add these named exports with explicit return types:

```ts
export function flowingEdgeCount(
  edges: readonly EdgeSummary[],
  selected: ReadonlySet<string>,
): number;

export function cometRuns(flowing: number, reducedMotion: boolean): boolean;

export interface CometShownOptions {
  readonly flowing: number;
  readonly reducedMotion: boolean;
  readonly dragging: boolean;
  readonly paused: boolean;
  readonly limit: number;
}

export function cometShown(options: CometShownOptions): boolean;
```

`flowingEdgeCount` must apply existing `edgeFlows` once to each supplied edge;
an edge whose both endpoints are selected counts once. `cometRuns` is
`flowing > 0 && !reducedMotion` and has no pause/drag inputs. `cometShown` is:

```ts
cometRuns(options.flowing, options.reducedMotion) &&
  !(options.flowing > options.limit && (options.dragging || options.paused));
```

`limit` is the current 4 at the view, allowing equality-boundary unit tests.
Do not derive it from FLOW_SEGMENTS. Moving/plus-follow does not stop native
phase; that is controlled by the component effect from `cometRuns` alone.

Delete `flowWave` and the timer-only import/case in `edge-flow.test.ts`; add
`FLOW_STEPS = 36` and its CSS steps() documentation. Do not rename the copied
App fixture or touch `FLOW_CYCLE_MS`, trail, head/rest alpha, `flowPass`, or
`FLOW_SEGMENTS = 48`.

Add focused cases following the existing `edge` fixture at
`edge-flow.test.ts:15-25`:

- `flowingEdgeCount` handles empty selections/unconnected selections, one
  incoming and outgoing connector, multiple connectors, and does not double-
  count a connector between two selected cards.
- `cometRuns` false for zero or reduced motion; true only for flowing>0 and
  allowed motion.
- `cometShown`: 5 (>4) edges plus drag, camera/plus pause, or both returns
  false; 4 edges with the same activities returns true; running with 5 and no
  activity returns true; zero or Reduce Motion always returns false.
- The existing alpha/head/trail tests must stay exactly intact apart from the
  deleted timer-wave case.

**Verify**: `nsh test src/flow/edge-flow.test.ts` → all tests pass, including
boundary values 4 and 5, and `! grep -n "flowWave\\|setInterval"
src/flow/edge-flow.ts` exits 0 with empty output.

### Step 3: Drive the wave natively and wire paused overlay/camera motion

In `src/components/FlowEdges.tsx`, import `Animated`, `Easing`,
`type Accessor`, and `reduceMotion` from `nsh`, plus `cometRuns`,
`cometShown`, and `FLOW_STEPS` from `edge-flow`. Remove the old interval
imports. Add a required prop:

```ts
readonly paused: Accessor<boolean>;
```

Document it: true while the camera is moving/settling or a card/selection
frame plus follows the pointer. Do not pass `gesturing`, which includes other
interaction and misses camera motion.

Create a `flowingCount` memo with `computed`, in the component body, calling
`flowingEdgeCount(props.scene.edges(), new Set(props.scene.selection()))`.
Its result is shared by the loop effect and draw; no second selection scan or
selection-length eligibility. Then construct exactly:

```ts
const wave = createAnimatedValue(1);
const loop = Animated.loop(
  Animated.timing(wave, {
    toValue: -1,
    duration: FLOW_CYCLE_MS,
    easing: Easing.steps(FLOW_STEPS),
    frameRate: 30,
  }),
  { resetBeforeIteration: true },
);
let running = false;
```

One effect reads `cometRuns(flowingCount(), reduceMotion())`, no pauses or
card-override flags. On false, if running, call `loop.stop()`, set local
running false, then `wave.set(1)`. On true and stopped, set local running true,
`wave.set(1)`, and `void loop.start()`. `void` is intentional for the endless
promise (no `.then` or rejection collection). A `cleanup` stops an active
loop, resets local state, and parks wave at 1. No active false case should
ever start it; keep cleanup idempotent. Do not put `paused`, `wave.set`, or
loop start/stop calls in draw.

Retain all 48 alphas and current baseline colors/strokes. At the end of
baseline drawing, replace the selection-size check with:

```ts
if (!cometRuns(flowingCount(), reduceMotion())) return;
if (flowingEdges > GESTURE_FLOW_EDGES && (props.scene.overrides().size > 0 || props.paused()))
  return;
```

Alternatively call the tested `cometShown` with these exact inputs; do not
let its false case disable the resting highlights. **Always read**
`props.paused()` in draw even at/under the threshold, so the canvas is
subscribed to a future pause change; a short-circuit that only reads it for

> 4 edges would miss the 4→5 threshold transition without another invalidation.
> For example, read `const paused = props.paused()` before the guard and pass
> that boolean. Keep `FLOW_SEGMENTS`, wave interpolations, and wave continuity
> while paused unchanged.

Update outdated comments: native stepped loop, not JS interval/
`lineDashOffset`; frameRate is a platform cap and Windows may tick at display
rate while unchanged slots skip re-record; `GESTURE_FLOW_EDGES` includes
camera movement and both following plus types.

In `FlowCanvas.tsx` at the existing connector element (line 270 before 003/004):

```tsx
<FlowEdges
  scene={props.scene}
  paused={() =>
    props.camera.moving() ||
    props.controller.portPlus() !== null ||
    props.controller.framePlus() !== null
  }
/>
```

No other page/controller touch is needed: pinch, keyboard/secondary pan,
Fit/reveal, and first/failure fits all pass through CanvasCamera.

**Verify**: `nsh check src && nsh test src/flow/edge-flow.test.ts && nsh test
src/flow/edge-layer.test.ts` → no errors and all tests pass. `! grep -n
"setInterval\\|flowWave\\|FLOW_STEP_MS" src/components/FlowEdges.tsx` exits 0
with empty output, while `grep -n "Animated.loop\\|Easing.steps\\|reduceMotion"
src/components/FlowEdges.tsx` locates the actual native loop and motion guard.

### Step 4: Verify the Escape trace and reduced-motion regression

Run all app tests unchanged. The existing `src/App.test.tsx:113-134` test
"clears the selection with Escape" performs the relevant two-Escape scenario;
it asserts the first closes the composer while leaving selection and the
second clears it. Do not alter it merely to make timing pass, and do not add
a new sleep-based timing assertion.

Read the headless `--trace` carefully. Identify the selection-producing drag,
currently reported by the advisor as `drag(id:flow-canvas, -104pt,
-40pt)` after accounting for fit scale, not the initial hand-tool pan that
creates no selection. The drag's own step markers count marquee preview,
hover and selection/composer commits that exist at the base too; do not use
an absolute drag-step commit count as the criterion. The regression that
matters is what the old JS interval produced after a selection: repeated
1-op commits during the test's waits. The acceptance evidence is (a) the
test's reported total runtime well under 2.5 s versus 5.2 s at the base on
the same machine, and (b) no stream of repeated 1-op commits after the
selection. Record the actual trace numbers; keep them as manual evidence,
not a CI budget. If 002 batching is not present, investigate unexpected
excess commits rather than claiming this plan solves both batching and native
idle cost.

Test reduced-motion _policy_ through the new `cometRuns`/`cometShown` unit
cases, not pixel snapshots. The real-host visual check must select connectors
with `open("./App.tsx", { reducedMotion: true })` in an allowed disposable
manual probe if needed; do not create a component test file just for native
paint pixels. At runtime `reduceMotion()` is reactive and must immediately
stop the loop via the same effect.

Document the owner decisions in `docs/architecture.md:211-225`: native
stepped loop runs only for flowing-edge count>0 and no reduced motion; camera
moving lives in CanvasCamera; 150 ms settle; camera/card drag/plus-follow
suppresses comet at >4 while native phase continues; resting highlight stays.
In `docs/testing.md` add, if not already covered by plan 001, the relied-on
manual clock behavior (endless native loops do not block steps; an animated
promise-read may advance one frame), separating manual performance evidence
from CI assertions — no real timers for this change.

Check no timer except the camera's 150 ms settle exists for this feature. The
native animation is the one loop, heads/trails created once, and 48 unchanged
segments. Reduced Motion never starts it.

**Verify**: `nsh test src/App.test.tsx && nsh test
src/App.test.tsx --filter "clears the selection with Escape" --trace` → both
exit 0; record the wall total and the post-selection commit stream against the
criteria above. `grep -rn "FLOW_SEGMENTS = 48" src/flow/edge-flow.ts` still has exactly
one match.

### Step 5: Check Windows paint at rest, with a guarded fallback

Use the actual Windows host on the 11-card document, with all cards selected
and `FLOW_FPS=1` off. Run `bun run dev -- --fps -v`, or the documented
optimized command from plan 001 when available. Observe idle `nsh::fps`
fields, not only screenshots: commits at rest should be approximately 0/s and
engine approximately 0%. The original measurement was ~22 JS interval wakeups
per second. The comet must still travel at 48 pieces with the same rough
phase. Check camera pan, zoom, pinch if possible, Fit/reveal, and a following
plus with more than four flowing connectors: comet yields to resting highlight
then resumes in phase. With Reduce Motion, the comet is absent; resting line
highlights remain. Do not treat FLOW_FPS overlay frames as idle comet cost.

If the trace shows **canvas share/paint increasing with display fps at rest**
between steps, Windows is re-recording each display frame despite unchanged
slots. STOP-and-fallback or STOP with host logs if even fallback fails. The
only authorized fallback:

1. Restore a timer that computes the existing monotone 1→-1 wave (retain or
   reintroduce its pure helper with deterministic tests), not a new easing
   library or engine change.
2. Start it from `cometRuns` only, and **while `cometShown` is false** with
   > 4 + drag/paused, do not write wave values — let phase derive from a
   > monotonic elapsed timeline, just as native loop phase continues. Do not
   > run a hidden/high-frequency interval while camera motion/plus follow
   > suppresses the comet.
3. When returning to rest, publish a value based on that phase and only then
   resume wave steps; no JS activity while no flow/reduced motion/no flow after
   selection. Keep the effect, cleanup, pure policy tests and pausing exactly
   as above. Do not restore `selection().length > 0` as the start condition.
4. Check the trace/idle engine again; if the fallback cannot prevent needless
   continuous commits or re-records, leave that part uncommitted and STOP with
   measurements and precise NSH evidence. Do not alter `nsh-pr`.

**Verify**: `bun run test:host` exits 0 and host `nsh::fps` observations are
recorded separately from automated evidence. No display-rate full canvas
re-record occurs, and the motion/preferences behavior meets the unit policy.

### Step 6: Update changelog and run all Gates

Edit the existing `CHANGELOG.md` Unreleased `### Added` comet bullet at
lines 16-23: same 48-piece comet, now driven by a native stepped loop, only
while selected endpoints actually have flowing connectors and Reduce Motion
is off. Mention camera/plus-follow suppression above the threshold and the
resting selection highlight; frameRate is a requested cap, not a claim of
fixed Windows 30 Hz. Do not add absolute FPS claims. If a fallback was used,
the bullet must accurately describe its guarded timer instead.

Run `bun run check`, `bun run test`, and:

```sh
./node_modules/.bin/vp fmt --check src/components/FlowEdges.tsx src/components/FlowCanvas.tsx src/flow/edge-flow.ts src/flow/edge-flow.test.ts src/flow/camera.ts src/flow/camera.test.ts src/flow/viewport-controller.ts CHANGELOG.md docs/architecture.md docs/testing.md plans/004-comet-native-loop.md
```

If `bun run check:fix` changes anything out of scope, revert only those
formatting changes and report; never include large format-only edits. Update
this plan's row in the advisor index after all automated and host evidence is
recorded, then format the index as directed. Do not commit the outside probe.

**Verify**: `bun run check` and `bun run test` each exit 0; formatter says
"All matched files use the correct format." `git status --short` lists only
in-scope files plus the README status row and no src/.nsh/native churn.

## Test plan

- `src/flow/edge-flow.test.ts`: add `flowingEdgeCount` cases for zero,
  unrelated selection, two-way selected edge (once), multiple edges. Exhaust
  `cometRuns` and `cometShown` flags at 4 and 5 edges, including pause-only,
  drag-only, both, neither, reduced motion always false. Retain all alpha,
  trail and head tests; only obsolete `flowWave` chronology is removed.
- `src/flow/camera.test.ts`: per operation, actual writes start moving,
  no-ops do not, repeated changes hold a single re-armed 150 ms settle timer,
  its manual fake fire stops moving, and repeated dispose safely cancels.
  Existing `camera.test.ts:40-51` supplies pan/clamp fixture style. All
  scheduling is explicit callback invocation, no real `wait`/`Date.now`.
- `src/flow/edge-layer.test.ts`: unmodified plan 003 regression suite must
  remain green; no geometry work is deferred into this plan.
- `src/App.test.tsx`: unmodified at scope level; "clears the selection with
  Escape" is the flow used for the manual `--trace` evidence (<10 commits on
  selecting drag/<2.5 s total), never convert these into brittle CI budgets.
- Structural patterns: `card-geometry.test.ts:32-45` for effect counting,
  pure `edge-flow` fixtures, fake scheduler for timer ownership. No new
  component `.host.test.tsx` for pure policy or platform-independent logic.
- Verification: all focused commands in Steps 1-4 pass; `bun run test` runs
  full Rust/TSX suite; `bun run test:host` is separately reported on Windows.

## Done criteria

- [ ] `grep -n "Animated.loop\\|Easing.steps(FLOW_STEPS)\\|reduceMotion"
      src/components/FlowEdges.tsx` verifies native driver and motion guard;
      `grep -n "FLOW_SEGMENTS = 48" src/flow/edge-flow.ts` retains 48 pieces.
- [ ] In the normal native-loop implementation, `! grep -n
      "setInterval\\|flowWave" src/components/FlowEdges.tsx
      src/flow/edge-flow.ts` exits 0 with empty output. A fallback documented
      under Step 5 instead has no wave writes while its comet is hidden for
      drag/camera/plus pause; its pure helper and guarded timer are explicitly
      inspected, not rejected merely for containing those names.
- [ ] `grep -n "moving" src/flow/camera.ts
      src/components/FlowCanvas.tsx` and `grep -n "camera()?.dispose"
      src/flow/viewport-controller.ts` verify camera-wide pause and disposal;
      `FlowPage.tsx` has no secondary moving/camera-dispose signal.
- [ ] Every pan/zoom/fit route is covered by tests at the single camera seam;
      `paused` is always read by draw and four-edge threshold semantics remain exact.
- [ ] `nsh test src/flow/edge-flow.test.ts`, `nsh test
      src/flow/camera.test.ts`, `nsh test src/flow/edge-layer.test.ts`,
      and `nsh test src/App.test.tsx` each exit 0.
- [ ] The Escape `--trace` runs under 2.5 s (5.2 s at the base on the same
      machine) and shows no repeated stream of 1-op timer commits after the
      selection, recorded as manual evidence, not a CI assertion.
- [ ] `bun run check` exits 0 with no warnings and `bun run test` all pass;
      `bun run test:host` and native paint evidence are reported.
- [ ] No Windows display-rate re-record of an unchanged comet, no reduced-
      motion animation absent resting highlight, no idle timer when no flow.
- [ ] `git status --short` shows only in-scope source/docs/changelog and the
      plan's README status update; no NSH/generated/probe artifacts.
- [ ] Actual git commits have no AI attribution, no push or PR was performed.

## STOP conditions

Stop and report (do not improvise) if:

- 003 is not DONE or its memo/shared ports are missing; or any drift excerpt
  differs for a reason other than the named dependency.
- Native `resetBeforeIteration` or start-after-stop deviates from the pinned
  engine on an app-driven external probe; don't hardcode a fresh composite per
  wave or change the animation's look instead.
- A normal mounted `app.press` still waits repeatedly for 2 s on the native
  endless loop, after eliminating familiar finite animations/runner effects.
- Windows re-records the connector canvas every display frame at rest, or
  the constrained Step 5 timer fallback still cannot pause and settle.
- A real camera write bypasses `CanvasCamera` (see all listed paths) or a
  requested additional camera state source becomes necessary. Do not put
  `moving` in FlowPage, Scene, or CanvasController to work around it.
- Drawing/lifecycle requires a signal write in `draw`, pause-driven loop
  effect, duplicate animation loop, second canvas, or non-idempotent cleanup.
- Reducing the motion preference does not stop/hide the comet immediately,
  resting `FLOW_REST_ALPHA` disappears, flow count departs from the drawing's
  selected endpoints, or `FLOW_SEGMENTS`/threshold must change to pass.
- App regressions arise, or performance evidence cannot be taken because the
  actual NSH engine/tooling differs from `f0b4659`. Report the exact failing
  test and engine details; don't change time limits to mask it.
- Any verification fails twice after a targeted correction, a missing
  out-of-scope edit is truly required, or you are tempted to remove tests,
  accept a visible clipping/phase discontinuity, or edit `nsh-pr`.

## Maintenance notes

- **Advisor spec deviation**: motion state is on `CanvasCamera`, verified
  single camera write owner; `ViewportController.dispose` only adds its
  cleanup because FlowPage already owns/disposes that viewport. This avoids
  duplicating all page camera paths and correctly includes initial/failure
  fit. No FlowPage modification is intended or necessary.
- Any future path that animates camera via direct `view.set` must go through
  a CanvasCamera mutation (and `changed`) instead of publishing separately.
  A future viewport zoom animation needs the same settle behavior and Reduce
  Motion rule; it cannot only cover `panBy` and manual `zoomAround`.
- Keep loop eligibility (`cometRuns`) independent from draw pause
  (`cometShown`). Stopping it while a gesture suppresses strokes would reset
  phase in the wrong place; only empty flow, Reduce Motion, and cleanup stop.
- The existing four-edge boundary is strict `> 4`, and 48 segments/trail are
  deliberate visual requirements. Do not "optimize" them silently or turn
  them into CI paint thresholds.
- `frameRate: 30` is advisory on the native graph's capable backends; this
  work does not promise fixed Windows 30 Hz, only skipped re-records when
  canvas values are unchanged, which must stay measured after an NSH pin bump.
- Reduced motion is read reactively wherever decisions live; no user setting
  is to be cached at component construction.
- The outside probe is evidence only, not a repo module/tutorial artifact;
  don't check it in or import it in tests. If official NSH loop tests gain a
  smaller harness, future maintainers may adopt it without changing policy.
- If the fallback is used, retain updates relative to an elapsed monotonic
  timeline and ensure no wave writes while hidden by camera/plus motion. Call
  out remaining timer/test settle impacts instead of claiming native-loop win.
