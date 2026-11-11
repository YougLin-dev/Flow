# Plan 008: Answer hit tests without repeatedly walking every card and connector

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- CHANGELOG.md src/flow/canvas-controller.test.ts src/flow/canvas-controller.ts src/flow/scene.test.ts src/flow/scene.ts`
>
> This plan runs after `plans/002-batch-scene-writes.md`,
> `plans/006-composer-stays-mounted.md`, and
> `plans/007-reads-wake-only-changes.md`. Changes made by these plans are
> expected. Confirm each dependency's row is DONE in `plans/README.md`; then
> compare only the excerpts this plan edits. A mismatch NOT explained by a
> dependency plan is a STOP condition. Plan 005 also precedes plan 007 for
> scene ordering; honor the index.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-batch-scene-writes.md, plans/006-composer-stays-mounted.md, plans/007-reads-wake-only-changes.md
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `66f3a9e`, 2026-11-11 — plans 006/007 landed.
  `scene.ts` is now 445 code lines, `scene.test.ts` 483, and
  `canvas-controller.test.ts` exactly 500 against the cap, so the new
  hit-test regression tests go in the new `src/flow/scene-hit.test.ts` and
  `src/flow/canvas-controller-hits.test.ts`; the existing test files stay
  unchanged except when an existing case needs adapting.

## Why this matters

Cursor movement should not repeatedly resample every connector or allocate a
screen rectangle for every visible card. On the canvas auditor's synthetic
scenes [C], `edgeAt` took 9.6-10.2 / 26.8-28.9 / 68.6-76 ms for 419 / 1,159 /
2,935 connectors; an exact control-point-box prefilter reduced that to 1.3 /
3.6-3.8 / 9.2-9.7 ms with identical hits. `hasEdge` measured 6.9 / 41 / 111 ms
at 50 / 300 / 800 candidate pairs with 2,935 connectors. This plan removes
unnecessary exact samples, linear membership checks and duplicate hover
searches while keeping all priority, tie-breaking and coordinate semantics.

## Current state

### Scene topology and connector hit testing

`src/flow/scene.ts` is the headless model. `apply` (lines 60-90) replaces
`edgeById` on each viewport read, keeping selected-card connectors;
`applyChangeSet` (lines 93-127) mutates that map for changed/removed edges;
`prune` (lines 446-468) may delete an edge without usable anchors. These are
all topology mutation paths for this plan's pair index. They also have an
`edges` signal, which can be read by reactive components, but an in-map lazy
index must not require that signal's subscribers to run before a synchronous
hit test.

`edgeAt` at lines 357-368 currently performs exact sampling for every edge:

```ts
edgeAt(x: number, y: number): string | null {
  let nearest: { id: string; distance: number } | null = null;
  for (const edge of this.edgeById.values()) {
    const ports = this.edgePorts(edge);
    if (!ports) continue;
    const distance = distanceToConnection(ports.from, ports.to, { x, y });
    if (distance <= EDGE_HIT_DISTANCE && (!nearest || distance < nearest.distance)) {
      nearest = { id: edge.id, distance };
    }
  }
  return nearest?.id ?? null;
}
```

The conservative prefilter is already computed by
`connectionBounds(from, to)` in `src/flow/connection.ts:100-111`:

```ts
export function connectionBounds(from: Point, to: Point): BoxGeometry {
  const { c1, c2 } = connectorControls(from, to);
  const x = Math.min(from.x, c1.x, c2.x, to.x);
  const y = Math.min(from.y, c1.y, c2.y, to.y);
  return {
    x,
    y,
    width: Math.max(from.x, c1.x, c2.x, to.x) - x,
    height: Math.max(from.y, c1.y, c2.y, to.y) - y,
  };
}
```

`EDGE_HIT_DISTANCE = 8` world units (`src/flow/connection.ts:76-79`) and
`distanceToConnection` samples 24 line segments (`connection.ts:183-196`).
A cubic and its sampled polyline lie in their control points' convex hull,
inside `connectionBounds`; a point farther than eight units from that box
cannot hit the curve. Filtering never discards a qualifying exact hit, but
must not replace the exact check. Preserve the baseline's edge-map iteration
order and strictly-smaller `< nearest.distance` tie break.

`hasEdge` at lines 412-417 currently scans every stored edge per candidate
pair. `src/flow/node-session.ts:302-332` invokes it per candidate in
`connectNodes`; group connections therefore do repeated full-map walks.

After plan 007, the baseline's `cardRect` implementation at scene lines
201-219 has per-card effective-rect signals, not the baseline's `nodes()`
read. The audit requirement is that any way to update or remove that rect
still notifies readers immediately, including far endpoints read while
absent. Do not replace that implementation with a cached scene-global rect.
Its `prune()` only publishes `nodes`/`edges` arrays when their ordered record
objects changed; shared snapshot conditions are dependencies, not new work
for this plan.

To confirm this prerequisite, run:

```sh
rg -n 'batch\(|same(Node|Edge)|rectSignals|rectSignal|cardRect|gestureMoved' src/flow/scene.ts src/flow/record-equality.ts src/flow/canvas-controller.ts
```

Expected: batched controller entry points, field-equality helpers in the
scene, per-card effective/override rect signals and no baseline
`this.nodes();` statement immediately before `overrideSignal(id)()` in
`cardRect`. If the old `cardRect` still reads `nodes()`, plan 007 has not
landed: STOP. `rg -n 'gestureMoved' src/flow/canvas-controller.ts` must also
match its plan-006 public reader.

Line ranges in the excerpts below date from `1956ebb`; plans 002/005/006/007
moved them. The quoted code still matches at `66f3a9e`: `cardRect` now
delegates to `rectSignal(id)` and `prune` gates its list writes.

### Card/plus/handle priority and repeated hover work

The current semantics are normative: `docs/standards.md:311-317` requires
hit tests from the scene, `nodeAt` topmost by z with ties to the last, a
card under the pointer hiding a lower card's plus, and `edgeAt` within the
world hit distance. `docs/standards.md:356-360` says port/edge hit distances
are world distances while selection handles are screen points; do not mix
them.

`src/flow/canvas-controller.ts:452-503` is `hover`, the current pointer
router. Its baseline sequence is:

1. `framePlusAt` (lines 162-174) reads `selectionBounds` in world coordinates;
2. `scene.portZoneAt(world.x, world.y)` (scene lines 315-334) finds a plus,
   then calls `nodeAt` once more to enforce occlusion;
3. `frameContains` (controller lines 148-154) reads selection bounds again;
4. `handleAtPoint` (lines 182-205) calls `nodeAt`, or outside cards walks
   every card and creates a screen rectangle per candidate;
5. `nodeAt` at line 499 is called yet again if no earlier branch returned.

`portZoneAt` may return a lower-z side if a higher card is not above it; do
not turn `under !== hit.nodeId` into a blanket null. Its special case is:

```ts
if (under !== null && under !== hit.nodeId) {
  if (this.cardDepth(under) >= hit.z) return null;
}
```

A point at a port border can belong to both portZone and the card itself.
Do not exclude inside-card points from `nodeAt` because of port semantics.

`src/flow/selection.ts:30-51` has the existing inclusive handle test:

```ts
export function handleAt(rect: ScreenRect, x: number, y: number, radius = 7): ResizeHandle | null {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (x < left - radius || x > right + radius || y < top - radius || y > bottom + radius) {
    return null;
  }
  const nearLeft = Math.abs(x - left) <= radius;
  const nearRight = Math.abs(x - right) <= radius;
  const nearTop = Math.abs(y - top) <= radius;
  const nearBottom = Math.abs(y - bottom) <= radius;
  if (nearTop && nearLeft) return "nw";
  if (nearTop && nearRight) return "ne";
  if (nearBottom && nearRight) return "se";
  if (nearBottom && nearLeft) return "sw";
  if (nearTop) return "n";
  if (nearBottom) return "s";
  if (nearLeft) return "w";
  if (nearRight) return "e";
  return null;
}
```

Use that exact side priority, inclusive border and reach. The camera's
`toWorld` divides by a positive finite `scale` and `toScreen` multiplies
(`src/flow/camera.ts:69-79`). A world-space fallback must subtract camera
translation only once per pointer event and use `radius / camera.scale`.
Never divide x/y by a camera scale in `handleAtPoint` after `toWorld` has
already done so.

`idsWithin` at controller lines 532-549 currently prepares
`const ids = gesture.additive ? [...scene.selection()] : []`, then calls
`ids.includes(node.id)` for each covered node. Preserve scene order in its
returned array: first selected ids in selection order, then newly intersected
scene ids. A Set is only for membership, not a substituted returned order.

### Rules and conventions

- `docs/standards.md:375-384`: per-frame work is proportional to visible
  cards; do not traverse the whole document; allocations in pointer moves
  beyond the override map should be avoided; budgets are manual targets and
  MUST NOT be CI assertions.
- `docs/standards.md:319-324`: `CanvasController` is the sole pointer router.
  Keep geometric hit tests in `flow/`, not a native component/view or pixels.
- `docs/standards.md:220-221`: "Use one `batch` only when several writes form
  one invariant; `batch` is not a performance ritual." Preserve plan 002's
  pointer-event batching; these reads and cache invalidations add no
  independent reactive update cycle.
- `docs/standards.md:328-332`: drag geometry writes once on release; hover
  must not change selection.
- `docs/standards.md:135-145`, 154-160: named exports, kebab-case modules,
  500-code-line lint cap, comments explain why, object shapes use interfaces.
- `docs/standards.md:443-469`: unit tests sit beside the subject, one behavior
  per case; reproducible fixes have failing-first regression tests. Do not
  use a component-level harness—the repository has none for these models.
- No `any`, unsafe cast or non-null assertion. Do not move geometry to Rust or
  the database, add a canvas/scene library, or add an RTree/dependency just
  for these scene-local lookups.

## Commands you will need

| Purpose           | Command                                                                                                                                                                                                                        | Expected on success                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Dependency state  | fenced command below                                                                                                                                                                                                           | batching, movement and record identity present |
| Baseline/drift    | fenced command below                                                                                                                                                                                                           | only known dependency edits                    |
| Scene unit tests  | `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-hit.test.ts`                                                                                                                                                       | exit 0, all tests pass                         |
| Geometry tests    | `nsh test src/flow/connection.test.ts && nsh test src/flow/selection.test.ts && nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/canvas-controller-hits.test.ts && nsh test src/flow/frame-connection.test.ts` | exit 0, all tests pass                         |
| Optional trace    | `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace`                                                                                                                                                | behavior passes; trace is manual evidence      |
| Full static gate  | `bun run check`                                                                                                                                                                                                                | exit 0, no warnings                            |
| Full test suite   | `bun run test`                                                                                                                                                                                                                 | exit 0, all tests pass                         |
| Real Windows host | `bun run test:host`                                                                                                                                                                                                            | exit 0, all platform tests pass                |
| Markdown format   | `vp fmt --check plans/008-hit-tests-scale.md` (use `./node_modules/.bin/vp`)                                                                                                                                                   | "All matched files use the correct format."    |

```sh
rg -n 'batch\(|gestureMoved|same(Node|Edge)' src/flow/canvas-controller.ts src/flow/scene.ts src/flow/record-equality.ts
# Confirm the scene uses per-card effective rect signals and no nodes read:
rg -n -A 3 'cardRect\(id' src/flow/scene.ts
# Must show rectSignal/overrideSignal only, no `this.nodes();`.
git diff --stat 1956ebb..HEAD -- CHANGELOG.md src/flow/canvas-controller.test.ts src/flow/canvas-controller.ts src/flow/scene.test.ts src/flow/scene.ts
```

## Scope

**In scope** (the only files you should modify):

- `src/flow/scene.ts`
- `src/flow/scene-hit.test.ts` (create; new scene hit and pair-index tests)
- `src/flow/scene.test.ts` (only if an existing test needs adapting; do not
  append new tests — it is 483 code lines against the 500 cap)
- `src/flow/canvas-controller.ts`
- `src/flow/canvas-controller-hits.test.ts` (create; new hover and marquee
  tests)
- `src/flow/canvas-controller.test.ts` (only if an existing test needs
  adapting; it is exactly 500 code lines)
- Optional, only if the 500-code-line gate requires the exact split in Step 4:
  `src/flow/hit-geometry.ts`, `src/flow/hit-geometry.test.ts`, and the
  existing `src/flow/selection.ts` re-export described there. Do not create
  these for a hypothetical future split, and add them to the drift check if used.
- `CHANGELOG.md`
- `plans/README.md` (this row's status only, as a final repository edit)
- `plans/008-hit-tests-scale.md` (only if the executor is expected to update
  its execution status)

**Out of scope** (do NOT touch, even though they look related):

- `src/flow/connection.ts`: reuse `connectionBounds` and `EDGE_HIT_DISTANCE`;
  exact sampling math already exists and must stay unchanged. If reuse needs
  a general primitive, `src/flow/selection.ts:17-24` `containsPoint` already
  supplies one.
- `src/flow/selection.ts`: normally unchanged—its inclusive default-seven-point
  `handleAt` is the oracle. Only Step 4's optional `hit-geometry` split may
  move that helper and leave a compatibility re-export; otherwise do not touch.
- `src/flow/edge-gestures.ts`, `src/flow/connection-gesture.ts`,
  `src/flow/node-session.ts`: their callers use `edgeAt`/`hasEdge`; no
  connection API or native command changes here.
- `src/flow/viewport-controller.ts`, `src/native/`: no RTree expansion, SQL,
  document read scheduling, or full-document topology index.
- `src/pages/FlowPage.tsx`, `src/components/FlowCanvas.tsx`, all other
  components/plans: no new pointer routing, render tree or view IDs.
- `docs/standards.md`: existing hit-test and geometry rules already cover the
  implementation; no new architecture contract or benchmark target.

## Git workflow

- Branch from `main`: `git switch -c advisor/008-hit-tests-scale`. Ensure the
  dependency revisions are already merged/applied by the maintainer; do not
  silently rebase this optimization onto the original scene/controller.
- Commit per logical step; Conventional Commits use lower-case imperative
  subjects with explanatory bodies. Example:
  `perf: keep canvas gestures to one update per moved card` (1956ebb).
- Suggested commit sequence: connector prefilter tests/implementation, lazy
  pair index, controller membership and hover refactor, final gate/index.
  Each commit must leave the gate green and behavior unchanged.
- NEVER add AI attribution: no `Co-Authored-By:` naming an AI, no
  "Generated with ..." line. Do not push and do not open a PR.

## Steps

### Step 1: Characterize topology edge cases and prove the connector prefilter

Create `src/flow/scene-hit.test.ts` and copy the existing scene helpers
(`node`, `edge`, `snapshot` at `src/flow/scene.test.ts:1-41`); the existing
world-hit test is now at `scene.test.ts:491`. Add a narrow regression before
changing code:
`"does not select a connector merely inside its control-point box"`. Use a
curved endpoint pair, e.g. from a card at `(0,0)` to a card at `(0,180)`;
pick a point inside `connectionBounds` but more than `EDGE_HIT_DISTANCE` from
`distanceToConnection` (calculate with the existing pure function while
writing the test). Expect null, not just the bounds predicate. Keep a
near-curve hit assertion in the same test's fixture only if one behavior stays
clear; the existing suite already checks positive hits.

Add separate tests to the new file for the box corners at the edge-hit
expansion, a curve whose far endpoint is carried by `fromPoint`/`toPoint`,
and nearest-distance tie behavior. Follow the offscreen anchor test at
`src/flow/scene.test.ts:69`; it proves the prefilter uses the actual ports,
not just instantiated cards. Cases with no ports continue to skip.

Update `src/flow/scene.ts` imports to bring in `connectionBounds`, then in
`edgeAt` skip before `distanceToConnection` unless the point lies in
`connectionBounds(ports.from, ports.to)` expanded by `EDGE_HIT_DISTANCE`.
Compare in world units on both sides inclusively; use
`selection.containsPoint(box, x, y, EDGE_HIT_DISTANCE)` or a named helper in
scene if importing controller geometry into scene would make ownership
confusing. Do not create a screen-space rectangle, alter sampling steps,
round bounds or make equality exclusive.

The prefilter still obtains `edgePorts` for every edge in map order. This is
the plan's bounded improvement, not a global spatial index. It changes only
how many expensive 24-segment evaluations run.

**Verify**: `nsh test src/flow/scene-hit.test.ts --filter "control-point box"` → exit 0 with the new far-from-curve negative case; `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-hit.test.ts && nsh test src/flow/connection.test.ts` → all existing hit and geometry cases pass.

### Step 2: Pair-index the current scene, including pins and pruning

Before this topology step, run
`rg -n 'same(Node|Edge)' src/flow/record-equality.ts src/flow/scene.ts` and
`rg -n -A 3 'cardRect\(id' src/flow/scene.ts`. Expected: field-identity
helpers and the per-card `rectSignal` path, with no `this.nodes()` read inside
`cardRect`; otherwise plan 007 has not landed and this plan must not modify it.
`rg -n 'gestureMoved|batch\(' src/flow/canvas-controller.ts` must show plan
006's movement signal and plan 002's pointer-event batches.

Add `private edgePairs: Set<string> | null = null` and a private lazy getter
to `FlowScene`. When null, build a Set once from `edgeById.values()`, using a
private `pairKey(fromId, toId)` that escapes the separator unambiguously. Do
not use `id + "\\u0000" + id` without excluding an embedded separator: native
node IDs are opaque strings, not a validated restricted alphabet.

Use a collision-free two-string encoding no larger than the existing data,
for example `JSON.stringify([fromId, toId])` (a well-defined string array) or
`${fromId.length}:${fromId}${toId}`. The former is clearer and adequate for
pointer/connection queries. Keep the key policy local to scene, not exported
to other modules. Direction matters: `(a,b)` differs from `(b,a)`.

Use only ID/fromId/toId for the topology comparison. Plan 007 supplies
`sameEdge` from `record-equality.ts`, which covers current ports/anchors too;
do not use it to invalidate a pair index on anchor-only edits. It is enough
to compare the keys with a tiny local helper and Set equality—no need to add
rect equality here, since `cardRect` remains live per-card signal state.
Capture `before = topologyPairs(this.edgeById)`
at the start of `apply`; after its clear/refill and pinned-edge merge, capture
`after = topologyPairs(this.edgeById)`. If a lazy index already exists and
`!samePairs(before, after)`, assign `this.edgePairs = null`; otherwise retain
its cache. This index, if retained into `prune`, must be invalidated whenever
prune deletes an edge, so a later query cannot use the raw pre-prune snapshot.
An initially absent lazy pair Set still builds lazily from the post-prune
edge map. The temporary before/after Sets contain ONLY `(edgeId / fromId /
toId)` identity, not anchor fields or record JSON. They settle retention
decisions without building a span index.

`topologyPairs` is only a comparison set (no externally visible cache)—do
not confuse `edgeId` with a pair key; keep separate raw strings for IDs in a
local tuple-string helper if needed. Comparisons of actual node pairs must
use the pairKey encoding below. An anchor-only change leaves the pair Set
untouched. In `applyChangeSet` a changed from/to always clears any existing
lazy index; an `edgesRemoved` `delete(id)` returning true clears it as well.
In `prune`, every `edgeById.delete(id)` must clear it if actually present.
There is no public edge snapshot watcher to trigger these do writes: apply
them synchronously inside the scene mutation's plan-002 outer batch.

`hasEdge(fromId, toId)` then returns
`this.edgePairIndex().has(pairKey(fromId, toId))`. Do not maintain the Set
reactively through `edges()` and do not read cards or scene-global rectangles
while retrieving it. A synchronous call immediately after `apply` must work.

Add these clearly separated cases to `scene-hit.test.ts` (keep the existing
`knows whether a pair is already connected` test at `scene.test.ts:576`
unchanged as a safety net):

- lazy build after initial snapshot: existing forward hit; reverse miss;
- changed membership after one index was already built: add a pair through
  `applyChangeSet.edgesChanged`, query a hit; remove that edge, query a miss;
- subsequent snapshot removal: query a miss; pinned endpoint edge kept across
  a read without it remains a hit (use the pinning setup from `caps a
  snapshot but keeps the selected cards and their connector` at
  `scene.test.ts:55`);
- prune drops an edge missing both real/embodied ports, and the index misses
  it without requiring an intervening reactive signal read;
- unusual node IDs bearing `\\u0000`, commas, colons and quotes cannot collide.

Do not test private fields or a private getter by casting. Assert the public
`hasEdge` result at each state transition.

**Verify**: `nsh test src/flow/scene-hit.test.ts --filter "pair" && nsh test src/flow/scene.test.ts` → exit 0, including stale-cache and key-collision cases; `nsh test src/flow/node-session.native.test.ts` → existing and later group-connect behavior passes without native changes.

### Step 3: Replace marquee's O(N·S) membership with an O(1) set without reordering selection

In `src/flow/canvas-controller.ts` `idsWithin`, leave world box construction
and `intersects` unchanged. Build an `included = new Set(gesture.additive ? scene.selection() : [])`
once, as well as the `ids` array carrying those existing selected ids. For
each scene node in map order, append only when it intersects and `included`
does not have it, then add it to the set after pushing. Preserve additive
selection order and non-additive results exactly.

This is one `Set` per marquee move, not a new signal or a per-node `has`
allocation. Keep `setPreview`'s existing early out at lines 552-556 and plan
002's outer pointer-event batch; the membership fix must not cause redundant
new preview writes.

Add this controller test to `canvas-controller-hits.test.ts` (copy the
`setup` helper from `canvas-controller.test.ts:46-93`): an additive marquee
after `scene.select(["b", "a"])` and a drag intersecting `a` before `b`, plus
a fresh (non-shift) marquee over both. Check `scene.selectedIds()` order and
each id occurring once. The additive fixtures are `previews the cards a
marquee covers before it is released` at `canvas-controller.test.ts:257` and
`a shift marquee previews the selection it adds to` at line 282.

**Verify**: `nsh test src/flow/canvas-controller-hits.test.ts --filter "marquee" && nsh test src/flow/canvas-controller.test.ts` → exit 0, including additive ordering, no duplicates and cancellation cases.

### Step 4: Reuse one hit and one selection-frame read in each hover decision

Refactor without adding signals. `hover` should issue one
`const under = scene.nodeAt(world.x, world.y)` near the top after the world
conversion, when a select-tool path requires it, and pass that cached result
through the optional parameter(s) below. The hand tool can short-circuit at
the end as today. The multi-frame condition should be evaluated once. Compute
world selection bounds once when frame zones/containment need them, not once
per call; retain title band padding and frame point inclusivity.

In `FlowScene.portZoneAt(x, y, under?: string | null)`, if the optional third
argument is omitted, preserve its existing internal `nodeAt` calculation for
`EdgeGestures.down` (edge-gestures.ts:37-43) and any other caller. In
`CanvasController.hover`, pass the one cached `under`, which can be a card id,
null, or the id of the same card whose side wins. Do not interpret optional
`undefined` as if the caller proved that no card is under the pointer. Return
the same `point` object computed by `portZone` and preserve highest-z/last-tie
selection for the side candidate.

In `CanvasController.handleAtPoint(x, y, under = scene.nodeAt(...))`, avoid a
second node scan. Replace the outer-card fallback's per-card `screenRect()`
with:

```ts
const radius = 7 / camera.scale; // handleAt's default screen reach
for (const node of scene.nodes()) {
  const rect = scene.cardRect(node.id);
  if (!rect) continue;
  const side = handleAt(rect, world.x, world.y, radius);
  const depth = scene.cardDepth(node.id);
  if (side !== null && (hit === null || depth >= hit.z)) {
    hit = { id: node.id, side, z: depth };
  }
}
```

The under-card path may retain `screenRect(under)`, because there is only one;
do not rebuild screen geometry for every outside candidate. Keep topmost depth
and `>=` tie break. Do not factor card-local coordinates into this radius:
world/card coordinates have the same scale here, but the defaults are seven
SCREEN points.

If controller or scene grows to 500 code lint lines, move the pure handle/
screen conversion geometry into a new `src/flow/hit-geometry.ts` and add
`src/flow/hit-geometry.test.ts`. These are the only new files allowed by this
plan. Move `selection.ts`'s `handleAt` there and re-export it from selection
for its existing callers/tests, rather than maintaining two priority rules;
put only handle-at/screen conversion in this named module. Then update the
files. In the usual case the small code delta stays under the cap and no new
file is needed; no lint suppression is permitted. `portZoneAt` stays on the
scene.

Tests for coordinates and routing go in `canvas-controller-hits.test.ts`
(except the scene-level `portZoneAt` case, which goes in `scene-hit.test.ts`):

1. Copy `"shows a resize cursor over any card's handle"` at
   `canvas-controller.test.ts:436` to cover an outside handle (the existing
   down case is at line 418); assert `controller.hover` gives a resize cursor
   beside a card, not inside its body.
2. Repeat that outside handle at `camera.scale = 0.5` and `2`. Choose a world distance derived from `7 / scale` so this proves scaling, then assert a farther point is default. Use e.g. an a-card world rect `(100,100,200,84)`, not a bare coordinate already inside the plus zone; use the north border to avoid both side pluses and a multi-selection frame.
3. Keep the occlusion case at `canvas-controller.test.ts:471` and the
   plus-over-handle case at line 484 as direct regression tests. Add an
   overlapping plus/card test for `portZoneAt` with explicit `under` to
   `scene-hit.test.ts` if the existing scene tests (now around
   `scene.test.ts:491`-`575`) do not pin the exact optional-param path.

Existing `reads the hover from where a gesture ends` at
`canvas-controller.test.ts:516` must
pass unchanged. Ensure an `up`-driven hover, `leave`, or pan does not introduce
a new selection write or alter `gestureMoved` from plan 006.

**Verify**: `nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/canvas-controller-hits.test.ts && nsh test src/flow/scene.test.ts && nsh test src/flow/scene-hit.test.ts && nsh test src/flow/frame-connection.test.ts` → exit 0, including outside handles at zoom 0.5/2, occlusion, plus priority and gesture-result anchors.

### Step 5: Document, run host checks and finish the index narrowly

Add one concise `CHANGELOG.md` `### Changed` bullet: hover and press hit
testing skips connectors outside their padded control box, uses the current
pair index for connection checks, and avoids repeated card passes/screen
allocations. Say behavior is unchanged; do not promise frame timing on a
particular machine.

