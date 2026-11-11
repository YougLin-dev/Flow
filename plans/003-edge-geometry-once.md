# Plan 003: Compute the connector layer's box once per change

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/components/FlowEdges.tsx src/flow/connection.ts src/flow/edge-layer.ts src/flow/edge-layer.test.ts src/flow/scene.ts src/flow/scene.test.ts CHANGELOG.md plans/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. `src/flow/connection.ts`,
> `src/flow/scene.ts` and `src/flow/scene.test.ts` are read-only dependencies:
> inspect their drift but never edit them in this plan. `plans/README.md` exists
> and is advisor-maintained; a parallel executor does not edit the index, while
> a standalone executor updates only this plan's status row at completion. This
> plan intentionally precedes plan 004 in `FlowEdges.tsx`; land it before
> changing the comet timer.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Revised**: commit `9e64bca`, 2026-11-10 — corrected the Step 3 traversal
  baselines (the apply-time `prune()` pass and NSH's eager first memo
  computation both traverse once per usable edge), noted that the
  negative-coordinate fixture's `connectionBounds` origin is `-160`, not the
  first executor's hand-derived `-421`, and corrected the Step 4 grep to
  expect exactly one `edgePorts` call (the shared resolution seam) instead of
  zero, which contradicted the required saved-port array. The production memo
  needed no change.

## Why this matters

`FlowEdges` currently walks every connector six times to calculate the same
canvas box: four times for its style bindings and twice more for the drawing's
origin. Each walk resolves every edge's two ports and control-point bounds.
Advisor measurements at commit `1956ebb` put six box passes at about 63 ms of
a 77 ms single-card drag step with 2,935 connectors. One equality-gated memo
reduces this to one walk per changed scene, does no work for repeated style
reads, and suppresses redraws when a small move stays inside the same rounded
canvas box. Connector geometry and visual output must stay identical.

## Current state

The relevant files and their dependencies:

- `src/flow/connection.ts` — pure connector geometry; exports `BoxGeometry`,
  `Point`, `connectionBounds`, `connectorControls`, `mergeBounds`,
  `EDGE_PADDING`, and `splitConnector`.
- `src/flow/scene.ts` — owns the visible scene, selection and transient
  overrides. `scene.edgePorts(edge)` returns `{ from, to } | null`.
- `src/flow/card-geometry.ts` — the exemplar for owned, equality-gated memos.
- `src/flow/card-geometry.test.ts:32-45` — `wakes()` counts `effect` runs.
- `src/flow/scene.test.ts:7-39` — complete `NodeSummary`, `EdgeSummary`, and
  `SceneSnapshot` fixtures to copy; lines 305-325 count geometry updates.
- `src/components/FlowEdges.tsx` — one shared native connector canvas.
- `src/flow/edge-layer.ts` and its test — new files to create; use this seam
  rather than enlarging the already substantial `connection.ts`/`scene.ts`.
- `CHANGELOG.md` — add the measurable performance change under
  `## [Unreleased]` → `### Changed`, currently at line 59.

