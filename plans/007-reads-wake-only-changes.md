# Plan 007: Make viewport reads and change sets wake only what changed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/flow/scene.ts src/flow/scene.test.ts src/flow/record-equality.ts src/flow/record-equality.test.ts src/flow/preview-loader.ts src/flow/preview-loader.test.ts src/flow/previews.ts CHANGELOG.md plans/README.md`
> Dependency plans `plans/002-batch-scene-writes.md` and
> `plans/005-card-bindings.md` edit `src/flow/scene.ts` (and its test) first.
> Changes made by these plans are expected. Confirm each dependency's row is
> DONE in `plans/README.md` (advisor-maintained; the executor updates only
> this plan's own row at the end); then compare only the excerpts this plan
> edits. A mismatch NOT explained by a dependency plan is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-batch-scene-writes.md` and `plans/005-card-bindings.md` (same-file ordering in `src/flow/scene.ts`; plan 005 adds `FlowScene.isSelected`)
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `02c2c36`, 2026-11-11 — plan 006 landed (only
  `CHANGELOG.md` among this plan's files). `scene.ts` is now 547 total lines
  (≈401 code lines) and `scene.test.ts` ≈483 code lines against the
  500-code-line cap, so the new scene regression tests go in the new
  `src/flow/scene-reads.test.ts`, not `scene.test.ts`.

## What this plan does NOT change

This plan does NOT touch `src/flow/viewport-controller.ts`. The preview
target-equality skip lives in `src/flow/preview-loader.ts` (and
`loadPreviews` in `src/flow/previews.ts` is unchanged per its existing
empty-targets early-out). Viewport scheduling, throttling, the
`snapInFlight` re-entry guard, the `camera?.dispose()` lifecycle and the
`03x → 010 → 011 → 016` chain all belong to other plans — plans 010, 011
and 016 MUST NOT read this plan as having changed anything on the
viewport controller. If an edit feels needed on `viewport-controller.ts`,
STOP and report; the design is wrong, not the scope.

## Why this matters

Every viewport read (throttled to one per 80 ms while panning or zooming) and
every command's change set currently re-runs every card's geometry bindings,
`SelectionFrame`/`SelectionPluses`, the composer position and the whole
connector layer — even when nothing moved. The cause is structural:
`prune()` always sets new `nodes`/`edges` array objects and `cardRect()`
reads `nodes()` to subscribe to them, so a field-identical read is
indistinguishable from a move. Advisor probes at `1956ebb` measured one
identical viewport read with 11 cards selected at ≈8 ms of JS and two full
connector re-records for no visible change; `applyPreviews` similarly wakes
every image card, and the per-id override signal map grows by one entry for
every id ever read (6,000 signals after 300 disjoint cards read 20 times)
and is never pruned. After this plan an unchanged read wakes nothing, a
change set moving card A wakes only A's readers, and the per-id signal map
stays bounded by the live scene.

## Current state

### State after the dependency plans (verify before editing)

- After **plan 002**, the bodies of `apply`, `applyChangeSet`, `setOverrides`,
  `clearOverrides` and `select` in `src/flow/scene.ts` are wrapped in
  `batch(() => { ... })` and `batch` is imported from `"nsh"`.
  Quick check: `grep -n "batch(" src/flow/scene.ts` must show the import and
  at least those five uses. **If this shows no matches, plan 002 has not
  landed: STOP.** All excerpts below are shown at `1956ebb`, i.e. _without_
  the batch wrappers — the method bodies inside the arrows are unchanged.
- After **plan 005**, `FlowScene` exposes two related-but-distinct readers:
  - `isSelected(id: string)` — backed by `selectionRanks()`; tracks the
    whole selection signal (any selection change re-runs its readers). Used
    by the controller's logic and by `FlowCanvas.tsx`'s `plusSuppressed`
    prop (which also observes `multiFrame()`, so the ranks-map form is
    correct there).
  - `isSelectedKeyed(id: string)` — backed by `selectedFlags`
    (`KeyedFlags`); wakes only when `id`'s own membership flips. Used by
    `FlowCanvas.tsx`'s `selected` prop to scope each card's wake to its
    own flag flip.
    Quick check: `grep -nE "isSelected|isSelectedKeyed" src/flow/scene.ts`
    shows both methods. This plan does not touch either reader; treat them
    as read-only context.
- Plan 008 (later, not a dependency) will change `edgeAt`, `hasEdge`,
  `nodeAt`/`portZoneAt` hit testing; do not pre-empt it.
- Line ranges in the excerpts below date from `1956ebb`; plans 002/005 moved
  them (for example `prune` is now 485-510 and `cardRect` 224-231 at
  `02c2c36`). The quoted code still matches apart from the plan-002 `batch`
  wrappers.

### The code this plan edits (at `1956ebb`)

`src/flow/scene.ts` — the scene model. `nodes`, `edges`, `previews` are
public signals; `byId`/`edgeById`/`applied` are plain maps (34-57).

`apply` keeps the existing viewport card budget and selected-card pinning
(60-90); `applyChangeSet` merges a command result (93-127). Its edge merge is
load-bearing for this plan's `sameEdge`:

```ts
// scene.ts:110-124 — a command's edge carries no far anchors; keep the ones
// the viewport read resolved, so a reconnect does not blank the connector.
for (const edge of changes.edgesChanged) {
  const previous = this.edgeById.get(edge.id);
  this.edgeById.set(
    edge.id,
    previous === undefined
      ? edge
      : {
          ...edge,
          fromPoint: edge.fromPoint ?? previous.fromPoint ?? null,
          toPoint: edge.toPoint ?? previous.toPoint ?? null,
        },
  );
}
for (const id of changes.edgesRemoved) this.edgeById.delete(id);
this.prune();
```

`prune` always publishes fresh arrays (446-468):

```ts
// scene.ts:453-467 (tail of prune)
const selected = this.selectedEdge();
if (selected !== null && !this.edgeById.has(selected)) this.selectedEdge.set(null);
...
this.nodes.set([...this.byId.values()]);
this.edges.set([...this.edgeById.values()]);
```

`cardRect` reads `nodes()` only to subscribe to replacements (201-208), and
the override signals are created lazily for any id (212-219):

```ts
cardRect(id: string): BoxGeometry | null {
  // Read the nodes signal so a binding that positions a card or connector
  // recomputes when a change set moves it, not only during an override.
  this.nodes();
  const override = this.overrideSignal(id)();
  if (override) return override;
  return this.applied.get(id) ?? null;
}

private overrideSignal(id: string): Signal<BoxGeometry | undefined> {
  let override = this.overrideSignals.get(id);
  if (!override) {
    override = signal<BoxGeometry | undefined>(this.overrideRects.get(id));
    this.overrideSignals.set(id, override);
  }
  return override;
}
```

`setApplied` already keeps an unmoved card's rect object identical (223-227);
`selectionBounds` (269-287) starts with a `this.nodes()` read; `cardZ`,
`frameZ`, `previewZ`, `framePlusZ` (241-263) also read `nodes()` because
`baseZ` is recomputed in `prune` — those four KEEP their `nodes()` read.

`applyPreviews` always sets a new Map (130-136):

```ts
applyPreviews(previews: readonly PreviewView[]): void {
  const next = new Map<string, PreviewView>();
  for (const preview of previews) {
    if (this.byId.has(preview.nodeId)) next.set(preview.nodeId, preview);
  }
  this.previews.set(next);
}
```

### Every `cardRect(` caller (verified — the bounded-map safety argument)

A per-id signal must exist for any id a reader can subscribe to, and entries
may only be deleted when no live reader can be stranded. All callers outside
`scene.ts`:

| Caller                                                                      | Ids it reads                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/FlowCanvas.tsx:285` `rect={() => props.scene.cardRect(id)}` | row id from `<Each of={props.scene.nodes()}>` → always a card in `byId`                                                                                                                                                                                                                                                                           |
| `src/pages/FlowPage.tsx:173` `composerPosition`                             | `currentSession()?.composerId()` — the composer opens only when the selection is exactly one card (`FlowPage.tsx:162-164` and the selection effect 377-395) and `openComposer` returns early if the id changed; the id is a selected, hence pinned, card. On deselect/delete the page closes the composer before or while the id leaves the scene |
| `src/pages/FlowPage.tsx:189` `inlinePosition`                               | `currentSession()?.inlineId()` — **see the STOP condition for step 5**                                                                                                                                                                                                                                                                            |
| `src/flow/canvas-controller.ts:118` `screenRect(id)`                        | ids from `handleAtPoint` (`nodeAt`, `scene.nodes()`) and `startDrag` (selection)                                                                                                                                                                                                                                                                  |
| `src/flow/canvas-controller.ts:274`                                         | `target.id` from `handleAtPoint` → a card in the scene                                                                                                                                                                                                                                                                                            |
| `src/flow/canvas-controller.ts:515` `startDrag`                             | selected ids (pinned)                                                                                                                                                                                                                                                                                                                             |
| `src/flow/canvas-controller.ts:545` `idsWithin`                             | `scene.nodes()` ids                                                                                                                                                                                                                                                                                                                               |
| Inside `scene.ts` itself                                                    | `selectionBounds` (selected ids), `portWorld` (called by `edgePorts` with `edge.fromId`/`edge.toId` — **ids that may not be in `byId`**), `portZoneAt`/`nodeAt` (byId ids)                                                                                                                                                                        |

`src/flow/resize-handles.ts:10` (created by plan 002; it now owns the former
`canvas-controller.ts` `screenRect`) also calls `cardRect`; its ids come from
`nodeAt`, `scene.nodes()` and the selection, so the table's first and third
entries cover it.

`src/flow/connection-gesture.ts:50` calls `portWorld(nodeId, side)` for fixed
ends — selected ids or plus-zone ids, both in the scene. The connector layer
(`src/components/FlowEdges.tsx:141,191` via `scene.edgePorts`) is the reason
signals must still be created for absent ids: a connector keeps its far
anchor from the edge record while the far card is outside the read, and if
that card later enters the scene its real port must replace the anchor.

### Conventions and constraints

- `docs/standards.md` §6.2 (lines 225-242): derived values use `computed` or
  a cheap closure, never a signal written by an effect. The per-id rect
  signals introduced here are _state written by the scene's commands_ (the
  same pattern as today's `overrideSignals`), not effect-driven mirrors.
- §7.1: `FlowScene` is the only scene model; keep the card budget, throttled
  reads and selected-card pinning. §8.2: per-frame work proportional to
  visible cards; frame budgets are measured manually, never asserted in CI.
- §9: tests beside the subject; a reproducible fix adds a regression test
  that fails before and passes after.
- `src/flow/card-geometry.ts` is the exemplar of equality-gated values
  (`computed(..., { equals: samePosition })`, lines 60-73) and its test file
  `src/flow/card-geometry.test.ts:185-197` already asserts that "a viewport
  read that leaves a card where it was wakes neither memo" — keep it green.
- The generated record types are in `src/.nsh/types/@flow/native.d.ts`
  (do not edit that directory). `NodeSummary` (lines 145-160) fields:
  `id, kind, title, body, x, y, width, height, z, rev, dataJson,
  settingsJson, status, outputBatchId?` (optional, `string | null`).
  `EdgeSummary` (52-64): `id, fromId, toId, fromPort?, toPort?, kind,
  dataJson, fromPoint?, toPoint?` where the points are `EdgePoint {x, y}`.
- File size: at `02c2c36`, `scene.ts` is 547 total lines (≈401 code lines)
  and `scene.test.ts` is ≈483 code lines; the lint cap is 500 **code** lines
  (blanks and comments excluded). Keep added pure helpers in the new module
  created in step 1, not in `scene.ts`, and put new scene regression tests in
  the new `scene-reads.test.ts`, not `scene.test.ts`.
- No `any`, no `as` narrowing, no `!`; named exports only; kebab-case module
  names; tests beside the subject.

## Commands you will need

| Purpose                           | Command                                                                         | Expected on success                         |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Full gate                         | `bun run check`                                                                 | exit 0, zero warnings                       |
| All tests                         | `bun run test`                                                                  | exit 0, all pass                            |
| Scene tests                       | `nsh test src/flow/scene.test.ts`                                               | all pass                                    |
| New scene regression tests        | `nsh test src/flow/scene-reads.test.ts`                                         | all pass                                    |
| New helper tests                  | `nsh test src/flow/record-equality.test.ts`                                     | all pass                                    |
| Preview loader tests              | `nsh test src/flow/preview-loader.test.ts`                                      | all pass                                    |
| Geometry regression suite         | `nsh test src/flow/card-geometry.test.ts`                                       | all pass                                    |
| Controller/gesture suites         | `nsh test src/flow/canvas-controller.test.ts`                                   | all pass                                    |
| Optional before/after measurement | `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace` | prints per-step commits/JS/mount items      |
| Format check of edited docs       | `./node_modules/.bin/vp fmt --check CHANGELOG.md`                               | "All matched files use the correct format." |

## Scope

**In scope** (the only files you should modify):

- `src/flow/scene.ts`
- `src/flow/scene.test.ts` (only if an existing test needs adapting; do not
  append new tests here — it is ≈483 code lines against the 500 cap)
- `src/flow/scene-reads.test.ts` (create; the new scene regression tests)
- `src/flow/record-equality.ts` (create)
- `src/flow/record-equality.test.ts` (create)
- `src/flow/preview-loader.ts`
- `src/flow/preview-loader.test.ts` (create)
- `CHANGELOG.md` (`### Changed` under `## [Unreleased]`)
- `plans/README.md` (status row only, at the end)

**Out of scope** (do NOT touch, even though they look related):

- `src/components/**` and `src/pages/FlowPage.tsx` — readers must not need to
  change; if one does, the design is wrong.
- `src/flow/viewport-controller.ts` — its throttling/single-flight behaviour
  belongs to later plans (010, 011).
- `src/flow/previews.ts` — target-equality lives in `preview-loader.ts`; the
  loading function is unchanged.
- `src/flow/canvas-controller.ts`, `edge-gestures.ts`, `right-gesture.ts`,
  `connection-gesture.ts` — hit-test and allocation work is plan 008.
- `src/flow/card-geometry.ts`, `card-content.ts` — already equality-gated.
- Any generated file under `src/.nsh/`, any Rust file, any new dependency.

## Git workflow

- Branch: `advisor/007-reads-wake-only-changes` from `main`.
- Commit per logical step (record identity + prune gating; per-id rect
  signals; bounded map; stable previews + loader skip). Conventional Commits
  with a lower-case imperative subject and an explanatory body, in the style
  of `1956ebb perf: keep canvas gestures to one update per moved card` — e.g.
  `perf: wake only the cards a viewport read actually changed`.
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line. This is a standing project rule.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Add `sameNode` / `sameEdge` / `samePreviewView` pure helpers

Create `src/flow/record-equality.ts` (foundation layer; imports only types
from `@flow/native` and `PreviewView` from `./scene`):

```ts
import type { EdgeSummary, NodeSummary } from "@flow/native";
import type { PreviewView } from "./scene";

/** Exhaustive per-field equality; a new NodeSummary field is a compile error here. */
export function sameNode(a: NodeSummary, b: NodeSummary): boolean {
  const comparisons: { [K in keyof NodeSummary]: boolean } = {
    id: a.id === b.id,
    kind: a.kind === b.kind,
    title: a.title === b.title,
    body: a.body === b.body,
    x: a.x === b.x,
    y: a.y === b.y,
    width: a.width === b.width,
    height: a.height === b.height,
    z: a.z === b.z,
    rev: a.rev === b.rev,
    dataJson: a.dataJson === b.dataJson,
    settingsJson: a.settingsJson === b.settingsJson,
    status: a.status === b.status,
    outputBatchId: (a.outputBatchId ?? null) === (b.outputBatchId ?? null),
  };
  return Object.values(comparisons).every(Boolean);
}

export function sameEdge(a: EdgeSummary, b: EdgeSummary): boolean {
  const comparisons: { [K in keyof EdgeSummary]: boolean } = {
    id: a.id === b.id,
    fromId: a.fromId === b.fromId,
    toId: a.toId === b.toId,
    kind: a.kind === b.kind,
    dataJson: a.dataJson === b.dataJson,
    fromPort: (a.fromPort ?? null) === (b.fromPort ?? null),
    toPort: (a.toPort ?? null) === (b.toPort ?? null),
    fromPoint: samePoint(a.fromPoint ?? null, b.fromPoint ?? null),
    toPoint: samePoint(a.toPoint ?? null, b.toPoint ?? null),
  };
  return Object.values(comparisons).every(Boolean);
}

export function samePreviewView(a: PreviewView, b: PreviewView): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.count === b.count &&
    a.urls.length === b.urls.length &&
    a.urls.every((url, index) => url === b.urls[index])
  );
}

interface EdgePointLike {
  readonly x: number;
  readonly y: number;
}

function samePoint(a: EdgePointLike | null, b: EdgePointLike | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y;
}
```

The `{ [K in keyof T]: boolean }` mapped-object pattern is the EXHAUSTION
GUARD: every key in `T` must be assigned. If the generated `NodeSummary` /
`EdgeSummary` gains a field, `tsc` raises
`Property '<newField>' is missing in type ... but required in type ...`
at the literal, so the comparison cannot silently skip it. A wider object
(a `NodeSummary` with extra fields) is structurally assignable to a
narrower interface in TypeScript, so a plain field-by-field
`a.x === b.x && a.y === b.y && ...` body does NOT give that guarantee —
only the mapped-key object does. Do NOT replace this with a
`for (const k of Object.keys(...))` runtime loop, a `JSON.stringify`
compare, or a plain boolean chain; the whole point is that adding a
field to the generated type breaks compilation HERE, not silently
elsewhere.

- `samePreviewView` is hand-written rather than mapped because
  `PreviewView.urls` is an array — the comparison is element-wise, not
  reference equality. It must be updated by hand if `PreviewView` gains a
  field (the interface is local to `scene.ts`, not generated, so the
  exhaustiveness guard is the test below, not the type system).
- Header comments state the precision contract: these are exact field
  comparisons used for record identity; geometry tolerance stays in
  `scene.ts`'s existing `sameRect` (0.01 world units), which `setApplied`
  already uses and which this plan does not change.

Create `src/flow/record-equality.test.ts` modelled on
`src/flow/scene.test.ts`'s `node`/`edge` fixtures (lines 7-33; copy them):
field-equal fresh objects compare true; each of `title`, `body`, `status`,
`rev`, `outputBatchId` (null vs "batch" vs absent), `z`, `settingsJson`
differs → false; edges differing only in `fromPoint.x`/`toPoint` → false;
`fromPort: undefined` vs `null` → true; `PreviewView` same urls new array →
true, different count or one url → false.

**Verify**: `nsh test src/flow/record-equality.test.ts` → all pass.

### Step 2: Keep record identity in `apply` / `applyChangeSet`; gate `prune`'s arrays

In `src/flow/scene.ts`:

- In `apply`'s node loop, replace `this.byId.set(node.id, node)` with a keep-
  previous write: `const previous = this.byId.get(node.id); this.byId.set(node.id, previous !== undefined && sameNode(previous, node) ? previous : node);`
  then `this.setApplied(node)` as today (it already keeps rect identity).
  The `seen` set, selection pinning and removal loops are unchanged.
- In `applyChangeSet`'s `changed` loop do the same, and in its `edgesChanged`
  loop apply `sameEdge` to the **merged** record (after the far-anchor merge
  shown in Current state): set the merged object only when it differs from
  `previous`, else keep `previous`.
- In `apply`'s edge rebuild (`this.edgeById.clear(); for (const edge of snapshot.edges) ...` plus the pinned `keptEdges`), reuse the previous
  `EdgeSummary` object when `sameEdge(previous, edge)` before `clear()` runs
  (e.g. build a `retained` Map first). Pinned kept edges then win over the
  snapshot's duplicates exactly as today.
- At `prune()`'s tail, replace the two unconditional sets with ordered-list
  identity gating:

```ts
const nextNodes = [...this.byId.values()];
const currentNodes = untracked(this.nodes); // or this.nodes.peek-style untracked(() => this.nodes())
if (
  nextNodes.length !== currentNodes.length ||
  nextNodes.some((node, index) => node !== currentNodes[index])
) {
  this.nodes.set(nextNodes);
}
// same for edges
```

Read the current arrays with `untracked(() => this.nodes())` (add
`untracked` to the `nsh` import) so `prune` never subscribes a caller.
`byId` preserves insertion order exactly as before, so list order is
unchanged.

- Add regression tests to the new `src/flow/scene-reads.test.ts` (copy the
  `node`/`edge`/`snapshot`/`rect` fixtures from `scene.test.ts:1-41`; the
  effect-count pattern is "a drag's overrides notify only the cards it
  moves", now `scene.test.ts:402`):
  1. "an identical snapshot wakes no list or geometry reader" — effects over
     `scene.nodes()`, `scene.edges()`, and `scene.cardRect("a")`; re-apply
     `snapshot([...fresh node objects with identical fields...])` including
     an edge; expect zero further runs of each effect and
     `expect(scene.nodes()[0]).toBe(firstNodeObject)`.
  2. "a snapshot that changes one card's status replaces only that record" —
     `node("a", ..., { status: "running" })` on re-apply; `scene.nodes()`
     readers run once more; `scene.nodes()[1]` (the other card) keeps object
     identity.
- Note: after step 2, `cardRect` still reads `nodes()`, so the geometry
  effect in test 1 passes only because `nodes` is not re-set. Step 3 makes
  this independent of the list.

**Verify**: `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-reads.test.ts`
→ all pass (new tests 1-2 fail at the base of this plan, pass now);
`nsh test src/flow/card-geometry.test.ts` → all pass. Commit steps 1+2 together.

### Step 3: Per-id rect signals; `cardRect` stops reading `nodes()`

Replace the override-only granularity with effective-rect granularity:

- Rename the concept, not the public API: keep the existing private
  `overrideSignals` map and `overrideSignal(id)` accessor but store
  `Signal<BoxGeometry | null>` holding the **effective** rect
  (`overrideRects.get(id) ?? applied.get(id) ?? null`), and rename them to
  `rectSignals` / `rectSignal(id)` with a comment: "A card's effective rect
  as a signal of its own; a reader subscribes to exactly the ids it reads,
  including ids not in the scene yet (a connector's far endpoint)."
  (`scene.ts` is near the line cap — prefer renaming in place over adding a
  parallel map. If a rename proves confusing, keeping the old names with an
  updated comment is acceptable; behaviour is what is tested.)
- `cardRect(id)` becomes `return this.rectSignal(id)();` — no `nodes()` read,
  no `applied` lookup. The lazy accessor initializes the signal from current
  state, so an existing reader re-created after the refactor sees the same
  values.
- Update the signal in exactly these places (all already inside the plan-002
  batches; each write is a plain conditional set and returns early when the
  value is `===` the signal's current value read via `untracked`, so a
  card that did not move never notifies):
  - `setApplied(node)` — after updating `applied`, refresh `id`'s effective
    rect when there is no override and the applied rect object changed.
  - `setOverrides` — per id in the union, set the new effective rect
    (`next.get(id) ?? applied.get(id) ?? null`). Its existing comment about
    per-card notification stays true.
  - `clearOverrides` — per id that had an override, restore
    `applied.get(id) ?? null`.
  - `dropOverride(id)` — restore `applied.get(id) ?? null` (it is called on
    removal, where `applied` was already deleted → null, correct).
  - Removal in `apply` / `applyChangeSet` — after `byId.delete`/
    `applied.delete`/`dropOverride`, ensure the effective signal ends at
    `null` **for that moment**. Do not delete the signal here: a connector
    reader may be subscribed to an id whose card left the scene and must
    wake if the card returns. (Deleting is step 4's job, with the audience
    check.)
- `selectionBounds()` drops its `this.nodes()` read (its only other reads
  are `selection()` and per-id `cardRect`, which now subscribe correctly).
  `cardZ`, `frameZ`, `previewZ`, `framePlusZ` keep `this.nodes()` — `baseZ`
  still follows the record list, and plan 005's rank logic is untouched.
- Add regression tests to `src/flow/scene-reads.test.ts`:
  1. "a status change on one card does not wake another card's rect reader" —
     effects over `cardRect("a")` and `cardRect("b")`; `applyChangeSet` with
     `changed: [node("a", 40, 40, { status: "running" })]`; A's reader does
     not re-run either (its rect object is unchanged) and B's does not run;
     the existing test at 193-209 ("notifies geometry bindings when a change
     set moves a card") still passes for real moves.
  2. "a change set moving A wakes only A's rect readers" — B's effect run
     count stays 1 after A moves (before this step B also re-ran because
     `nodes` was re-set).
  3. "a far endpoint that enters the scene and moves wakes a connector reader
     that read it while absent" — reproduce the setup of "keeps a connector
     whose far card left the scene" (69-95): `effect(() => { scene.cardRect("b"); runs++; })` while `b` is absent; `applyChangeSet({ changed: [node("b", 300, 0)], ... })`
     (which the scene accepts for ids not yet present, see 174-191); expect
     the effect to re-run and `cardRect("b")` to equal the new rect; then a
     second change set moving `b` re-runs it again with the new x.
  4. "an identical snapshot wakes no card rect reader" — after step 2 the
     `nodes` array is already stable; this test now also passes when the
     snapshot contains a changed _other_ card: re-apply with A field-equal
     and B moved; A's rect effect must not re-run.

**Verify**: `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-reads.test.ts`
→ all pass;
`nsh test src/flow/card-geometry.test.ts` and
`nsh test src/flow/canvas-controller.test.ts` → all pass;
`nsh test src/App.test.tsx` → all pass. Commit.

### Step 4: Bound the per-id signal map (separate commit)

Before writing any code, re-run the audience audit in Current state with
`grep -rn "cardRect(" src/` and, for `FlowPage.tsx`'s `inlinePosition`,
trace `inlineId` in `src/flow/node-session.ts`:

- `inlineId` is set by `openInline(nodeId)` (node-session.ts:222-239) only
  after `document.getNode` returned a **text** node, and `FlowPage` closes
  the inline editor before opening a composer for a different card
  (FlowPage.tsx:136-137, 151-158). The open-inline path is a double click on
  a card, which first `scene.select([id])`-or-toggle selects it in
  `CanvasController.down` (canvas-controller.ts:258-263 runs before
  `openInline`). The async `getNode` gap is the risk: if the card can leave
  the scene between the double click and `inlineId.set(nodeId)`, the editor
  could anchor to an unselected, unpinned id — **STOP this step if you find
  such a path** (for example a test or flow that opens the editor for a card
  that was never selected and then pans it out of the scene).

If the audit holds, implement:

- Add a private `trimRectSignals()` called at the end of `apply` and
  `applyChangeSet`, inside their batches, after `prune()`. For each id in
  `rectSignals`, delete the entry only when ALL of these hold:
  - `!this.byId.has(id)` — not a scene card;
  - `!this.selection().includes(id)` — not pinned (selection can only contain
    byId ids after `prune`, so this is defence in depth);
  - `!this.overrideRects.has(id)` — no transient geometry;
  - no edge in `this.edgeById.values()` has `fromId === id || toId === id`.
    Compute the endpoint set once per call, not per id; skip the whole scan
    when `rectSignals.size === 0`.
  - When deleting, first set the signal to `null` if its current value is
    not already `null` (read via `untracked`) so any subscriber left by a
    missed audience member goes to null rather than freezing on a stale
    rect; then delete it from the map. A later `cardRect(id)` re-creates a
    signal initialized from current state, so re-entry is safe.
- Add a **diagnostic-only** accessor with a comment marking it as a test
  diagnostic, e.g. `rectSignalCount(): number { return this.rectSignals.size; }`.
  It is not used by the app.
- Tests in `src/flow/scene-reads.test.ts`:
  1. "rect signals stay bounded after many disjoint reads" — apply a snapshot
     of 5 cards, read `cardRect` of each, then apply a disjoint snapshot of 5
     different cards (no edges, no selection) and read those; expect
     `scene.rectSignalCount()` to be ≤ the live card count (5), not 10.
  2. "a connector's absent far endpoint keeps its signal until its edge goes" —
     from the far-endpoint setup (scene.test.ts:69-95), read `cardRect("b")`
     while `b` is absent; applying an identical snapshot (edge `a-b` still
     present) must not delete the signal (count unchanged and the step-3
     wake-up test still passes); after the edge is removed and a snapshot
     with neither `a` nor `b` applies, the entry is collected.
  3. The step-3 far-endpoint wake-up test must still pass (this is the
     regression guard against over-eager deletion).

**Verify**: `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-reads.test.ts`
→ all pass;
`bun run test` → exit 0. Commit separately from step 3.

### Step 5: Stable previews and skipping unchanged preview loads

In `src/flow/scene.ts` `applyPreviews`:

- Build `next` reusing the previous `PreviewView` object when
  `samePreviewView(previous, incoming)` (previous from
  `untracked(() => this.previews()).get(preview.nodeId)`), still filtering to
  `byId` ids.
- Skip `this.previews.set(next)` when the resulting map is identical to the
  current one: same size, same iteration order of keys (build it in the
  input order, as today), and every value `===` the previous value. Because
  `PreviewView` identity is preserved, this makes an unchanged reload a
  no-op for readers.

In `src/flow/preview-loader.ts`:

- Add `private lastTargets: readonly PreviewTarget[] | null = null;` and at
  the start of `refresh()`, compute `const targets = scene.previewTargets()`
  and return early (before `++this.generation`) when `sameTargets(this.lastTargets, targets)`. Set `this.lastTargets = targets` immediately before
  the `await loadPreviews(...)` call so a failed load can be retried by the
  next _changed_ schedule but repeated identical schedules do not refetch.
  Write a module-level pure helper
  `sameTargets(a: readonly PreviewTarget[] | null, b: readonly PreviewTarget[]): boolean`
  comparing length and each `{id, batchId}` pair in order, exported for the
  unit test. `PreviewTarget` is imported type-only from `./previews`.
  Note the scene's `previewTargets()` (scene.ts:426-434) iterates `byId`
  insertion order, which is stable across identical reads after step 2.
- Document why: every viewport read and change set calls `schedule()`
  (FlowPage.tsx:75, viewport-controller.ts:74), so target equality is what
  prevents a redundant `document.previews` round trip and a redundant
  `applyPreviews` on every pan.
- Tests:
  - `src/flow/scene-reads.test.ts`: "identical previews keep their identity and wake
    no reader" — after `applyPreviews` with one image card (setup copied from
    "previews only the cards in the scene", now `scene.test.ts:538`), an effect reading
    `scene.previews()`; re-apply field-equal previews (new `PreviewView`
    object, new urls array, same contents) and expect no further effect run
    and `scene.previews().get("a")` to be the previous `PreviewView` object;
    then apply with `count` changed and expect one run.
  - `src/flow/preview-loader.test.ts` (create; no existing test file — model
    the fake-document style on `src/flow/scene.test.ts` fixtures plus a stub
    `Document`/`AssetUrls`; tests may cast through `unknown` to build a typed
    stand-in per standards §5):
    1. `sameTargets` unit cases (null vs empty, order matters, batchId change).
    2. `"an unchanged target list does not reload previews"` — fixture: a
       fake `Document` whose `previews(ids)` counts calls AND returns a
       non-empty `NodePreview[]` for the requested ids (e.g. one entry
       `{ nodeId: "a", items: [], itemCount: 0 }` — empty `items` is fine;
       what matters is that `loadPreviews`'s outer early-out
       `if (targets.length === 0) return [];` at `previews.ts:18-19` does
       NOT short-circuit, so the `document.previews` call is actually
       reached). Attach a fake `AssetUrls` whose `url()` would throw if
       called (no image items → never called). Stub the scene so
       `previewTargets()` returns the constant
       `[{ id: "a", batchId: "batch-a" }]` on every call, and
       `applyPreviews` counts invocations. Call `await loader.refresh()`
       TWICE. Expect `document.previews` was called ONCE, `applyPreviews`
       was called ONCE with the loaded list (length 1). The second
       `refresh()` bails out at the new `sameTargets` early-return,
       proving the skip works without reaching the loading function.
    3. `"a changed target list reloads"` — same fixture, but the stub
       `scene.previewTargets()` returns a different list on the second
       call (e.g. add `{ id: "b", batchId: "batch-b" }`). Expect a second
       `document.previews` read and a second `applyPreviews` invocation.
    4. `"an empty target list is its own early-out"` — stub the scene so
       `previewTargets()` returns `[]`. Call `await loader.refresh()`.
       Expect NO `document.previews` call (the `loadPreviews` early-out
       at `previews.ts:18-19` short-circuits before the FFI) AND NO
       `applyPreviews` call (the early-out also skips publication). This
       locks in the empty-case behaviour explicitly so future changes do
       not collapse it into case 2.
       Keep the fake minimal: `PreviewHost` needs `document()`, `assets()`,
       `scene()`, `isDisposed()` only; no timers are used when calling
       `refresh()` directly. If constructing a type-correct `Document` stub
       proves impractical, STOP and report rather than introducing `any`.

**Verify**: `nsh test src/flow/scene.test.ts && nsh test src/flow/scene-reads.test.ts && nsh test src/flow/preview-loader.test.ts` → all pass; `bun run test` → exit 0. Commit.

### Step 6: Changelog and full gate

Add one `### Changed` bullet under `## [Unreleased]` in `CHANGELOG.md`:
viewport reads and command results now keep unchanged card and connector
records identical, so a read that changes nothing wakes no card, composer,
frame or connector binding; geometry is published through one signal per
card, so a change set wakes only the cards it actually moved; unchanged
image previews are neither reloaded nor re-published. Match the existing
prose style (see the `### Changed` entry at lines 61-72 for the sibling
equality-gating change).

**Verify**: `./node_modules/.bin/vp fmt --check CHANGELOG.md` → "All matched
files use the correct format."; `bun run check` → exit 0, zero warnings
(including the 500-code-line cap on `scene.ts`; helper code went to
`record-equality.ts`).

## Test plan

New tests (each must be observed failing at the base of the relevant step
where the spec says "regression"):

- `src/flow/record-equality.test.ts` (create): `sameNode`/`sameEdge`/
  `samePreviewView` field coverage, optional-vs-null normalization, point
  comparison. Model fixtures on `src/flow/scene.test.ts:7-33`.
- `src/flow/scene-reads.test.ts` (create; copy the `node`/`edge`/`snapshot`/
  `rect` fixtures from `scene.test.ts:1-41`):
  - identical snapshot wakes no `nodes`/`edges`/`cardRect` reader (step 2);
  - one changed record replaces only that record (step 2);
  - status change on A wakes neither A's nor B's rect reader (step 3);
  - moving A wakes only A's rect readers (step 3);
  - far endpoint entering then moving wakes its early reader (step 3/4);
  - bounded map after disjoint reads; far-endpoint retention until its edge
    goes (step 4);
  - identical previews keep identity, wake no reader (step 5).
- `src/flow/preview-loader.test.ts` (create): `sameTargets` unit cases
  (null vs empty, order matters, batchId change); "an unchanged target
  list does not reload previews" (one read + one apply across two
  `refresh()` calls with a non-empty constant target list and a stub
  `document.previews` that returns one `NodePreview`); "a changed target
  list reloads" (second read + second apply); "an empty target list is
  its own early-out" (no read, no apply — locks in `previews.ts:18-19`'s
  `targets.length === 0` behaviour).

Existing tests that are the safety net and must stay green:
`src/flow/scene.test.ts:193-209` (change-set move notification),
`src/flow/scene.test.ts:69-95` (far anchors), `src/flow/card-geometry.test.ts`
entire file (drag/move/resize/identical-read memo behaviour),
`src/flow/canvas-controller.test.ts`, `src/flow/frame-connection.test.ts`,
`src/App.test.tsx`.

Verification: `bun run test` → exit 0 with all new tests included.

## Done criteria

- [ ] `grep -n "this.nodes();" src/flow/scene.ts` shows reads only in `cardZ`, `frameZ`, `previewZ`, `framePlusZ` — none in `cardRect` or `selectionBounds`.
- [ ] `grep -n "sameNode\|sameEdge\|samePreviewView" src/flow/scene.ts` shows the helpers used in `apply`, `applyChangeSet` and `applyPreviews`.
- [ ] `src/flow/record-equality.ts` and its test exist; `src/flow/scene-reads.test.ts` and `src/flow/preview-loader.test.ts` exist.
- [ ] `bun run test` exits 0; every regression test listed above was seen failing before its step and passing after.
- [ ] `bun run check` exits 0 with zero warnings.
- [ ] `CHANGELOG.md` has the new bullet.
- [ ] `src/flow/scene.test.ts` is unchanged unless an existing test required
      adaptation; all new scene regression tests are in `scene-reads.test.ts`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated and formatted.

## STOP conditions

Stop and report back (do not improvise) if:

- The dependency checks fail: `grep -n "batch(" src/flow/scene.ts` shows no
  batches (plan 002 not landed) or the `apply`/`applyChangeSet`/
  `prune`/`applyPreviews` bodies differ from the excerpts for a reason not
  explained by plans 002/005.
- The step-4 audience audit finds a `cardRect` reader that can hold an id
  which is not a scene card, not selected/pinned, not an edge endpoint and
  has no override — the prime suspect is `inlinePosition`'s `inlineId` after
  the async `openInline`, or any future caller added since this plan was
  written. If found, skip the deletion step entirely (keep the map
  unbounded), report the caller, and finish the remaining steps.
- A rect signal would need to be written from an effect or a component to
  stay in sync (standards §6.2 forbids this): all writes must stay in the
  scene's command methods inside their batches.
- A test shows a connector failing to move when its far card enters the
  scene, or a stale rect after `dropOverride`/removal — the effective-rect
  update ordering is wrong; do not patch readers.
- Constructing the preview-loader test fakes would require `any` or weakening
  the strict compiler flags.
- `bun run check` reports `max-lines` on `scene.ts` after the edits: stop and
  report rather than extracting scene internals into new modules (a separate
  structural decision).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- When the generated `NodeSummary`/`EdgeSummary` types gain a field,
  `sameNode`/`sameEdge` MUST assign a comparison for it inside the
  `{ [K in keyof T]: boolean }` mapped object literal — TypeScript rejects
  the literal at compile time when a key is missing, which is the
  exhaustion guard. Do NOT simplify to a plain `a.x === b.x && ...` chain
  (a wider object is structurally assignable to the narrower interface,
  so a new field would silently compare unequal-except-for-the-new-field
  as equal), to a `keyof` runtime loop, or to `JSON.stringify`. The mapped
  object is the canonical form. `samePreviewView` is hand-written because
  `PreviewView.urls` is an array and the comparison is element-wise; if
  `PreviewView` (local to `scene.ts`) gains a field, add the check by
  hand — the unit test in `record-equality.test.ts` is the safety net.
- `sameRect`'s 0.01 tolerance remains the geometry-level gate inside
  `setApplied`; record identity (`sameNode`) is exact. The two precisions are
  deliberate — do not unify them.
- Later plans interact here: plan 008 adds an edge pair index that must be
  invalidated where `edgeById` changes (the same places this plan adds
  identity reuse); plan 011 narrows the viewport read so far endpoints carry
  only geometry, which makes the absent-id rect-signal path in step 3 even
  more load-bearing.
- A reviewer should scrutinize: the far-anchor merge still happens before
  `sameEdge` compares (otherwise every change set would look like an edge
  change); `untracked` is used for every current-value read inside command
  methods; removal drops the override before the effective rect is computed
  so a deleted card publishes `null` exactly once; and `trimRectSignals` runs
  after `prune()` so selection/edge retention is already settled.
- Deviation from the original design to note for the advisor: the bounded-map
  step was kept as a separate commit with its own tests, and deletion first
  publishes `null` before removing the entry — even though the audience audit
  passed at planning time, this keeps a missed future reader from freezing
  on a stale rect instead of losing its subscription silently.