Run focused tests first and the whole gate last. The scene's lookup changes
are pure/headless; the Windows host suite is a local manual gate for actual
pointer/cursor integration, not a new timing or pixel test. Report its result
or reason not run separately from automated evidence.

If you add an optional manual trace comparison, record build configuration
and fixture before and after and direction only (fewer rather than a claimed
threshold). Do not turn the audit [C] timings into CI expectations.

Update only plan 008's index row if you own the index. Do not update other
execution-status fields. Format the two Markdown files; do not modify
advisor-owned source docs merely to recite timings.

**Verify**: `bun run check && bun run test && bun run test:host` → all exit 0; optional `./node_modules/.bin/vp fmt --check plans/008-hit-tests-scale.md plans/README.md` → "All matched files use the correct format." when the index exists.

## Test plan

- `src/flow/scene-hit.test.ts` (create; copy the `node`/`edge`/`snapshot`
  helpers from `scene.test.ts:1-41`): model on `"finds ports, cards and
  connectors in world coordinates"` at `scene.test.ts:491`, `"keeps a
  connector whose far card left the scene"` at `scene.test.ts:69`, and
  `"knows whether a pair is already connected"` at `scene.test.ts:576`.
  New independent cases:
  - control-box-only point has distance > 8 and no hit;
  - exact near-curve hits survive the bounds filter, including boundary/corners;
  - far endpoint anchors and nearest match/tie order retain their meaning;
  - lazy pair Set after apply/add/remove/prune/pinned-connector paths is always current;
  - key encoding is directional and collision-proof for odd node-ID strings.
