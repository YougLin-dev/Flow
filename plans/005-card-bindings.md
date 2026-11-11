# Plan 005: Rebuild a card's plus buttons and border only when its own state flips

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1956ebb..HEAD -- src/components/FlowCard.tsx src/components/FlowCanvas.tsx src/flow/scene.ts src/flow/canvas-controller.ts src/flow/keyed-flags.ts src/flow/keyed-flags.test.ts src/flow/hover-flags.ts src/flow/hover-flags.test.ts src/flow/resize-handles.ts src/flow/resize-handles.test.ts src/flow/scene.test.ts src/flow/canvas-controller.test.ts docs/standards.md CHANGELOG.md plans/README.md`
>
> This plan depends on **002-batch-scene-writes**. Confirm that plan's row is
> DONE in `plans/README.md` (advisor-maintained; the executor updates only
> this plan's own row at the end). Changes made by 002 are expected; compare
> only the excerpts this plan edits. A mismatch NOT explained by 002 is a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-batch-scene-writes.md
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10

## Why this matters

Every canvas-wide selection, hover, marquee-preview or connection-target
change currently re-runs work on **every visible card**:

- `FlowCard.tsx:227-232` renders the two `PortPlus` buttons with
  `{showPlus() ? <PortPlus/> : null}` ternaries. NSH compiles JSX dynamic
  children to function children without a condition memo, so each re-run of
  the child destroys and re-creates the `PortPlus` subtree (3 views, an icon
  canvas, two animated values and an effect) even while `showPlus()` stays
  `true`.
- The image body's "No output yet" text (lines 180-182) is the same shape.
- `active()` (line 73) is a plain closure read twice by the body's
  `classList` binding (lines 156-160). Any change of `selection`,
  `marqueePreview`, `hovered` or `connectionTarget` re-runs it on every
  card, and the `classList={{...}}` object literal is always a fresh object,
  so NSH re-sends the prop and restyles each card's body.
- `FlowCanvas.tsx:288-293` answers membership with
  `selection().includes(id)`, an O(S) scan per card.

Measured cost ([C] in the advisor's shared numbers): a single `hovered`
change at N=2000 visible cards costs 9.8-12.5 ms JS + ~2,050 ops; a
`marqueePreview` change 6.7-7.5 ms; a 300-card marquee release at N=800
makes 602 `PortPlus` and destroys 600, adding 16 ms core and 11,151 mount
items. A prototype with keyed per-card flags cut the hover step to 0.10 ms
JS and the marquee-preview step to 0.09 ms.

The work splits into two deliverable tiers. **Tier 1** (LOW risk) replaces
the ternaries with `<If>`, turns `active`/`showPlus` into `computed`, and
adds `FlowScene.isSelected(id)`. **Tier 2** (MED risk) adds a small keyed
per-id boolean-flag helper in `src/flow/` and mirrors `selection`,
`hovered`, `marqueePreview` and `connectionTarget` into it — inside the
same write methods (and the same `batch` 002 added), never from an effect —
so a canvas-wide change wakes only the cards whose flag flipped.

## Current state

After plan 002 has landed, `FlowScene.apply`, `applyChangeSet`,
`setOverrides`, `clearOverrides` and `select` each wrap their bodies in
`batch(() => { ... })`, and exactly these six `CanvasController` entry
points are batched the same way: `down`, `move`, `up`, `cancel`, `leave`,
`hover`. `beginPan` writes only `cursor` (a single signal) and is therefore
NOT batched by 002 — it stays unbatched, per `docs/standards.md` §6.1
("`batch` is not a performance ritual"). Plan 002 step 3b has also already
moved `screenRect`, `handleAtPoint` and `cursorFor` into
`src/flow/resize-handles.ts`, so the controller sits comfortably below the
500-code-line cap BEFORE this plan adds the hover-flags mirror.

Quick check: `grep -n "batch(" src/flow/scene.ts src/flow/canvas-controller.ts`
must show several matches. If it shows none, plan 002 has not landed: STOP.

Precondition from plan 002 step 3b (REQUIRED for the max-lines cap):
`test -f src/flow/resize-handles.ts && ! grep -n "function handleAtPoint\|function cursorFor" src/flow/canvas-controller.ts`
must succeed (the file exists and the controller no longer hosts the
implementations). If this fails, plan 002 step 3b has not landed and the
controller is still around 484 code lines, leaving no room for the
hover-flags mirror that this plan adds — STOP and report rather than
letting step 6 take the controller over 500.

### Relevant files at HEAD 1956ebb

- `src/components/FlowCard.tsx` — one node card: title + status row, body
  container, plus buttons. Excerpts below.
- `src/components/FlowCanvas.tsx` — renders `<Each of={props.scene.nodes()}>`
  and binds each `FlowCard`'s props (lines 274-304).
- `src/components/PortPlus.tsx` — the plus button; read it to understand
  what a re-create costs (two `createAnimatedValue`s, one `effect`, one
  `cleanup`, an `<Icon>` canvas, a childless border `<View>`).
- `src/flow/scene.ts` — `selection` signal at line 43, `connectionTarget` at
  line 48, `select()` at 177-188, `setConnectionTarget()` at 420-423, the
  `selectionRanks()` map helper at 294-302.
- `src/flow/canvas-controller.ts` — `hovered` at line 82, `marqueePreview`
  at 78, `setPreview`/`clearPreview` at 552-561.
- `src/flow/card-content.ts` — exemplar of the equality-gated accessors
  pattern used throughout `flow/`; `CardContent` is the closest existing
  model for the "per-card gated value" idiom.
- `src/flow/card-geometry.ts` — exemplar of a class that owns two
  `computed`s with custom `equals`; use its `wakes()` test idiom.
- `src/flow/scene.test.ts` — test at lines 305-325 ("a drag's overrides
  notify only the cards it moves") is the work-count pattern to copy.
- `src/flow/canvas-controller.test.ts` — `setup()` at lines 45-92 returns
  `{ scene, camera, controller, calls, useTool }`; use it for the new
  controller tests.

### Excerpts (at 1956ebb; plan 002 adds `batch` around writers only)

`src/components/FlowCard.tsx:73-84`:

```ts
const active = () => props.selected() || props.previewed() || props.hovered() || props.target();
// ...
const showPlus = () => !props.plusSuppressed() && (props.selected() || props.hovered());
```

`src/components/FlowCard.tsx:154-182` (body container and image branch):

```tsx
<View
  accessibilityLabel={content.title()}
  classList={{
    "absolute rounded-2xl border bg-card shadow-lg": true,
    "border-chart-1": active(),
    "border-border": !active(),
  }}
  style={{ /* ... */ }}