Two engine facts the Step 3 counters must respect (verified against NSH
`f0b4659` and this plan's own execution):

- `FlowScene.apply` ends in `prune()`, which calls `this.edgePorts(edge)` once
  for every edge in `edgeById` to drop undrawable connectors. A scene that was
  just `apply`'d therefore already has **one traversal per usable edge** before
  any box memo exists.
- NSH's `computed()` runs its function once at construction: `memo()` calls
  `update_computation` immediately, so creating `connectorLayerBox(scene)`
  adds **one more traversal per usable edge**.

So a freshly built `connectorLayerBox` has a baseline of `2 * E` traversals
(`E` from `apply`'s prune, `E` from the eager first computation). Work-count
assertions MUST record `scene.traversals` after `apply` and after memo
construction and assert deltas from those recorded baselines; an absolute
`E`, `1`, or `2 * E` assumption is wrong and must not be enforced.

`src/flow/connection.ts:113-123` already supplies the union operation:

```ts
export function mergeBounds(a: BoxGeometry, b: BoxGeometry): BoxGeometry {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
```

`src/components/FlowEdges.tsx:46-58` owns the rounding that must move:

```ts
const BOX_STEP = 64;

/** `box` rounded outward to whole `BOX_STEP`s, never clipping what it holds. */
function roundOut(box: BoxGeometry): BoxGeometry {
  const x = Math.floor(box.x / BOX_STEP) * BOX_STEP;
  const y = Math.floor(box.y / BOX_STEP) * BOX_STEP;
  const right = Math.ceil((box.x + box.width) / BOX_STEP) * BOX_STEP;
  const bottom = Math.ceil((box.y + box.height) / BOX_STEP) * BOX_STEP;
  return { x, y, width: right - x, height: bottom - y };
}
```

The repeated work is explicit at `src/components/FlowEdges.tsx:105-127`:

```ts
const box = (): BoxGeometry | null => {
  let union: BoxGeometry | null = null;
  for (const edge of props.scene.edges()) {
    const bounds = edgeBox(props.scene, edge);
    if (bounds !== null) union = union === null ? bounds : mergeBounds(union, bounds);
  }
  if (union === null) return null;
  return roundOut({
    x: union.x - EDGE_PADDING,
    y: union.y - EDGE_PADDING,
    width: union.width + EDGE_PADDING * 2,
    height: union.height + EDGE_PADDING * 2,
  });
};
const left = () => box()?.x ?? 0;
const top = () => box()?.y ?? 0;
const width = () => box()?.width ?? 0;
const height = () => box()?.height ?? 0;

const draw = (cx: CanvasRenderingContext2D): void => {
  const edges = props.scene.edges();
  if (edges.length === 0) return;
  const origin = { x: left(), y: top() };
```

Each baseline pass calls `edgePorts`; the comet pass repeats it at
`src/components/FlowEdges.tsx:189-193`:

```ts
for (const edge of edges) {
  if (!edgeFlows(edge, flowing)) continue;
  const ports = props.scene.edgePorts(edge);
  if (!ports) continue;
  const pieces = splitConnector(ports.from, ports.to, FLOW_SEGMENTS);
```

The baseline already uses the ports in the same array order at lines 140-144:

```ts
for (const edge of edges) {
  const ports = props.scene.edgePorts(edge);
  if (!ports) continue;
  const { from, to } = ports;
  const { c1, c2 } = connectorControls(from, to);
```

Match `src/flow/card-geometry.ts:56-67`: construct a memo in an owner, not as
an import-time side effect or inside the draw callback.

```ts
export class CardGeometry {
  readonly position: Accessor<Point | null>;
  readonly size: Accessor<CardSize | null>;

  constructor(rect: () => BoxGeometry | null) {
    this.position = computed(
      () => {
        const value = rect();
        return value === null ? null : { x: value.x, y: value.y };
      },
      { equals: samePosition },
    );
```

Engineering constraints the executor must honor, quoted from
`docs/standards.md`:

- §6.2 lines 227-240: "A component body MUST be one-time setup."
  "Values derivable from other state MUST use `computed` (or a cheap
  closure), not a second signal written by an effect."
  "NSH does not accept signal writes from inside the canvas draw/layout
  computation". Do not set signals in `draw`, and do not create a memo there.
- §3.2 lines 83-99: `src/flow/` is a foundation and may import other
  foundations; "Components, the store and foundations MUST NOT import a page or
  `src/App.tsx`. Foundations MUST NOT import the store."
- §7.1 lines 287-292: "`src/flow/scene.ts` is the only scene model." Do not
  create another retained edge scene or cache the entire document.
- §4 lines 135-159: modules and tests are kebab-case, tests sit beside the
  subject, exports are named, object shapes use interfaces, and no `any`, `!`
  or assertion-based narrowing is allowed.
- §8.2 lines 375-384: per-frame work is proportional to visible cards, not
  the whole document; measured frame budgets are manual targets, not CI
  assertions.
- §9 lines 443-460: tests use `nsh/test`, sit beside the subject, cover one
  behavior each, and assert geometry rather than pixels.

ADR 0005 (`docs/adr/0005-connector-canvas-strokes.md:25-35`) requires one
shared canvas for all viewport connectors, control-point bounds in
`flow/connection.ts`, and geometric hit testing. Do not split connectors into
per-edge views/canvases or add a second gesture-only canvas.

## Commands you will need

| Purpose                              | Command                                                                                        | Expected on success                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Focused tests                        | `nsh test src/flow/edge-layer.test.ts`                                                         | exit 0; every new test passes                             |
| Baseline performance regression test | `nsh test src/flow/scene.test.ts --filter "a drag's overrides notify only the cards it moves"` | exit 0                                                    |
| Type check and lint                  | `nsh check src`                                                                                | exit 0, no errors                                         |
| Full static gate                     | `bun run check`                                                                                | exit 0, no warnings                                       |
| Full headless and Rust tests         | `bun run test`                                                                                 | exit 0, all pass                                          |
| Format only these Markdown files     | `./node_modules/.bin/vp fmt plans/003-edge-geometry-once.md plans/README.md`                   | exit 0                                                    |
| Inspect scope                        | `git status --short`                                                                           | only this plan's source/test/doc edits and the README row |

## Scope

**In scope** (the only files you should modify; create the two marked new):

- `src/components/FlowEdges.tsx`
- `src/flow/edge-layer.ts` (create)
- `src/flow/edge-layer.test.ts` (create)
- `CHANGELOG.md`
- `plans/README.md` — only this plan's status row, at completion

**Out of scope** (do not touch, even though they look related):

- `src/flow/connection.ts` — keep its existing pure geometry; 003 moves the
  layer-specific union/rounding into the new module instead of enlarging it.
- `src/flow/scene.ts`, `src/flow/scene.test.ts` — use their public API and
  fixtures; per-card rect signals and viewport identity belong to plan 007.
- `src/flow/edge-flow.ts`, `src/flow/edge-flow.test.ts` — the comet timer and
  reduced-motion behavior belong to plan 004.
- `src/flow/canvas-controller.ts`, `src/flow/viewport-controller.ts`,
  `src/components/FlowCanvas.tsx`, `src/pages/FlowPage.tsx` — unrelated here.
- `src/.nsh/**` — generated files; never edit or commit them.
- New runtime dependencies, per-edge canvases, retained path caches, or a
  second connector rendering surface. No `performance.now()` assertions or
  large-document time budgets in CI.

Keep `src/flow/scene.ts` as a drift-check path only: read it, do not edit it.

## Git workflow

- Branch from `main`: `git switch -c advisor/003-edge-geometry-once`.
- Commit each logical step with a Conventional Commit and explanatory body.
  Match existing history: `perf: keep canvas gestures to one update per moved
  card` (`1956ebb`) or `refactor: compute the connector layer box once`.
- NEVER add AI attribution: no AI `Co-Authored-By:` trailer and no
  "Generated with ..." line. This is a standing project rule.
- Do not push or open a PR.
- At completion, update only this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`. If the index does not exist,
  report that to the maintainer rather than constructing the advisor's index.

## Steps

### Step 1: Establish the scene fixture and the work-count baseline

Create `src/flow/edge-layer.test.ts` with local helpers copied structurally
from `src/flow/scene.test.ts:7-39`: `node(id, x, y)`, `edge(id, fromId, toId)`,
and `snapshot(nodes, edges)`. Include every required `NodeSummary` field as in
that fixture; do not use a partial cast. Add a fresh `FlowScene` in each test
and apply two nodes at `x=40` and `x=360` with one `a-b` connector.

Write the pure-geometry tests now, importing functions that Step 2 will add:

1. `connectorLayerBounds([])` returns `null`.
2. It ignores an entry whose ports cannot be resolved (`null` in a supplied
   bounds array), returns `null` if all are null, and otherwise merges only the
   present connector boxes.
3. After `EDGE_PADDING` and 64-point outward rounding, the returned box
   contains every connector's full control-point box, including negative world
   coordinates and an edge whose controls reach beyond its port endpoints.
4. A move of less than one `BOX_STEP` that does not cross a rounded boundary
   produces an exactly equal box; crossing that boundary updates the correct
   side without clipping the connector.

For the last two tests use actual `scene.edgePorts(edge)` and
`connectionBounds`, not a simplified straight-line approximation. Assert the
exact expected rounded rectangle for a simple fixture, so pixel clipping at
negative coordinates or at the far edge would fail the test. Compute the
control-point values with the exported `connectionBounds`/`connectorControls`
helpers rather than hand-deriving them; the guard is the rounded rectangle's
exact numbers plus containment of the ports and both controls. (For the
first execution's fixture `node("a", -300, 0)` / `node("b", -100, 140)`,
`connectionBounds` gives `x = -160`, and the rounded layer box is
`{ x: -192, y: 0, width: 192, height: 192 }`.)

**Verify**: `nsh test src/flow/edge-layer.test.ts` → the runner finds the file
and fails only because the new `./edge-layer` exports do not exist yet. This
is the expected red baseline; do not proceed by deleting the tests.

### Step 2: Move layer-specific geometry into an owned memo

Create `src/flow/edge-layer.ts`, importing `type Accessor` and `computed`
from `nsh`, `type EdgeSummary` from `@flow/native`, `type FlowScene` from
`./scene`, and geometry from `./connection`. It must have no import-time
reactive objects or side effects.

Give it three narrow exports:

- `sameBox(a: BoxGeometry | null, b: BoxGeometry | null): boolean` — true for
  the same reference, two nulls, or equal `x`, `y`, `width`, and `height`.
- `connectorLayerBounds(boxes: readonly (BoxGeometry | null)[]): BoxGeometry |
  null` — the exported pure union/padding/round-out function, using exactly
  this name from the tests in Step 1. Union non-null entries with
  `mergeBounds`, subtract `EDGE_PADDING`, add it twice to both dimensions,
  and round outward via `BOX_STEP = 64`. Preserve `roundOut` exactly,
  including floor on the origin and ceil on the far side.
- `connectorLayerBox(scene: FlowScene): Accessor<BoxGeometry | null>` — return
  `computed(() => { ... }, { equals: sameBox })`. The computation must call
  `scene.edges()` exactly once in its loop and resolve each edge through
  `scene.edgePorts(edge)`/`connectionBounds` exactly once per present edge.
  Return `null` when no connector has endpoints.

Use a short comment explaining the invariant: one computation serves all four
style bindings and the drawing origin; equality in the _rounded_ box prevents
an in-place move from resizing the surface. Do not introduce a port cache,
retain resolved scene records, or mutate either function argument.

Remove `BOX_STEP` and `roundOut` from `FlowEdges.tsx`. Leave its old `box`
closure temporarily; Step 3 replaces it.

**Verify**: `nsh test src/flow/edge-layer.test.ts` → the pure box tests all
pass; the file has no unresolved imports and no tests are skipped.

### Step 3: Prove the production memo traverses geometry once per change

Add work-count tests to `src/flow/edge-layer.test.ts`, following the
independent-effect structure of `src/flow/card-geometry.test.ts:32-45`. These
tests exercise the production `connectorLayerBox(testScene)` accessor; a
test-only box memo or a second union/rounding wrapper is not evidence.

Define a local subclass that counts complete geometry traversals at the port
resolution seam, using the real `FlowScene` methods and `override` modifiers:

```ts
class CountingScene extends FlowScene {
  traversals = 0;

  override edgePorts(edge: EdgeSummary): { from: Point; to: Point } | null {
    this.traversals += 1;
    return super.edgePorts(edge);
  }
}
```

Import `EdgeSummary` and the existing `Point` type explicitly for that
signature, not `any` or a narrowing assertion. Each `connectorLayerBox`
recomputation resolves the ports of every scene edge once: one traversal per
edge per box recomputation, with each traversal resolving two anchors. Do not
count port calls or use a `2 * connectors` expression as the traversal count.
Use one connector for the primary count, plus two connectors to prove the count
scales by edges rather than by readers. Return `super.edgePorts(edge)` directly
so the probe cannot change production geometry, port fallback or signal reads.

Build the box exactly once in each test:

```ts
const testScene = new CountingScene();
testScene.apply(snapshot(nodes, edges));
const box = connectorLayerBox(testScene);
let leftRuns = 0;
let topRuns = 0;
let widthRuns = 0;
let heightRuns = 0;
effect(() => {
  box()?.x ?? 0;
  leftRuns += 1;
});
effect(() => {
  box()?.y ?? 0;
  topRuns += 1;
});
effect(() => {
  box()?.width ?? 0;
  widthRuns += 1;
});
effect(() => {
  box()?.height ?? 0;
  heightRuns += 1;
});
```

These four independent accessors model the production style readers. They are
four separate effects, not one effect containing four reads. Record the
counters; do not assume a zero baseline:

- `afterApply = scene.traversals` right after `apply` is `E`.
- Creating `connectorLayerBox(scene)` computes eagerly, so
  `scene.traversals` becomes `afterApply + E`.
- After the four effects are created, all four counts are 1 and `traversals`
  is still `afterApply + E`: four independent readers cause **no** further
  recomputation. Read `box()` for ordinary assertions as well; a bare
  accessor read is not a fifth effect. Object-reference identity (`===`) is
  not the primary proof and must not replace the traversal/effect counters.

- **"four box readers cost one geometry traversal per drag change"**: after the
  setup above, record the post-construction baseline (`traversals` with the
  box built and the readers settled), then apply one card's cross-boundary
  `setOverrides`. All four reader runs increase by exactly one (from 1 to 2),
  and traversals increase from that baseline by exactly the usable edge count,
  once for the shared recomputation. Repeat the
  same setup with two usable connectors and require the corresponding two
  traversals, still with only one additional run per reader. A test-invented
  box wrapper, a `12 * E` probe baseline, or multiplying the counter by two to
  represent endpoints is forbidden. On one connector, the old four style
  closures do four box walks instead of one; the production-accessor
  regression must show one traversal per drag change using the counter above.
- **"a move inside the same rounded box does not wake box readers"**: using
  the production accessor and the same four effects, apply an override that
  changes the ports without changing any rounded `x`, `y`, `width` or `height`.
  Assert those exact fields remain equal, `traversals` grows once per usable
  connector as the memo checks the changed geometry, and every reader count
  stays at 1. Then apply a cross-boundary override: traversals grow once per
  usable connector again and every reader count becomes 2. This separately
  proves `sameBox` suppression and cross-box publication through reader-effect
  run counts; do not assert zero memo computation or zero geometry work for an
  in-box move.
- **"the drawing origin shares the box memo rather than adding a walk"**: after
  the four style effects settle, evaluate two `box()` reads representing the
  drawing's `origin.x`/`origin.y`. Assert `traversals` does not grow. This
  covers the old two additional origin passes without creating a test-owned
  duplicate memo. Following a cross-box change, the combined four style readers
  plus these two origin reads still incur one traversal per usable connector,
  not six.
- Cover `null` transitions with the same production accessor: apply a snapshot
  with no usable connectors, assert the returned value is `null`, and verify no
  previous rounded rectangle survives. Assert the reader changes appropriate to
  that transition rather than relying on object identity. That `apply` adds no
  traversal (the new snapshot has no edges, so `prune()` walks none) and the
  recomputation adds none either (the memo loops over zero edges); only the
  reader run counts change.

Use fresh scenes and effects per test, no sleeps, and no threshold based on
wall clock. Record baseline traversal/reader counts from setup rather than
resetting counters after a mutation. Add these work-count cases to
`edge-layer.test.ts` as part of Step 1, before `edge-layer.ts` exists. Step 1's
required red run therefore includes the production-accessor import and fails
because that export does not exist; never substitute a closure probe to
establish that red baseline. Step 2 implements the accessor and makes these
cases pass, and Step 4's structural check proves `FlowEdges` actually uses it.
The committed counter cases are the regression proof against future duplicate
walks.

**Verify**: `nsh test src/flow/edge-layer.test.ts` → all geometry and work
count tests pass against the production accessor, including four readers with
same-box and cross-box writes, the two-origin-read check, and the two-edge
count. The file has no sleep, timing assertion, alternate computed box, or
`===` identity gate.

### Step 4: Use one box and resolve each connector's ports once per draw

In `src/components/FlowEdges.tsx`, import `connectorLayerBox` from
`../flow/edge-layer`. In the component body construct it once as
`const box = connectorLayerBox(props.scene);`. Change `left`, `top`, `width`,
and `height` to read that accessor, not to repeat the union.

At the start of `draw`, use:

```ts
const current = box();
if (current === null) return;
const origin = { x: current.x, y: current.y };
```

Read `props.scene.edges()` once into `edges` before that guard if needed, but
do not let the empty-edge case produce a different visible result. Build one
local array in `edges` order whose entries are `{ edge, ports }` for every
connector with resolvable ports. The baseline loop iterates that array and
uses `entry.edge`/`entry.ports`, deleting its own `scene.edgePorts` call.
Track `flowingEdges` exactly as today and retain the selected-edge styling,
`edgeFlows`, `FLOW_REST_ALPHA`, `FLOW_THICKNESS`, and selected-id behavior.

The comet loop iterates the same array, filters only `edgeFlows`, and passes
the saved `entry.ports` to `splitConnector`. It must not call
`props.scene.edgePorts` again. Preserve the existing guard ordering and all
`CanvasRenderingContext2D` state (`save`/`restore`, line caps, widths, alpha).

Keep the current timer, waves, selected-card guards, and canvas JSX structure
unchanged. Remove `edgeBox` when its only caller is gone. Avoid introducing a
new component or restructuring other drawing code.

**Verify**: `nsh test src/flow/edge-layer.test.ts && nsh check src` → all new
unit tests pass and NSH's type check reports no errors. Additionally
`grep -n "edgePorts" src/components/FlowEdges.tsx` prints exactly **one**
line — the shared `{ edge, ports }` array construction; that one call is the
resolution seam for both loops (zero would contradict this step's own
requirement). `! grep -n "roundOut\\|BOX_STEP"
src/components/FlowEdges.tsx` exits 0 with empty output: the view delegates
the box and reuses the saved ports.

### Step 5: Run the full regression gate and document the improvement

Run the new tests plus `src/flow/connection.test.ts`,
`src/flow/card-geometry.test.ts`, `src/flow/scene.test.ts`, and
`src/App.test.tsx`. Fix only failures caused by this geometry refactor; do
not alter unrelated failing behavior or test timing tolerance.

Add a concise `CHANGELOG.md` `### Changed` bullet: the shared connector layer
computes its padded/rounded box once per geometry change instead of separately
for every style binding and drawing origin, and resolves each connector's ports
once per draw. Do not claim a new ms budget or an unmeasured fps improvement.

Run `bun run check`, `bun run test`, and
`./node_modules/.bin/vp fmt --check src/components/FlowEdges.tsx
src/flow/edge-layer.ts src/flow/edge-layer.test.ts CHANGELOG.md
plans/003-edge-geometry-once.md`. Use `bun run check:fix` only for formatting
changes to this plan's in-scope files, then re-run the tests.

**Verify**: the commands above all exit 0, and `git status --short` lists no
source file outside this plan's Scope. `plans/README.md` is the one permitted
status update beyond the source/test/changelog files.

## Test plan

- `src/flow/edge-layer.test.ts` (new): one behavior per case — no boxes yields
  null; unresolved ports are skipped; one and multiple connectors merge;
  padding and 64-point rounding contain every control-point box; negative
  coordinates round outward; small moves compare equal; a boundary crossing
  changes the box; four independent reader effects on the production
  `connectorLayerBox(testScene)` cause one port-resolution traversal per usable
  connector per recomputation, including after each style's initial run;
  two connectors still need only two traversals; the two drawing-origin reads
  add no traversal; an unchanged rounded box wakes none of the four readers
  even though its geometry is recomputed; a crossed boundary wakes each reader
  once; null is restored after usable edges disappear.
- Existing patterns: complete fixtures from `src/flow/scene.test.ts:7-39`,
  effect counting from `src/flow/scene.test.ts:305-325`, and equality-gated
  memo tests from `src/flow/card-geometry.test.ts:51-85`.
- App and host behavior are deliberately unchanged; no pixel test, component
  screenshot, new `.host.test.tsx`, or timing budget belongs in this plan.
- Verification: `nsh test src/flow/edge-layer.test.ts` → all pass; then
  `bun run test` → the full Rust and TSX suite passes.

## Done criteria

- [ ] `grep -n "connectorLayerBox\\|sameBox" src/flow/edge-layer.ts
      src/components/FlowEdges.tsx` finds the new owned memo and equality.
- [ ] `grep -n "setInterval\\|flowWave\\|FLOW_STEP_MS"
      src/components/FlowEdges.tsx` still finds today's timer: plan 004 is
      not partially implemented.
- [ ] `grep -n "edgePorts" src/components/FlowEdges.tsx` prints exactly one
      line (the shared port-resolution seam), and
      `! grep -n "roundOut\\|BOX_STEP" src/components/FlowEdges.tsx` exits 0
      with empty output.
- [ ] `grep -n "const box = connectorLayerBox"
      src/components/FlowEdges.tsx` finds a single component-body memo.
- [ ] `nsh test src/flow/edge-layer.test.ts` exits 0, including the pure
      rounding and exact work-count tests.
- [ ] `bun run check` exits 0 with no warnings.
- [ ] `bun run test` exits 0 with every existing and new test passing.
- [ ] `git diff --name-only 1956ebb..HEAD` contains no out-of-scope source
      files, generated files, or dependencies.
- [ ] `plans/README.md` status row is updated and formatted as instructed.

## STOP conditions

Stop and report instead of improvising if:

- The excerpts in "Current state" differ not merely through formatting, or
  another change has already introduced a shared box memo/different scene API.
- `connectionBounds` does not contain every connector's cubic control point,
  or `scene.edgePorts` can return non-finite coordinates: rounding must not be
  weakened to hide invalid geometry.
- A correct implementation needs to modify `FlowScene`, the Rust document
  core, generated NSH files, or any out-of-scope component.
- The equality memo requires a signal write inside `draw`, an effect that
  mirrors geometry, or a retained global cache.
- The exact production-accessor work-count tests cannot distinguish one memo
  recomputation from the old repeated closures, or require a test-invented box
  memo to pass; do not weaken the counters or count endpoint calls instead of
  geometry traversals to hide duplicate work.
- A visual regression is observed, a baseline connector or selected-edge
  cannot draw, or a card move clips its connector at a rounded edge.
- A verification step fails twice after a focused, in-scope correction; do
  not bypass it by removing tests or widening unrelated tolerance.

## Maintenance notes

- Plan 004 builds on this file and should keep the single memo and shared
  saved-port array while replacing only the timer and draw guards.
- Future port caching must be incremental and invalidated by the scene; do not
  replace the memo with a document-wide cache or a second retained scene.
  An id → incident-connector index is a separate follow-up if E grows further.
- The plan deliberately creates `edge-layer.ts` rather than enlarging
  `connection.ts`: `connection.ts` remains the generic cubic/geometry module,
  while this module owns scene-dependent layer derivation.
- `computed` equality intentionally suppresses reads while the rounded box is
  unchanged, not necessarily every `draw` triggered by selection or theme.
  Those other invalidations remain correct and must not be removed.
- ADR 0005 keeps one shared connector canvas. Splitting into per-edge canvases
  or adding a gesture-only second canvas would require a separate, superseding
  architecture decision and is explicitly deferred.
- No wall-clock speed promise is made: the old [C] 63/77 ms measurement is the
  motivation; the acceptance gate proves eliminated calls, not an fps target.
- The Step 3 traversal baselines encode two engine facts of the pinned NSH
  (`f0b4659`): `FlowScene.apply` -> `prune()` resolves every edge's ports once,
  and `computed()` runs eagerly at construction. After an NSH pin bump or a
  `FlowScene` read-path change (plan 007), re-check those counters; if either
  fact changes, update the recorded baselines, never the production memo.