- `src/flow/canvas-controller-hits.test.ts` (create; copy `setup` from
  `canvas-controller.test.ts:46-93`): assert outside-card resize reach at
  scale 0.5 and 2, plus/handle/card occlusion, cached under behavior and
  marquee ordering/uniqueness.
- Existing controller fields `gesturing` and `gestureMoved` stay at their
  previous semantics; app tests still show the correct click/drag behavior.
- Full command: `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-hit.test.ts && nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/canvas-controller-hits.test.ts && nsh test src/flow/connection.test.ts && nsh test src/flow/selection.test.ts && nsh test src/flow/frame-connection.test.ts` → all pass.
- `bun run test:host` is local Windows evidence for pointer/cursor plumbing.
  Optional `--trace` numbers are manually inspected without assertions for
  ms, fps, allocation count or mount thresholds.
- No dedicated connection-gesture test file exists at baseline; its behaviors
  are covered through controller/frame-connection tests. Do not invent a new
  test type or a component harness.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `rg -n 'connectionBounds|EDGE_HIT_DISTANCE|edgePairs|pairKey' src/flow/scene.ts` shows conservative prefilter and lazy directional-pair index; exact `distanceToConnection` still gates `edgeAt` acceptance.
- [ ] `rg -n 'ids\\.includes|this\\.screenRect\\(node\\.id\\)' src/flow/canvas-controller.ts` returns no matches in `idsWithin` or the outside-card handle loop; replaced by Set/root world radius and rect reads.
- [ ] `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-hit.test.ts && nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/canvas-controller-hits.test.ts` exit 0, including prefilter negative, topology invalidation, optional `under`, outside-handle zoom and additive-marquee regressions.
- [ ] `src/flow/scene.test.ts` and `src/flow/canvas-controller.test.ts` are unchanged unless an existing test required adaptation; all new tests are in the two new files.
- [ ] Every `edgeById.clear`, set, delete or prune deletion in `scene.ts` invalidates (or accurately retains) the index; all transition tests pass without reading `edges()` to trigger any watcher.
- [ ] `bun run check` and `bun run test` both exit 0 without warnings.
- [ ] `bun run test:host` exits 0 on Windows, or its unavailability is explicitly reported rather than represented as passed.
- [ ] `git diff --check` exits 0; `git status --short` has no source/doc files outside in scope.
- [ ] `CHANGELOG.md` records the performance change as behavior-preserving; no numeric timing target has been added to app tests or docs/standards.
- [ ] `plans/README.md` row updated and index formatted if the executor owns it.