>
  {content.image() ? (
    <View /* ... */>
      {props.preview() === null || props.preview()?.urls.length === 0 ? (
        <Text class="text-xs text-muted-foreground">No output yet</Text>
      ) : null}
```

`src/components/FlowCard.tsx:227-232` (the two plus ternaries):

```tsx
{
  showPlus() ? (
    <PortPlus accent={accent()} base={() => plusBase("in")} follow={() => plusFollow("in")} />
  ) : null;
}
{
  showPlus() ? (
    <PortPlus accent={accent()} base={() => plusBase("out")} follow={() => plusFollow("out")} />
  ) : null;
}
```

`src/components/FlowCanvas.tsx:283-301` (card prop bindings):

```tsx
<FlowCard
  node={node}
  rect={() => props.scene.cardRect(id)}
  zIndex={() => props.scene.cardZ(id)}
  preview={() => props.scene.previews().get(id) ?? null}
  selected={() => props.scene.selection().includes(id)}
  previewed={() => props.controller.marqueePreview().has(id)}
  hovered={() => props.controller.hovered() === id}
  plusSuppressed={() => props.controller.multiFrame() && props.scene.selection().includes(id)}
  plus={() => {
    /* ... */
  }}
  target={() => props.scene.connectionTarget() === id}
/>
```

`src/flow/scene.ts:294-302` (`selectionRanks`):

```ts
private selectionRanks(): ReadonlyMap<string, number> {
  const selection = this.selection();
  if (selection !== this.ranksFor) {
    this.ranksFor = selection;
    this.ranks.clear();
    selection.forEach((id, index) => this.ranks.set(id, index + 1));
  }
  return this.ranks;
}
```

### NSH facts that drive the design (verified in the NSH fork)

- `{cond() ? <Comp/> : null}` compiles to a function child with **no
  condition memo** (`nsh-bundler/src/jsx.rs:1050-1058`), and each function
  child of an insert array gets an item memo (`nsh-js/src/dom.rs:1997-2090`)
  — so the child re-creates `Comp` whenever anything `cond()` reads changes,
  even while truthy.
- `<If when={...}>{...}</If>` compiles to `cond`, which renders its branch
  **once per change of truthiness** (`nsh-js/src/dom.rs:2510-2560`, see the
  `cond_run` function: a branch is picked by `JS_ToBool` and the render runs
  under `untracked_with`). `If` is a JS global declared in
  `nsh-js/src/host.rs:1592-1601` with signature
  `declare function If<T>(props: { when: T; else?: JSX.Element; children?: JSX.Element | ((value: () => NonNullable<T>) => JSX.Element) })`.
  Use the static-child form (`<If when={...}><PortPlus .../></If>`) — the
  child is created once when the condition becomes truthy.
- A bound prop is skipped only when the new value is `===` the previous one
  (`bind_prop_run`, `nsh-js/src/dom.rs:1640-1665`). A `classList={{...}}`
  object literal is always new, so each re-run re-sends the prop.
- NSH has **no** `createSelector`. `computed(fn, options?)` and
  `signal(value, options?)` accept `SignalOptions<T> = { equals?: false | ((previous: T, next: T) => boolean) }`
  (`src/.nsh/types/nsh/index.d.ts:18-21, 567, 571`). `batch` is at line 581.
  Reactivity is Solid 1.9 (`nsh-core/src/reactive.rs`): reads see the latest
  memo, effects run once at the end of a round.

### Repo rules that apply (from `docs/standards.md`)

- §6.2 (lines 227-242): a component body is one-time setup; derived values
  MUST use `computed` (or a cheap closure); an effect MUST synchronize an
  external system and MUST NOT write a signal it also reads; "NSH does not
  accept signal writes from inside the canvas draw/layout computation."
- §6.1 (lines 220-221): "Use one `batch` only when several writes form one
  invariant; `batch` is not a performance ritual."
- §4 (line 138): `max-lines` caps a module at 500 code lines (excluding
  blanks/comments). `src/flow/canvas-controller.ts` is already ~500 code
  lines today; mirror logic goes in a NEW module, not in that file.
- §4 (line 135): one job per module, kebab-case modules, tests beside code
  as `<subject>.test.ts`.
- §4 (line 141): exports MUST be named; no default exports in app code.
- §5 (lines 162-197): no `any`, no `as` narrowing, no `!`; object shapes
  MUST use `interface`.
- §13 "New canvas feature" (lines 639-647): pure helpers live in
  `src/flow/`; the view in `src/components/`.
- Changelog rule (line 495-497): a user-visible or notable performance
  change adds an `Unreleased` bullet in `CHANGELOG.md` under the Keep a
  Changelog categories. `### Changed` is at line 59.

## Commands you will need

| Purpose                                          | Command                                                 | Expected on success                    |
| ------------------------------------------------ | ------------------------------------------------------- | -------------------------------------- |
| Full gate (typecheck + lint + rule tests + Rust) | `bun run check`                                         | exit 0                                 |
| All tests (Rust + TSX headless)                  | `bun run test`                                          | exit 0, all pass                       |
| One test file                                    | `nsh test src/flow/scene.test.ts`                       | all pass                               |
| One controller test file                         | `nsh test src/flow/canvas-controller.test.ts`           | all pass                               |
| Tests by name                                    | `nsh test src/flow/scene.test.ts --filter "isSelected"` | matching pass                          |
| Apply safe formatting fixes                      | `bun run check:fix`                                     | exit 0                                 |
| Per-step commit timings                          | `nsh test src/App.test.tsx --filter "<name>" --trace`   | prints per-step commits/JS/mount items |

## Scope

**In scope** (the only files you should modify):

- `src/components/FlowCard.tsx`
- `src/components/FlowCanvas.tsx`
- `src/flow/scene.ts`
- `src/flow/canvas-controller.ts`
- `src/flow/keyed-flags.ts` (create — tier 2)
- `src/flow/keyed-flags.test.ts` (create — tier 2)
- `src/flow/hover-flags.ts` (create — tier 2, step 6)
- `src/flow/hover-flags.test.ts` (create — tier 2, step 6, OPTIONAL; if
  you instead rely on the controller tests in step 6, do NOT create this
  file and note that choice in the commit body)
- `src/flow/scene.test.ts`
- `src/flow/canvas-controller.test.ts`
- `docs/standards.md` (one short addition in §6.2 about keyed flags written
  inside the writer's batch)
- `CHANGELOG.md` (a bullet under `## [Unreleased]` → `### Changed`)
- `docs/testing.md` (add `flow/keyed-flags.test.ts` to the Unit row — tier 2)
- `docs/architecture.md` (mention `keyed-flags.ts` and `hover-flags.ts` in
  the flow module list if it names each module — tier 2)
- `plans/README.md` (advisor-maintained; the executor updates only this
  plan's own status row at the end)

**Read-only dependencies** (do NOT edit; needed by tests or imports):

- `src/flow/resize-handles.ts`, `src/flow/resize-handles.test.ts` — created
  by plan 002 step 3b. Verified as a precondition at the top of this plan.
  Imports of `handleAtPoint`/`cursorForHandle` in the controller's hover
  branch stay untouched by this plan.

**Out of scope** (do NOT touch, even though they look related):

- `src/components/FlowEdges.tsx` — plans 003 and 004 own it.
- `src/pages/FlowPage.tsx` — no wiring changes are needed; the scene and
  controller objects the page constructs are the same classes.
- `src/flow/viewport-controller.ts`, `src/flow/edge-gestures.ts`,
  `src/flow/connection-gesture.ts` — out of scope. `setConnectionTarget` is
  called by `connection-gesture.ts`; do NOT edit it — the mirror goes inside
  `FlowScene.setConnectionTarget` itself.
- `src/components/SelectionFrame.tsx`, `SelectionPluses.tsx`,
  `SelectionOverlay.tsx` — plan 016 owns their camera-scale reads.
- `src/store.ts` — no new store state.
- Anything in `src/native/` — no FFI changes.

## Git workflow

- Branch from `main`: `git switch -c advisor/005-card-bindings`.
- Commit per logical step; Conventional Commits with a lower-case imperative
  subject and an explanatory body, matching `git log` — e.g.
  `perf: keep canvas gestures to one update per moved card` (1956ebb),
  `fix: open the canvas menu after a click on the canvas` (21dbe05).
  Suggested subjects:
  - Tier 1: `perf: build a card's pluses and border from gated values`
  - Tier 2: `perf: wake only the cards whose flags flipped`
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line. This is a standing project rule.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1 (Tier 1): Replace the plus and "No output yet" ternaries with `<If>`

In `src/components/FlowCard.tsx`:

1. Replace BOTH `{showPlus() ? <PortPlus .../> : null}` ternaries
   (lines 227-232) with `<If when={showPlus()}>...</If>` blocks. Use the
   static-child form (no function child). The two `<If>`s are independent;
   do NOT wrap them in one parent.
2. Replace the image body's `{preview-empty ? <Text/> : null}` ternary
   (lines 180-182) with `<If when={props.preview() === null || props.preview()?.urls.length === 0}><Text class="text-xs text-muted-foreground">No output yet</Text></If>`.
3. Replace the text body's three-way ternary ONLY in its empty-body
   else-branch. The CURRENT shape (FlowCard.tsx:120-224) is:
   ```tsx
   {
     content.image() ? (
       <View>{/* image branch ... */}</View>
     ) : body() === "" ? (
       <Text class="...">No output yet</Text>
     ) : (
       <Text class="...">{truncate(body(), 600)}</Text>
     );
   }
   ```
   KEEP the outer `content.image()` ternary intact. Replace ONLY the inner
   `body() === "" ? <Text>No output yet</Text> : <Text>{truncate(...)}</Text>`
   with the following exact structure (note the polarity swap so the
   `<If>` branch is the empty case):
   ```tsx
   {
     content.image() ? (
       <View>{/* image branch ... unchanged */}</View>
     ) : (
       <>
         {body() !== "" ? <Text class="...">{truncate(body(), 600)}</Text> : null}
         <If when={body() === ""}>
           <Text class="...">No output yet</Text>
         </If>
       </>
     );
   }
   ```
   Reason for this exact shape: JSX dynamic children re-run on every read,
   but `<If when={...}>` renders its branch once per truthiness change
   (see "NSH facts" above). The two branches are now independent — the
   non-empty text still flows through a ternary (its identity changing is
   fine; the Text already re-renders on body changes), while the empty
   "No output yet" Text is created once when the body empties and
   destroyed when it fills. Do NOT reorganize the outer image/text ternary
   in this step. Plan 014's step 4 (card paint scale) inherits this exact
   shape; if 014 also touches the JSX it must preserve this structure.
4. `<If>` is a global, like `<Each>`: no new import.

**Verify**: `bun run check` → exit 0. `bun run test` → all pass, especially
the App tests that press cards, start connections and assert the plus
buttons appear.

### Step 2 (Tier 1): Memoize `active` and `showPlus`

In `FlowCard.tsx`:

1. `const active = computed(() => props.selected() || props.previewed() || props.hovered() || props.target());`
   The component body is one-time setup, so `computed` is the right tool
   (standards §6.2). Default `===` equality on the boolean result is enough.
2. `const showPlus = computed(() => !props.plusSuppressed() && (props.selected() || props.hovered()));`
3. `computed` is already imported from `"nsh"` at line 11 — no import change.
4. Leave `plusBase`/`plusFollow`/`lineCount`/`layout` as cheap closures —
   they return objects whose identity changes, so memoizing them buys
   nothing here.

**Verify**: `bun run check` → exit 0. `nsh test src/flow/card-geometry.test.ts src/flow/card-content.test.ts` → all pass (these cover the adjacent gating
pattern; nothing in them regresses).

### Step 3 (Tier 1): Add `FlowScene.isSelected(id)` and use it in `FlowCanvas`

In `src/flow/scene.ts`, add a public method after `cardZ` (line 245):

```ts
/** Whether `id` is in the current selection (ranks-map lookup, O(1)). */
isSelected(id: string): boolean {
  return this.selectionRanks().has(id);
}
```

`selectionRanks()` reads `selection()` internally, so the method tracks the
selection signal — readers still wake on any selection change; tier 2 fixes
that.

In `src/components/FlowCanvas.tsx` (lines 288, 292):

- `selected={() => props.scene.isSelected(id)}`
- `plusSuppressed={() => props.controller.multiFrame() && props.scene.isSelected(id)}`

Add two tests to `src/flow/scene.test.ts`, modeled on the "caps a snapshot
but keeps the selected cards" test (lines 55-67):

1. `"isSelected answers from the selection ranks"`: after `apply([a, b, c])`
   and `select(["b", "a"])`, assert `isSelected("a") === true`,
   `isSelected("b") === true`, `isSelected("c") === false`; after
   `select([])`, all false; after `select(["missing-id"])`, no change in
   membership for real cards and `isSelected("missing-id") === false`.
2. `"isSelected stays consistent through a snapshot that prunes the scene"`:
   select `a` and `b`, then `apply(snapshot([c]))` — `a` and `b` are pinned
   by `apply`, so they remain selected — assert `isSelected("a") === true`.
   Then `applyChangeSet({ changed: [], removed: ["a"], edgesChanged: [], edgesRemoved: [] })`
   prunes the selection via `prune()` — assert `isSelected("a") === false`.

**Verify**: `nsh test src/flow/scene.test.ts --filter "isSelected"` → 2 new
tests pass. `bun run check` → exit 0.

**Commit tier 1 here** (subject above). Tier 1 must land and be green before
tier 2 starts.

### Step 4 (Tier 2): Create `src/flow/keyed-flags.ts`

Create the module with one exported class, `KeyedFlags`, owning a
`Map<string, Signal<boolean>>`:

```ts
/**
 * Per-id boolean signals that mirror one canvas-wide state (selection,
 * hover, …). A writer updates the flags in the SAME write and batch as the
 * source signal, so a card binding reads either form in the same round.
 * Only the ids whose value flips wake their readers.
 */
import { signal, type Signal } from "nsh";

export class KeyedFlags {
  private readonly flags = new Map<string, Signal<boolean>>();
  private readonly present = new Set<string>();

  /** Reads `id`'s flag, tracking it. Defaults to false for unknown ids. */
  has(id: string): boolean {
    return this.flag(id)();
  }

  /** Replaces the true set, flipping only the ids whose value changed. */
  set(ids: readonly string[]): void {
    const next = new Set(ids);
    for (const id of next) {
      if (!this.present.has(id)) this.flag(id).set(true);
    }
    for (const id of this.present) {
      if (!next.has(id)) this.flags.get(id)?.set(false);
    }
    this.present.clear();
    for (const id of next) this.present.add(id);
  }

  /** Drops every flag entry not in `keep` (a prune at the source's write). */
  retain(keep: ReadonlySet<string>): void {
    for (const [id, flag] of this.flags) {
      if (keep.has(id)) continue;
      this.flags.delete(id);
      this.present.delete(id);
      void flag;
    }
  }

  /** Diagnostic: the number of live flag signals (tests only). */
  size(): number {
    return this.flags.size;
  }

  private flag(id: string): Signal<boolean> {
    let flag = this.flags.get(id);
    if (!flag) {
      flag = signal(this.present.has(id));
      this.flags.set(id, flag);
    }
    return flag;
  }
}
```

Implementation notes:

- `signal`'s default `===` equality already skips a no-change write, so a
  `set` with the same ids wakes nothing. Do NOT pass custom `equals`.
- `retain(keep)` is the bounded-map hook scene uses after `apply` /
  `applyChangeSet`. The controller does NOT need `retain` (it has no
  scene-owned id lifecycle); skip it there.
- Keep the file under 100 code lines.

Create `src/flow/keyed-flags.test.ts` with these tests (one behaviour each,
per standards §9). Initial→flip semantics to keep in mind throughout:
an `effect` over `flags.has(id)` runs ONCE immediately (count 1) when first
attached. A `set` that does not flip `id`'s boolean does NOT re-run that
effect (default `===` equality on the boolean). A flip `false → true` or
`true → false` re-runs it exactly once (count +1). All expectations below
use absolute counts after multiple calls.

1. `"a flag reads true only after its id is set"` — `has("a")` before any
   `set` is `false`; `set(["a"])`; `has("a")` is `true`. Attach an
   `effect` over `flags.has("a")` BEFORE the first `set` so the initial
   run counts; the run counter is 1 immediately after attaching, and 2
   after the `set` (one flip).
2. `"set flips only the ids whose value changed"` — `set(["a","b"])`;
   attach readers for `"a"`, `"b"`, `"c"` (each initial run = 1).
   Call `set(["b","c"])` (a drops, b stays, c arrives).
   Expected: A +1 (true→false) → 2; B +0 (still true) → 1; C +1
   (false→true) → 2.
3. `"setting the same ids wakes no reader"` — `set(["a","b"])`; attach
   readers for `"a"` and `"b"` (initial runs = 1 each); call
   `set(["b","a"])` (same membership, different array order). Run counts
   stay at 1 each. Call `set(["a","b"])` again; counts still 1 each.
4. `"a hover moving from A to B wakes only A's and B's readers"` —
   `set(["a"])`; attach readers for `"a"`, `"b"`, `"c"` (each = 1).
   Call `set(["b"])`; expect A +1 → 2, B +1 → 2, C +0 → 1.
5. `"a repeated flip leaves an unrelated reader at its initial run count"` —
   `set(["a"])`; attach readers for A, B, C (each = 1). Sequence:
   `set(["b","c"])`; then `set(["a"])`; then `set(["b"])`. B's boolean
   goes false→true→false→true across the three calls, so B's reader
   re-runs three times (final = 4). C's reader goes false→true→false→false,
   i.e. +1, +1, +0 (final = 3). A reader ("a" stays false until the
   second set, then true until the third set where it drops): +0, +1, +1
   (final = 3). Importantly: on the final call `set(["b"])`, a reader for
   an id that was never set throughout (e.g. `"unused"`, initial = 1) must
   stay at 1 across all four calls — this is the canonical "no false→false
   wake" assertion that catches a regression where the keyed helper wakes
   every card on every canvas-wide write.
6. `"retain drops flags for ids no longer present"` — `set(["a","b","c"])`;
   `retain(new Set(["a","b"]))`; `size()` is now 2; `has("c")` reads
   `false`; re-attaching an `effect` over `has("c")` after the retain
   starts at run 1 (lazy re-creation). Effects attached BEFORE the retain
   over `has("c")` MUST NOT be woken by the deletion (the flag's boolean
   value never flips as it is removed).

Model the effect-counter pattern on `src/flow/scene.test.ts:305-325`.

**Verify**: `nsh test src/flow/keyed-flags.test.ts` → all new tests pass.
`bun run check` → exit 0.

### Step 5 (Tier 2): Mirror `selection` and `connectionTarget` in `FlowScene`

In `src/flow/scene.ts`:

1. Add two private fields:
   ```ts
   private readonly selectedFlags = new KeyedFlags();
   private readonly targetFlags = new KeyedFlags();
   ```
2. Add public readers that components call:
   ```ts
   /** `id`'s selection flag; wakes only when that card's membership flips. */
   isSelectedKeyed(id: string): boolean {
     return this.selectedFlags.has(id);
   }
   /** `id`'s connection-target flag. */
   isConnectionTarget(id: string): boolean {
     return this.targetFlags.has(id);
   }
   ```
3. At the END of `select(ids)` (inside the `batch` 002 added), call
   `this.selectedFlags.set(next)` — `next` is the local filtered array the
   method already builds. The existing early return when `next` is
   element-wise equal to the current selection (line 186) means `set` runs
   only on a real change; the helper would no-op anyway.
4. Inside `setConnectionTarget(id)` (line 420), after the guard, replace the
   bare `this.connectionTarget.set(id)` with:
   ```ts
   this.connectionTarget.set(id);
   this.targetFlags.set(id === null ? [] : [id]);
   ```
   `setConnectionTarget` runs inside whichever controller entry point is
   calling it — 002 batches that entry point — so the two writes share one
   round.
5. At the end of `prune()` (still inside the caller's batch), bound the
   maps:
   ```ts
   const live = new Set(this.byId.keys());
   this.selectedFlags.retain(live);
   this.targetFlags.retain(live);
   ```
   `prune()` is called from `apply` and `applyChangeSet` only, both batched
   by 002.
6. Keep `selection` and `connectionTarget` as the source of truth; the
   existing `isSelected(id)` from tier 1 stays for the controller's logic
   and any code that doesn't need the keyed flag.

In `src/components/FlowCanvas.tsx`, switch the two props:

- `selected={() => props.scene.isSelectedKeyed(id)}`
- `target={() => props.scene.isConnectionTarget(id)}`

`plusSuppressed` keeps `multiFrame() && props.scene.isSelected(id)` — the
multi-frame branch uses the ranks-map form because it must also observe the
selection's size; the selected flag alone is insufficient there.

Add tests in `src/flow/scene.test.ts`:

1. `"selecting flips only the newly selected cards' keyed flags"` — apply
   `[a,b,c]`; attach effects over `isSelectedKeyed` for each; `select(["a","b"])`;
   A and B run +1, C 0. `select(["b"])`; A +1, B 0, C 0.
2. `"the connection target flag follows setConnectionTarget"` — apply
   `[a,b]`; effects over `isConnectionTarget("a")` and `("b")`;
   `setConnectionTarget("a")`; then `setConnectionTarget("b")`; then
   `setConnectionTarget(null)`; check +1 per real flip per side.
3. `"a change set that removes a card drops its keyed flags"` — after
   `applyChangeSet({ removed: ["a"], ... })`, `isSelectedKeyed("a")` is
   false and no reader of a still-present card's flag ran.

**Verify**: `nsh test src/flow/scene.test.ts` → all pass, including the new
ones. `bun run check` → exit 0.

### Step 6 (Tier 2): Mirror `hovered` and `marqueePreview` in `CanvasController`

`src/flow/canvas-controller.ts` is near the 500-line cap, so put the mirror
logic in a small new module beside it:

Create `src/flow/hover-flags.ts`:

```ts
/**
 * The keyed mirrors of the controller's hover and marquee preview. Kept out
 * of canvas-controller.ts because that module is at the max-lines cap; the
 * controller writes through this helper inside its batched entry points.
 */
import { KeyedFlags } from "./keyed-flags";

export class HoverFlags {
  private readonly hoveredFlags = new KeyedFlags();
  private readonly previewFlags = new KeyedFlags();

  isHovered(id: string): boolean {
    return this.hoveredFlags.has(id);
  }

  isPreviewed(id: string): boolean {
    return this.previewFlags.has(id);
  }

  setHovered(id: string | null): void {
    this.hoveredFlags.set(id === null ? [] : [id]);
  }

  setPreviewed(ids: ReadonlySet<string>): void {
    this.previewFlags.set([...ids]);
  }
}
```

In `src/flow/canvas-controller.ts`:

1. Add `readonly flags = new HoverFlags();` next to the `right` field.
   (Public: `FlowCanvas` reads it.)
2. Everywhere the code calls `this.hovered.set(...)`, follow immediately
   with `this.flags.setHovered(sameId)`. The call sites are `leave()` and
   the several branches inside `hover()`. Keep them adjacent so a future
   reader sees the pair as one write.
3. Everywhere the code calls `this.marqueePreview.set(...)`, follow with
   `this.flags.setPreviewed(sameSet)`. That is `setPreview` (line 552) and
   `clearPreview` (line 558). The `hovered.set(null)` writes in `down` and
   `cancel` also mirror to `setHovered(null)`.
4. The mirror calls happen INSIDE the same method body — and, per 002,
   inside the same `batch` — as the source write. NEVER write the mirror
   from an `effect`: standards §6.2 forbids an effect that writes a signal,
   and an effect-driven mirror would glitch for one round (the exact plus
   flash this plan exists to remove).
5. No `retain` call here: hover/preview flags are bounded by the scene's
   visible ids, and `has(id)` lazily creates a signal on read. The map
   grows only as the user hovers cards. If a reviewer flags unbounded
   growth, STOP and report rather than adding lifecycle logic — the scene
   owns id lifetimes.

In `src/components/FlowCanvas.tsx`:

- `hovered={() => props.controller.flags.isHovered(id)}`
- `previewed={() => props.controller.flags.isPreviewed(id)}`

Add tests in `src/flow/canvas-controller.test.ts`, using the existing
`setup()` (lines 45-92):

1. `"hovering a card flips only that card's flag"` — setup with two cards;
   `controller.hover(x, y)` over card A; effects over
   `controller.flags.isHovered("a")` and `("b")`; then hover over B;
   assert A and B flipped once each, and a third card's reader did not run.
2. `"a marquee preview flips only the covered cards' flags"` — drag a
   marquee that covers A and B but not C; assert `isPreviewed` for A and B
   true, C false; after `up`, both preview flags return to false.
3. `"clearing the preview wakes only the cards that left it"` — effects on
   `isPreviewed` for A, B, C; `setPreview` with [a,b]; `clearPreview`;
   assert +1 for A and B on each transition, 0 for C throughout.

**Verify**: `nsh test src/flow/canvas-controller.test.ts` → all pass.
`bun run check` → exit 0; in particular the `max-lines` rule on
`src/flow/canvas-controller.ts` MUST hold — after 002's resize-handles
extraction and the hover-flags additions in this step, the controller
MUST still be ≤ 500 code lines (the cap). If it crosses, STOP per the
STOP conditions below; do NOT compress unrelated code.
`bun run test` → all pass, especially every App test that asserts a
plus appears or a marquee previews cards.

### Step 7: Docs, changelog and index

1. `docs/standards.md` §6.2 (after the "derive values; never mirror" rule
   near line 234): add one sentence — "Canvas-wide state MAY keep a keyed
   per-id mirror (`flow/keyed-flags.ts`) for view bindings; the mirror MUST
   be written in the same method and `batch` as the source signal, NEVER
   from an effect."
2. `docs/testing.md` Unit row of the levels table: add
   `flow/keyed-flags.test.ts` and `flow/hover-flags.test.ts` if you added
   tests for `hover-flags.ts` separately (otherwise the controller tests
   cover it — mention that in the PR description instead).
3. `docs/architecture.md`: if the flow module list enumerates modules, add
   `keyed-flags.ts` and `hover-flags.ts` with one clause each.
4. `CHANGELOG.md` under `## [Unreleased]` → `### Changed`, one bullet:
   "A canvas-wide selection, hover, marquee preview or connection-target
   change now wakes only the cards whose state flipped: the card's plus
   buttons render through `<If>`, its border class list reads memoized
   values, and keyed per-card flags (`flow/keyed-flags.ts`) replace the
   per-card `selection().includes(id)` scan. Measured on a 2,000-card board
   a hover change costs ~0.1 ms of JS instead of ~10 ms."

**Verify**: `./node_modules/.bin/vp fmt --check docs CHANGELOG.md` → "All
matched files use the correct format." `bun run check` → exit 0.

**Commit tier 2** (subject above).

### Step 8 (manual evidence, not an automated gate)

Run traces of two box-selection-producing App tests before and after this
branch lands. The existing `src/App.test.tsx` tests that produce a
box-selection-release drag (a marquee that finishes with a selection,
which is what this plan equals) are:

- `"pans right with the right arrow"` and its siblings `"pans left with the
  left arrow"`, `"pans up with the up arrow"`, `"pans down with the down
  arrow"` — each of these tests drives a `dragAndHold` then a release
  (`expectArrowPan` performs a press-drag-release whose intent is to pan;
  on the select tool the same gesture becomes a box-selection).
- `"clears the selection with Escape"` — also begins with a
  `selectSeed(...)` pattern that drives a box-select in some variants.

Pick the test `"pans right with the right arrow"` as the canonical probe;
use `"clears the selection with Escape"` as a secondary probe.

Each trace:

```sh
nsh test src/App.test.tsx --filter "pans right with the right arrow" --trace
```

Capture the per-step output. In the parsed step list, find the step
matching the drag-release (it will be named after the test framework's
drag/mouseup action). That step is the **selection-producing box-release
drag** — the gesture whose selection flip this plan isolates to the cards
whose flag changed.

Record in the commit body (and the optional PR description):

- Step name of the box-release drag (e.g. the step emitted by the test
  harness's mouseup).
- Its `mount_items` value BEFORE (on `main`) and AFTER (on this branch).
  The direction must be DROP on `main → branch`. State the direction only,
  not the numbers; the advisor's original numbers were measured on a
  synthetic board, and absolute counts depend on the test fixture.
- The same comparison for the secondary probe test.

Keep this as a manual comparison. Frame budgets MUST NOT be asserted in CI
(standards §8.2). The trace is evidence for the commit body, not an
automated gate.

## Test plan

New tests (each named in the step that adds them):

- `src/flow/keyed-flags.test.ts` — 6 tests covering flip-only-changed,
  no-change-no-wake, A→B hover, repeated-flip isolation for an unrelated
  reader (the canonical "no false→false wake" guard), and `retain`.
- `src/flow/scene.test.ts` — 2 `isSelected` correctness tests (tier 1), 3
  keyed-flag tests (tier 2): selection flip isolation, connection-target
  flip isolation, removal pruning.
- `src/flow/canvas-controller.test.ts` — 3 tests: hover flag isolation,
  marquee-preview flag coverage, preview-clearing isolation.

Existing tests to copy structurally:

- Effect-run counting: `src/flow/scene.test.ts:305-325` ("a drag's overrides
  notify only the cards it moves").
- Memo/wake counting: `src/flow/card-geometry.test.ts:33-45` (`wakes()`).
- Controller fixture: `src/flow/canvas-controller.test.ts:45-92` (`setup()`).

Regression requirement: the tier-2 tests must FAIL on `main` (the flags do
not exist there) and PASS after the plan lands. `bun run test` is the
gate; the full App suite must stay green with no assertion rewrites —
App tests assert behaviour, and this plan must not change behaviour.

**Verify**: `bun run test` → all pass, N new tests (11 total across the
three files — 6 KeyedFlags tests in `keyed-flags.test.ts`, 2 tier-1
`isSelected` + 3 tier-2 keyed-flag scene tests, 3 controller hover-flag
tests; the numbers do not include the optional separate
`hover-flags.test.ts` file).

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0 with zero warnings; the `max-lines` rule
      passes for `src/flow/canvas-controller.ts` (≤ 500 code lines) after
      both 002's resize-handles extraction and this plan's hover-flags
      mirror.
- [ ] `bun run test` exits 0; the new tests listed above exist and pass.
- [ ] `! grep -n "showPlus() ? <PortPlus" src/components/FlowCard.tsx`
      succeeds (the ternary form is gone).
- [ ] `! grep -n "selection().includes(id)" src/components/FlowCanvas.tsx`
      succeeds.
- [ ] `! grep -n "marqueePreview().has(id)" src/components/FlowCanvas.tsx`
      succeeds.
- [ ] `! grep -n "controller.hovered() === id" src/components/FlowCanvas.tsx`
      succeeds.
- [ ] `grep -n "const active = computed" src/components/FlowCard.tsx` shows
      the memoized value.
- [ ] `grep -rn "new KeyedFlags" src/flow/` shows the scene and hover-flags
      uses only (no other module mirrors state through it).
- [ ] `grep -n "flags.set" src/flow/canvas-controller.ts` places every
      mirror call adjacent to its source write (same method, same batch).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] The trace comparison in step 8 is recorded in the commit body.
- [ ] `plans/README.md` status row (this plan only) updated and formatted;
      the rest of the index is the advisor's.

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -n "batch(" src/flow/scene.ts src/flow/canvas-controller.ts` shows
  no matches — plan 002 has not landed.
- `src/flow/resize-handles.ts` does not exist, or
  `grep -n "function handleAtPoint\|function cursorFor" src/flow/canvas-controller.ts`
  still finds the implementations in the controller — plan 002 step 3b has
  not landed and the controller has no headroom for the hover-flags mirror.
- A current-state excerpt does not match the live code in a way plan 002's
  changes (including the resize-handles extraction) do not explain.
- Tier 2 appears to require writing a flag from an `effect` (e.g. because
  the source signal is written somewhere you cannot reach). Do not add an
  effect-driven mirror: standards §6.2 forbids it and it glitches for one
  round, flashing the plus buttons — the exact bug class this plan removes.
- An App test starts failing with a plus-flashing or selection-visibility
  assertion change (count/visibility of pluses, marquee previews or the
  connection highlight) after a step. This is behaviour regression, not a
  cosmetic diff — stop and report rather than relaxing the test.
- Writing `this.flags.setHovered(...)` adjacent to every `hovered.set(...)`
  requires touching `right-gesture.ts` or `edge-gestures.ts` (both out of
  scope). Report which call site is outside the controller.
- `src/flow/canvas-controller.ts` would cross the 500-code-line cap despite
  the `hover-flags.ts` extraction. Do not compress unrelated code to fit.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- `FlowScene.select` and `setConnectionTarget` are now dual-write points:
  any future writer of `selection` or `connectionTarget` MUST go through
  these methods (or call `selectedFlags.set` / `targetFlags.set` itself in
  the same batch). A direct `this.selection.set(...)` outside `select` is a
  bug waiting to be written. Same for `hovered`/`marqueePreview` and their
  `HoverFlags` mirrors in the controller.
- Plan 007 ("reads wake only changes") later replaces `prune()`'s
  unconditional `nodes.set([...])` with identity-preserving writes and
  adds per-card rect signals. The `retain(live)` calls here must be kept
  inside whatever batch 007 keeps at the end of `apply`/`applyChangeSet`;
  007's author should re-check the flag pruning after their change.
- Plan 006 adds a `gestureMoved` signal on the controller. It does NOT need
  a keyed mirror: it is a boolean read by the page, not per-card.
- Plan 008 adds a `Set` inside `idsWithin`; that is independent of the
  per-card preview flags.
- If a future change adds a new canvas-wide signal that cards read
  (e.g. a selection-mode badge), default to adding a keyed mirror for it
  rather than another `.has(id)` closure over the canvas-wide value.
- `KeyedFlags.size()` is a test/diagnostic accessor. Do not surface it in
  production UI.
- Deferred: a structural `createSelector`-style primitive in NSH itself
  would make this helper unnecessary. If NSH grows one, this module is the
  migration point.