## STOP conditions

Stop and report back (do not improvise) if:

- The baseline `cardRect` still reads `this.nodes()` before its override signal,
  or plan-006 `gestureMoved` / plan-002 pointer batches are missing. Do not
  stack this plan on an incompatible scene/data model.
- An in-scope mismatch is not explained by a DONE dependency plan, or a
  dependency changes a hit-test signature or topology mutation path not
  accounted for above.
- Native/generator IDs can be actual `undefined` in a required lookup despite
  their TypeScript types; do not erase the proof with `as`, `!`, or `any`.
- The control-point prefilter rejects an existing exact hit (especially a
  far endpoint or inclusive boundary), or changing node geometry makes the
  pair Set differ from the scene's edges. Reproduce and preserve correctness
  rather than adopting a guessed radius/tolerance.
- Any edge membership mutation occurs outside `apply`, `applyChangeSet` or
  `prune`, or the captured before/after topology does not survive
  pinning/pruning correctly: report the missed invalidation rather than
  caching raw input membership.
- An optional `under` parameter accidentally defaults to null (rather than
  recomputing), or the card-occluded-plus behavior changes; failure of
  side-zone/topmost-existing tests after two focused repairs is a stop.
- The outside-handle world radius produces a cursor beyond seven screen
  points at zoom 0.5 or 2, or screen/port semantics are being mixed. Do not
  enlarge the reach or fix the test to match the bug.
- A new topology index would require Rust SQL/RTree, whole-document traversal,
  a third-party library or a render-loop/global reactive signal. This plan
  intentionally indexes only loaded scene state.
- A necessary implementation would exceed 500 code lines in scene or
  controller **after the explicitly allowed `hit-geometry.ts` split and its
  re-export in `selection.ts`**; report the remaining structural issue instead
  of suppressing lint. Do not introduce a different new module or suppress
  lint to avoid that bounded fallback.
- A step's verification fails twice after a reasonable in-scope fix attempt.

## Maintenance notes

- Every future edge-map additive/removal mutation must invalidate the pair Set
  only when endpoints membership changes. Snapshot rect changes alone do not.
  Prefer centrally wrapping map mutation if more mutation paths are added.
- This is a lazy per-scene exact pair Set, not spatial indexing. A future
  RTree or visible-card spatial grid would require measured evidence and its
  own design; do not expand `edgeAt` into a full-document lookup.
- `edgeAt` still calculates current edge ports once per edge per press to
  honor selected/transient/far anchors. A later memoized edge port cache must
  keep the same dynamic port dependency as plan 007; do not derive it once
  and freeze visible geometry.
- The cached `under` is valid only for one hover call/pointer position. Do not
  persist it across pointer events or signals. Keep card/plus/edge priority in
  `FlowScene`/controller, not an asynchronous observer.
- `handleAt`'s seven-point constant remains screen points. Review every zoom
  case after camera changes; use inclusive bounds so diagonal directions
  remain `nw/ne/se/sw` before the four axes, matching `selection.ts`.
- Any additive selection change must preserve selection order. Set membership
  accelerates lookup, not output ordering.
- Dependency deviations: plan 007's precise private rect-signal names are
  intentionally not hardcoded; the drift check is on observable per-card
  fields and removal of the baseline `nodes()` read, not a guessed private
  member. No other implementation decision was substituted from the advisor's
  performance goal.
- No source benchmark probes were run while authoring this plan; only the
  advisor's prior [C] measurements and direct static code/pinned-NSH reads
  support it. A manual measurement using plan 001's optimized-host method
  may be supplied by the maintainer after implementation.
