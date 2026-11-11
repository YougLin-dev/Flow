# Plan 014: Cut per-card paint work on large boards with a childless plate, detail tiers and whole-point sizes

> **Status note (2026-11-11)**: the zoom-gated detail tiers were reverted at
> the user's request: cards keep their title, status, body and preview at every
> zoom. The childless plate, whole-point sizes and the renderer's paint elision
> remain.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1956ebb..HEAD -- src/components/FlowCard.tsx src/components/FlowCanvas.tsx src/flow/selection.ts src/flow/selection.test.ts src/flow/card-detail.ts src/flow/card-detail.test.ts src/flow/card-geometry.test.ts src/flow/scene.test.ts src/flow/canvas-controller.ts docs/testing.md docs/standards.md docs/architecture.md CHANGELOG.md plans/README.md`
> `src/flow/selection.ts` and `docs/standards.md` are in scope in this plan.
> `src/flow/card-geometry.test.ts`, `scene.test.ts`, and
> `canvas-controller.ts` are **read-only drift/dependency checks** (their
> scoped-file exceptions below permit tests only where named); do not make a
> normal implementation edit to them. `plans/README.md` is maintained by the
> advisor; the executor updates its status row only when explicitly delegated.
>
> This plan depends on **005-card-bindings** (FlowCard/FlowCanvas order),
> **002-batch-scene-writes** (transitively via 005), and
> **009-bench-coverage** (for the measurement baseline; code work does not
> depend on it). Confirm rows for 005 and 009 are DONE in
> `plans/README.md`. Also confirm **004-comet-native-loop** is DONE: it adds
> a `paused` prop to `FlowEdges` inside `FlowCanvas.tsx`, and this plan
> edits the same component. Changes made by 002/004/005 are expected;
> compare only the excerpts this plan edits. A mismatch NOT explained by a
> dependency plan is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/004-comet-native-loop.md, plans/005-card-bindings.md,
  plans/009-bench-coverage.md (index row `004, 005, 009`; 002 is transitively
  required via 005). 004 supplies the required `FlowEdges paused=` prop; its
  native-camera motion is not an optional extra.
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `300227c`, 2026-11-11 — plans 004, 005 and 009
  landed. The dependency quick checks below pass; `FlowCard.tsx`,
  `FlowCanvas.tsx`, `selection.ts` and the viewport budget moved by only a few
  lines, updated below. All current `selection.test.ts` resize cases use
  integer inputs and expectations and must stay unchanged; the new fractional
  cases are the only rounding proof.
- **Re-reconciled at**: commit `4f2b23b`, 2026-11-11 — plan 013 added the
  `imageEvent` hook and its `onLoad`/`onError` callbacks to the preview
  `<Image>`; the line references below reflect that. The tier gating composes
  with the hook: gate the whole image subtree, handlers included.
- **Execution note (2026-11-11)**: implemented on
  `advisor/014-card-paint-scale` as `62760cb` (plate), `e39c7ee` (tiers),
  `6b6249e` (whole-point resize) and `69a1146` (docs), based on `4f2b23b`.
  Gates: `bun run check`, `bun run test` (373 tests) and `bun run test:host`
  (12 tests) pass. Accepted deviation: the body content now sits one
  **device** pixel closer to the card's top-left because the removed border
  used to inset its absolute children; all decoration (corners, border,
  shadow, accent, title row) is pixel-identical at 100%. Compensating with a
  transparent border or a fractional inset was rejected because it would
  reintroduce per-card paint or blur text at other DPI scales. The plan's
  prose had also said shadows stop below 20% while the matrix and code stop
  them below 35%; the module comments, CHANGELOG and architecture text were
  corrected to the matrix. Host measurement used the real Windows test host
  (`nsh test src/App.tsx --target windows --fps -v`) rather than an
  interactive release dev app, against one copied 100k DB: at 21% zoom the
  steady paint mean fell from about 39.2 ms to 28.5 ms, and full-tier paint
  stayed about 3.0 ms; 92% was the nearest reachable full-tier sample because
  the zoom control jumps from 92% to 111%. Screenshots and logs are under
  `C:\Users\Y\AppData\Local\Temp\claude\E--code-mine-oflow\measurements`.

## Why this matters

On Windows, NSH's partial-frame renderer skips a view outside the damage
rect only if it `clips` or has **no children**
(`nsh-pr/crates/nsh-platform-windows/src/render.rs:734-741`; children are
culled against the visible area only inside a clipping parent,
`render.rs:955-976`). `FlowCard`'s decorated body
(`src/components/FlowCard.tsx:169-183` — `rounded-2xl border bg-card
shadow-lg`, with children) is therefore re-drawn on **every** partial frame
whose damage rect intersects it: two shadow bitmaps + fill + border + a
rounded-rect geometry allocation per card
(`nsh-pr/crates/nsh-platform-windows/src/decor.rs`). While the comet or a
spring runs, that is every visible card, every frame.

Two further multipliers:

- `FlowCard` never sees the camera scale, so at the 300/800-card zoom-out
  budgets (`src/flow/viewport-controller.ts:96`) every card still draws
  both shadows and up to 600 characters of body text at 2-6 px per glyph.
- `resizedRect` (`src/flow/selection.ts:77-129`) returns fractional
  width/height during a resize (especially the corner/aspect path at
  lines 100-106). Shadow bitmaps are keyed by **exact** box width/height
  (`nsh-pr/crates/nsh-platform-windows/src/decor.rs:443-465`), so a
  fractional resize bakes two new blurred bitmaps per painted frame.

This plan (a) moves the decoration into a childless absolute plate so the
renderer can skip it when it is outside the damage; (b) adds three named
detail tiers driven by camera scale so a low-zoom card drops its shadows
and text below readable sizes; (c) rounds a resized rect's width/height to
whole points so consecutive frames share shadow bakes.

## Current state

After the dependency plans:

- 005 has replaced `FlowCard`'s plus and "No output yet" ternaries with
  `<If>` blocks and turned `active`/`showPlus` into `computed`s.
  Quick check:
  `grep -n "const active = computed\\|<If when={showPlus()}" src/components/FlowCard.tsx`
  shows matches. If not, STOP: 005 has not landed.
- 004 has given `FlowEdges` a `paused` prop wired in `FlowCanvas.tsx`.
  Quick check: `grep -n "paused=" src/components/FlowCanvas.tsx` shows a
  match. If not, STOP.
- 002 has batched the scene/controller writers.
  Quick check: `grep -n "batch(" src/flow/scene.ts` shows matches.
- 009's benchmark timings exist in `docs/plans/rust-core.md`; this plan's
  step 7 records before/after numbers using the same recipe. Code work
  does not depend on 009, only the measurement step.

### Relevant files at HEAD 1956ebb

- `src/components/FlowCard.tsx` — the card body container at lines 169-265;
  the accent bar at 121-126; title + status at 107-167.
- `src/components/FlowCanvas.tsx` — the world view transform at lines
  259-271; `<Each>` over `scene.nodes()` at 283-313.
- `src/components/PortPlus.tsx` — exemplar of a childless background view
  (lines 64-81: a positioned container plus a childless
  `absolute rounded-full border border-border` background sibling).
- `src/flow/selection.ts` — `resizedRect` at 77-131 (the corner/aspect path
  at 87-107 and the edge path at 109-130).
- `src/flow/camera.ts` — `MIN_SCALE = 0.05`, `MAX_SCALE = 2.5`;
  `CanvasCamera.view` is a single signal at line 69.
- `src/flow/viewport-controller.ts` — zoom budgets at line 96
  (`scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2000`).
- `src/flow/selection.test.ts` — 95 lines covering `resizedRect`; every
  current resize case uses integer inputs and expectations, so rounding must
  leave all of them unchanged. The new fractional cases carry the proof.
- `src/flow/card-geometry.ts` — the equality-gated class idiom this plan's
  `card-detail.ts` follows.

### Excerpts (at 1956ebb; 005/004 changes are local to plus bindings and FlowEdges)

`src/components/FlowCard.tsx:169-183` — the decorated body:

```tsx
<View
  accessibilityLabel={content.title()}
  classList={{
    "absolute rounded-2xl border bg-card shadow-lg": true,
    "border-chart-1": active(),
    "border-border": !active(),
  }}
  style={{
    position: "absolute",
    left: layout().body.x,
    top: layout().body.y,
    width: layout().body.width,
    height: layout().body.height,
  }}
>
  {content.image() ? (
    /* image body ... */
```

`src/components/FlowCard.tsx:121-126` — the accent bar (childless):

```tsx
<View
  classList={{
    "absolute left-0 top-[3px] h-3.5 w-1 rounded-full": true,
    [ACCENT_BG[accent()]]: true,
  }}
/>
```

`src/components/FlowCanvas.tsx:259-271` — the world view:

```tsx
<View
  style={{
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    overflow: "visible",
    pointerEvents: "none",
    transformOrigin: "0 0",
    transform: `translate(${props.camera.x}px, ${props.camera.y}px) scale(${props.camera.scale})`,
  }}
>
```

`src/flow/selection.ts:100-106` — the corner's fractional geometry:

```ts
const width = Math.max(1, start.width * effective);
const height = Math.max(1, start.height * effective);
return {
  x: west ? start.x + start.width - width : start.x,
  y: north ? start.y + start.height - height : start.y,
  width,
  height,
};
```

### NSH facts that drive the design

- A view's decoration paints per partial frame when it has children
  (`nsh-pr/crates/nsh-platform-windows/src/render.rs:734-741`). Childless
  views (a `View` with no children) are skipped when outside the damage
  rect. So the plate must have no children and be a sibling of the card's
  content, not a parent.
- Shadow bitmaps are cached by (box width, box height, radii, spec, DPI
  scale) at `decor.rs:443-465`; equal w/h share the cached bitmap.
- `computed(fn, options?)` accepts `equals?: false | ((previous, next) => boolean)`
  (`src/.nsh/types/nsh/index.d.ts:18-21, 571`). The detail tier computed
  uses default `===` on the string-union result so a continuous zoom wakes
  the card only on a tier flip, not on every wheel tick.
- `CanvasCamera` is constructed inside the `FlowPage` component body
  (`src/pages/FlowPage.tsx:56`). A `computed` created inside `FlowCanvas`
  (also a component body) is owned by that component's reactive owner and
  is disposed with the canvas — there is no unowned-memo trap here. The
  same is true for the per-card `computed`s already created inside
  `FlowCard`.
- `reduceMotion` is not relevant to this plan; no new animation is added.
- Standards §8.2 (`docs/standards.md:379-388`): per-frame work MUST be
  proportional to visible cards; frame budgets are SHOULD targets measured
  manually on the reference host and MUST NOT be asserted in CI.

### Repo rules that apply

- §6.2: a component body is one-time setup; derived values MUST use
  `computed`; props are read in bindings, never destructured in the body.
- §6.3 (lines 246-258): colors, radii and shadows MUST come from semantic
  tokens; no raw hex/rgba; the plan adds no new token (the tiers only
  remove paint work, not change palette).
- §4 (line 135): one job per module, kebab-case. `card-detail.ts` is new.
- §5: no `any`, no `as` narrowing, no `!`. The tier is a string-union
  `type`, not an unsafe cast.
- §13 "New canvas feature" (645-650): pure helpers in `src/flow/` with unit
  tests; the view in `src/components/`.
- §9 (`docs/standards.md:470-474`): a deterministically reproducible change
  adds a regression test that fails before and passes after. Whole-point
  rounding is reproducible — the resize test must assert integers.
- §11 review checklist (line 541): reviewers falsify at "a 1 by 1 resize",
  "minimum and maximum zoom" and "light and dark" — the host screenshot
  review covers these.

## Commands you will need

| Purpose                            | Command                                 | Expected on success                         |
| ---------------------------------- | --------------------------------------- | ------------------------------------------- |
| Full gate                          | `bun run check`                         | exit 0                                      |
| All tests                          | `bun run test`                          | exit 0, all pass                            |
| One test file                      | `nsh test src/flow/selection.test.ts`   | all pass                                    |
| New unit file                      | `nsh test src/flow/card-detail.test.ts` | all pass                                    |
| Host tests on this machine         | `bun run test:host`                     | exit 0                                      |
| Real-host 100k smoke (screenshots) | `bun run test:100k`                     | exit 0; writes `.nsh/bench/flow-100k-*.png` |
| App run with perf overlay          | `bun run dev -- --fps -v`               | window opens; `nsh::fps` lines each second  |
| Apply safe formatting              | `bun run check:fix`                     | exit 0                                      |

## Scope

**In scope** (the only files you should modify):

- `src/components/FlowCard.tsx`
- `src/components/FlowCanvas.tsx`
- `src/flow/card-detail.ts` (create)
- `src/flow/card-detail.test.ts` (create)
- `src/flow/selection.ts` (only inside `resizedRect`)
- `src/flow/selection.test.ts`
- `src/flow/scene.test.ts` (only if a same-rect tolerance assumption breaks; prefer not to touch)
- `docs/standards.md` (one sentence in §8.2 about detail tiers)
- `docs/testing.md` (Unit row: add `flow/card-detail.test.ts`)
- `docs/architecture.md` (flow module list: add `card-detail.ts`)
- `CHANGELOG.md` (bullets under `## [Unreleased]` → `### Changed`)

**Out of scope** (do NOT touch, even though they look related):

- `src/flow/camera.ts` — the camera's logical view storage is fine; this
  plan reads it, never changes it.
- `src/flow/viewport-controller.ts` — the 300/800/2000 budgets stay; the
  detail tiers live in the view layer and are independent of them.
- `src/pages/FlowPage.tsx` — no wiring changes needed.
- `src/components/FlowEdges.tsx`, `SelectionFrame.tsx`,
  `SelectionPluses.tsx`, `SelectionOverlay.tsx` — owned by other plans.
- `src/native/` — no Rust changes. In particular do NOT chase the
  platform-side paint fix here; that is plans 017/018 (nsh-pr).
- `src/theme.json` — no new tokens; the tiers drop existing classes, not
  replace colors.
- `src/components/PortPlus.tsx` — it is already the exemplar for the
  childless-plate pattern; don't change it.

## Git workflow

- Branch from `main`: `git switch -c advisor/014-card-paint-scale`.
- Commit per logical step; Conventional Commits, lower-case imperative
  subject, explanatory body. Suggested:
  - Step 1-2: `perf: draw a card's decoration as a childless plate`
  - Step 3-4: `perf: render low-zoom cards in named detail tiers`
  - Step 5: `perf: round a resized card to whole points`
  - Step 6-7 (docs/changelog may be folded into the relevant step commits).
- NEVER add AI attribution (no `Co-Authored-By:` AI trailer, no
  "Generated with..." line).
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Extract the decoration into a childless plate in `FlowCard`

In `src/components/FlowCard.tsx`, replace the body container's decoration
with a sibling plate. Target shape:

```tsx
{/* The body container carries only the geometry and the accessible name;
    the decoration lives in a childless absolute plate so the Windows
    renderer can skip its paint when it is outside the damage rect
    (nsh-platform-windows render.rs skips childless views only). */}
<View
  accessibilityLabel={content.title()}
  style={{
    position: "absolute",
    left: layout().body.x,
    top: layout().body.y,
    width: layout().body.width,
    height: layout().body.height,
  }}
>
  <View
    classList={{
      "absolute left-0 top-0 h-full w-full rounded-2xl border bg-card shadow-lg": true,
      "border-chart-1": active(),
      "border-border": !active(),
    }}
  />
  {content.image() ? (
    /* unchanged image body, now a sibling of the plate */
  ) : /* unchanged text body */}
</View>
```

Requirements:

- The plate MUST be childless: no `<Text>`, no nested `<View>`. It is a
  pure decorative surface (background, border, shadow, rounded corners).
- The plate is the FIRST child of the body container so it paints under
  the content siblings that follow it.
- Keep `accessibilityLabel` on the body container (the parent), not on the
  plate — the plate is decorative.
- Keep the body container's `position: "absolute"` and the existing
  `layout().body.*` style binding. Do NOT move the `active()` class list
  onto the container.
- Do NOT add `overflow: "hidden"` to the container: that would force the
  renderer's clipping path and undo the childless-view skip.
- After 005, `active` is already a `computed`. Do not change it.

**Verify**: `bun run check` → exit 0. `bun run test` → all pass (App tests
assert plus presence, selection borders via class lists read in bindings,
and card geometry through the scene; none assert the view hierarchy).

Manual host eyeball (not a gate but note it for the PR): open
`bun run dev`, confirm the card looks identical at 100% zoom — rounded
corners, accent border on selection, shadow under the body, title row
above it.

### Step 2: Run the host tests after the plate change

The plate changes the native view tree, so the host-specific rendering
path is exercised.

**Verify**: `bun run test:host` → exit 0. If a host test asserts a paint
shape and now fails because the decoration moved, STOP: this is the
plate-changes-appearance condition.

Commit step 1-2 (subject above) before moving on.

### Step 3: Create `src/flow/card-detail.ts`

Create the module with three exported constants and one pure mapping
function:

```ts
/**
 * The detail a card draws at a camera scale. Below the readability of its
 * text the card drops that text and its shadow rather than painting
 * sub-pixel glyphs; below the readability of its shape it drops its title
 * and previews too. The tiers are named so the view binds on the tier, not
 * on the scale: a continuous zoom wakes the card only on a tier change.
 */

export type CardDetail = "full" | "reduced" | "minimal";

/** Below this scale the card's shadow, body text and status text stop painting. */
export const DETAIL_REDUCED_BELOW = 0.35;
/** Below this scale the title and image previews stop too. */
export const DETAIL_MINIMAL_BELOW = 0.2;

/** The detail tier for `scale`, given the camera's logical scale. */
export function cardDetailAt(scale: number): CardDetail {
  if (!Number.isFinite(scale)) return "full";
  if (scale < DETAIL_MINIMAL_BELOW) return "minimal";
  if (scale < DETAIL_REDUCED_BELOW) return "reduced";
  return "full";
}
```

Notes:

- Thresholds are the named constants above; tests assert them and the
  maintainer reviews screenshots in step 7.
- The mapping is a pure function of scale; it does NOT read the scene,
  store or platform. Tier thresholds align loosely with
  `viewport-controller.ts`'s card budgets (0.15/0.4) but are deliberately
  independent — the budgets cap visible cards, the tiers cap paint work.
- `reduceMotion()` is irrelevant here; this is not animation.

Create `src/flow/card-detail.test.ts`:

1. `"full detail at and above 0.35"`: `cardDetailAt(1) === "full"`,
   `cardDetailAt(0.35) === "full"`, `cardDetailAt(2.5) === "full"`.
2. `"reduced detail between 0.2 and 0.35"`:
   `cardDetailAt(0.34) === "reduced"`, `cardDetailAt(0.2) === "reduced"`.
3. `"minimal detail below 0.2"`: `cardDetailAt(0.19) === "minimal"`,
   `cardDetailAt(0.05) === "minimal"` (the camera's MIN_SCALE).
4. `"a non-finite scale falls back to full"`:
   `cardDetailAt(Number.NaN) === "full"`,
   `cardDetailAt(Number.POSITIVE_INFINITY) === "full"` — a non-finite scale
   must never blank cards.
5. `"the tiers are strictly ordered at the boundaries"`:
   `cardDetailAt(0.349999) === "reduced"`,
   `cardDetailAt(0.199999) === "minimal"` — pin the boundary behaviour so
   tuning the constants cannot silently change a tier.

**Verify**: `nsh test src/flow/card-detail.test.ts` → all 5 pass.
`bun run check` → exit 0.

### Step 4: Wire the tier through `FlowCanvas` and use `<If>` in `FlowCard`

In `src/components/FlowCanvas.tsx`:

1. Import `computed` from `"nsh"` (add to the existing import list) and
   `cardDetailAt`, `type CardDetail` from `"../flow/card-detail"`.
2. At the top of the `FlowCanvas` component body, before the return:
   ```ts
   const detail = computed(() => cardDetailAt(props.camera.scale));
   ```
   `computed`'s default `===` equality on the string union means a
   continuous wheel/pinch zoom re-runs the inner read but only wakes
   downstream readers when the tier flips.
3. In `FlowCardProps` (`src/components/FlowCard.tsx`), add:
   ```ts
   /** The detail tier this card draws at, driven by the camera scale. */
   readonly detail: () => CardDetail;
   ```
   Import `type CardDetail` in `FlowCard.tsx`.
4. In the `<Each>` over `scene.nodes()` in `FlowCanvas.tsx`, pass
   `detail={detail}` to `<FlowCard>`.

In `src/components/FlowCard.tsx`, gate the tier-dependent subtrees with
`<If>` (a global, no import). The decision matrix:

| Tier                 | Plate (bg + border) | Accent bar | Title text | Status dot + text | Body text / image previews | Shadows |
| -------------------- | ------------------- | ---------- | ---------- | ----------------- | -------------------------- | ------- |
| `full` (≥0.35)       | yes                 | yes        | yes        | yes               | yes                        | yes     |
| `reduced` (0.2-0.35) | yes                 | yes        | yes        | no                | no                         | no      |
| `minimal` (<0.2)     | yes                 | yes        | no         | no                | no                         | no      |

Concretely:

1. The plate's `classList` adds `"shadow-lg": props.detail() === "full"`
   alongside the existing entries (the `shadow-lg` class leaves the
   unconditional list; only the full tier adds it).
2. Wrap the title `<Text>` (lines 127-140) in
   `<If when={props.detail() !== "minimal"}>…</If>`.
3. Wrap BOTH status views (the dot at lines 141-151 and the status text at
   lines 152-166) in ONE `<If when={props.detail() === "full"}>…</If>`
   container block (or two separate `<If>`s if NSH needs single roots —
   follow the surrounding code style; `<If>` accepts any JSX.Element
   children).
4. The image body's `View` entire subtree (lines 184-236) — its preview URL
   `<Each>` plus the inherited 005 `"No output yet"` text placeholder — is in
   **one** `<If when={props.detail() === "full"}>` region. The image container may
   remain mounted at reduced/minimal (geometry is not text), but it is empty
   there: no preview images, placeholders or textual body below full. Both
   the Each and placeholder are covered, not just `<Image>` nodes reduced.
5. Wrap the text body's `<Text>` blocks (lines 239-262, including the
   "No output yet" `<If>` introduced by 005) in
   `<If when={props.detail() === "full"}>`. Reduced/minimal cards show no body text.
   **Do not rewrite 005's body ternary here**; only place tier `<If>` around
   whatever existing kind/title/body blocks plus 005 already wired. If this
   refactor requires a change to the body structure, STOP then apply exactly
   this target: keep the outer `content.image() ? ... : ...`; in its text
   branch only use `body() !== "" ? <Text ...>{truncate(body(),600)}</Text>
   : <If when={body() === ""}><Text ...>No output yet</Text></If>`.
   That redundant empty/else condition is intentional: NSH `<If>` retains
   same-kind mounts instead of collapsing a two-way ternary's identity.
   014's paragraphs never change that shape on their own; 005 owns its form.
6. The accent bar (lines 121-126) stays in all tiers: it is the only
   shape-level hint that distinguishes card families at very low zoom.

Result: at `reduced` the card is a plate + accent bar + title; at
`minimal` it is a plate + accent bar. No new tokens, no new components.

**Verify**: `bun run check` → exit 0. `bun run test` → all pass. All App
tests run at scale 1 in headless mode, so they exercise the `full` tier
and must not observe a change.

Commit step 3-4.

### Step 5: Round the resized rect's width and height to whole points

In `src/flow/selection.ts`, inside `resizedRect` (the corner path at lines
87-107 and the edge path at 109-130), round the returned `width`/`height` to
whole points and re-derive the dependent origin from the anchored opposite
edge:

- **Corner path:** after the existing `Math.max(1, start.width * effective)`
  and `Math.max(1, start.height * effective)`, apply `Math.round` to both.
  Keep the existing origin formulas exactly (`west` uses
  `start.x + start.width - width`; `north` uses
  `start.y + start.height - height`). Rounding width and height independently
  can drift the aspect by at most half a point per axis; that is deliberate
  for the shadow-bitmap cache and must be reviewed in Step 7's visual resize
  check, not "fixed" with new corner math. A fractional `start.x`/`start.y`
  keeps a fractional origin and still anchors the opposite side exactly.
- **Edge path:** capture `const right = start.x + start.width;` and
  `const bottom = start.y + start.height;` before the branches. After the
  existing w/e/n/s adjustments, round and clamp:

  ```ts
  width = Math.max(1, minWidth, Math.round(width));
  height = Math.max(1, minHeight, Math.round(height));
  if (side === "w") x = right - width;
  if (side === "n") y = bottom - height;
  ```

  The `Math.max` order matters: `Math.round` first, then the minimum, so a
  sub-minimum drag still returns the minimum. `w`/`n` re-derive x/y from the
  immutable opposite edge, so the anchored side stays exact even when the
  origin is fractional.

Update `src/flow/selection.test.ts`. The existing cases all use integer
inputs and expectations; they must stay unchanged and green. Add these three
cases (one behaviour each):

1. `"rounds a resized card to whole points"`: start
   `{x:100, y:100, width:200, height:100}`, side `"se"`, `dx 33.4`,
   `dy 21.7`. Assert both returned width and height are integers, both are at
   least 120/80, and the origin stays `x:100, y:100`. Do not pin the corner's
   exact width/height: the aspect projection scales both axes.
2. `"rounds a west resize against the fixed right edge"`: start
   `{x:100, y:100, width:200, height:100}`, side `"w"`, `dx -20.3`, `dy 0`.
   The raw width is 220.3; assert the exact result
   `{x:80, y:100, width:220, height:100}` and `x + width === 300`. This is the
   whole-point shadow-cache proof: before the change the width is 220.3, so
   the exact expectation fails first.
3. `"rounds a north resize against the fixed bottom edge"`: start
   `{x:100, y:100, width:200, height:100.4}`, side `"n"`, `dx 0`,
   `dy -20.3`. The raw height is 120.7; assert the exact result
   `{x:100, y:79.4, width:200, height:121}` and
   `y + height === 200.4`. The fractional origin stays fractional while the
   height is an integer.

Both new edge cases comment `// west/north negative delta expands` and use
the default minimums. The existing minimum-sweep case remains green; do not
loosen it. Do not change `sameRect`, `scene.ts`, or any geometry tolerance.

**Verify**: `nsh test src/flow/selection.test.ts` → all pass, including
the 3 new tests. `bun run check` → exit 0. `bun run test` → all pass.

Commit step 5.

### Step 6: Docs and changelog

1. `docs/standards.md` §8.2 (after line 388, the frame-budget paragraph):
   add one sentence — "A card's paint detail scales with the camera
   through named tiers (`flow/card-detail.ts`); a new canvas view SHOULD
   read the tier and gate decorative or text paint on it rather than on
   the raw scale."
2. `docs/testing.md` Unit row of the levels table: add
   `flow/card-detail.test.ts`.
3. `docs/architecture.md`: if the flow module list enumerates modules,
   add `card-detail.ts` with one clause ("camera-scale → card detail
   tier").
4. `CHANGELOG.md` under `## [Unreleased]` → `### Changed`, one bullet:
   "Cards paint less on large boards: the body's rounded background,
   border and shadow live in a childless plate the Windows renderer can
   skip when it is outside the damage area; a camera-scale detail tier
   (`flow/card-detail.ts`) drops the shadow and body and status text below
   35% zoom and the title and image previews below 20%, where they are
   sub-pixel; a resized card's width and height are now whole points so
   consecutive frames share the shadow cache. The card's decoration is
   unchanged at 100% zoom."

**Verify**: `./node_modules/.bin/vp fmt --check docs CHANGELOG.md` →
"All matched files use the correct format." `bun run check` → exit 0.

### Step 7 (manual evidence, not an automated gate)

Capture before/after evidence on the real Windows host.

1. Create separate preserved before/after local worktrees under
   `C:\Users\Y\AppData\Local\Temp\claude\E--code-mine-oflow\measurements\014-base`
   and `014-after`. **Before editing** this branch, the baseline command is
   `git worktree add --detach <base> HEAD`; from an already-implemented branch
   use `git merge-base HEAD main` recorded as `<base>` instead. After logical
   implementation commits have landed use `git worktree add --detach <after>
   <final-SHA>`. Each owns its independent `.nsh/bench` and never edits the
   original dirty worktree. Run `bun install --frozen-lockfile` in both
   worktrees when root dependency linking isn't already supplied; record
   which was used. No push, PR or extra branch is needed; source changes stay
   in the original branch and later `git worktree remove <path>` cleans each
   measurement checkout only after copied evidence is external to repo.
2. Ensure 009's benchmark numbers for your machine are recorded and both
   Worktree fixture DB hash/revision match; this step adds the UI pair.
   In both worktrees run `bun run test:100k` (refreshing same-revision
   deterministic fixture as needed). Save before/after
   `.nsh/bench/flow-100k-overview.png` and `flow-100k-reveal.png` with their
   exact logs before deleting worktrees. Run targeted mounted smoke for
   `nsh test src/App.test.tsx --filter "zooms with the controls"` and
   `"fits with the keyboard"` in after; confirm each passes, and `--trace`
   output records `press(label:Zoom in)`, `press(Fit)` and
   `keypress(mod+0)` steps with per-step mount item counts. These are exact
   existing test names; selection appearance measured in `"clears the
   selection with Escape"` is another valid comparison (its box release
   step is after initial separate Hand pan; don't count that initial pan as
   the selection gesture).
3. Use REAL host for paint numbers in both worktrees against same copy of
   `.nsh/bench/flow-100k.db`, with `FLOW_DB_PATH` pointing to the **same
   immutable copied DB** outside both worktrees (start identical second run
   from the same pristine fixture). Use `bun run dev:release -- --fps -v`
   after 001, optional `bun run dev -- --fps -v` explicitly called debug
   when release unbuilt. `FLOW_FPS=1` stays off (extra loop).
   Pan **at 20–35% zoom** and separately at **100%**, keeping scene,
   selection and window dimensions fixed and idle/warmup comparable. Record
   `frame` mean/p50/p95/max, `paint` mean/p50/p95/max, `canvas`
   mean/p50/p95/max, `js` mean/p50/p95/max, `commits`, `items`, `over`,
   `engine` alongside `fps shown/refresh`; these four numbers each come from
   `nsh::fps` as 001 describes. **Do not mix trace's `js` event handler with
   the per-second `nsh::fps js` statistics.** Include fixed exact commit,
   host profile/db path hash, window size/screen refresh selection count and
   tests/gestures done; no threshold and no random commit times.
4. Review the overview (the 6% Fit-scale shot): the card grid should read
   as a field of small plates with their accent bars, not as text smears.
   Compare side-by-side. Any visible missing or misaligned card is a
   STOP.
5. Treat the fields above as the full metric record—not just paint p50.
   `nsh::fps` lists each of `frame`, `paint`, `canvas`, `js` as four values
   mean/p50/p95/max when `-v`; keep warmups and iterations comparable and
   report ranges not an invented timing gate. No repeat commands needed
   beyond this; this manual comparison is not CI.
6. At 100% zoom on the dev document (11 cards), compare a card's
   appearance against the detached baseline's matching **same 11-card DB**
   visually. If the plate changed the card's look — rounded corners, border
   color, shadow weight, accent stripe position — STOP: this plan is only
   allowed to be invisible at scale 1.

**Verify**: screenshots plus both before/after `nsh::fps` tables go in the
completion summary (there is no PR in this repository); 100%-zoom appearance
unchanged visually and pan/camera tests listed above pass under after
worktree. If no such measurement can be performed on Windows, record that
limitation rather than claiming host evidence from headless.

## Test plan

New tests:

- `src/flow/card-detail.test.ts` — 5 tests: full/reduced/minimal mapping,
  non-finite fallback, boundary strictness.
- `src/flow/selection.test.ts` — 3 new tests: whole-point rounding,
  anchored-west rounding, anchored-north rounding.

Existing tests to copy:

- Unit-test shape (one behaviour per test, `nsh/test` imports):
  `src/flow/selection.test.ts:1-95`.
- Effect-run counting for a computed: not needed here (the tier mapping
  is pure; the `computed` lives inside a component and has no unit-test
  seam — relying on the App suite to confirm bindings wake correctly is
  fine because App tests run at scale 1 and only verify the full tier).

Regression: the whole-point rounding tests FAIL on `main` (fractional
inputs produced fractional rects) and PASS after step 5. No App test
assertions change.

**Verify**: `bun run test` → all pass, 8 new tests (5 + 3).

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0 with zero warnings.
- [ ] `bun run test` exits 0; the 8 new tests pass.
- [ ] `bun run test:host` exits 0.
- [ ] `grep -n "const detail = computed" src/components/FlowCanvas.tsx`
      returns a match.
- [ ] `grep -n "readonly detail: () => CardDetail" src/components/FlowCard.tsx`
      returns a match.
- [ ] `grep -n "shadow-lg" src/components/FlowCard.tsx` shows it gated on
      the full tier (in the plate's classList, not the body container's).
- [ ] `grep -n "Math.round" src/flow/selection.ts` returns matches in the
      corner and edge paths of `resizedRect`.
- [ ] `grep -n "h-full w-full rounded-2xl border bg-card" src/components/FlowCard.tsx`
      shows the childless plate (not the container).
- [ ] The plate `<View>` has no children (visual review of the JSX).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] 100k before/after screenshots and `nsh::fps` numbers attached to the
      PR description.
- [ ] Visual review: cards at 100% zoom on the dev document look identical
      to `main`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The tier-1 quick checks fail: no `active = computed` in `FlowCard.tsx`
  (005 not landed), no `paused=` in `FlowCanvas.tsx` (004 not landed), no
  `batch(` in `scene.ts` (002 not landed).
- The childless plate changes the card's look at 100% zoom in the host
  screenshots or in the dev app at the dev document: rounded corners
  missing, border weight wrong, accent border not appearing on selection,
  shadow displaced. The renderer's childless-view skip must be invisible.
- `bun run test:host` fails because a paint-shape assertion detects the
  new view hierarchy. This is the same appearance regression, just
  earlier.
- Tier gating blanks a card the maintainer expected to see at Fit scale
  (e.g. the accent bar also disappeared). Stop rather than widening the
  matrix unilaterally.
- The whole-point rounding makes a drag feel "sticky" — the resize
  controller commits only on release
  (`canvas-controller.ts:395-408`) and the `sameRect` tolerance in
  `src/flow/scene.ts:480-487` is 0.01 pt; rounding to integers is larger
  than that tolerance and could in principle cause an end-of-gesture
  commit that no longer matches the live rect. If a controller or App
  test detects a missed commit or a stale override after resize, STOP
  and report rather than widening `sameRect`.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- `card-detail.ts` is the single home for the zoom thresholds. If a
  future change adds a fourth tier (e.g. a cluster representation at very
  low zoom, flagged as adoption debt in `docs/standards.md:602-603`), it
  starts here.
- The tier matrix is encoded as `<If>` blocks in `FlowCard.tsx`, not as a
  table-driven render. That is deliberate: NSH re-creates an `<If>`'s
  children only when the condition's truthiness flips, so a table-driven
  branch would re-create just as much on a tier change without being
  clearer. Keep it as `<If>`s.
- After plan 018 (the NSH fork's partial-frame paint fix) lands and the
  app's `src/native/Cargo.toml` pin is bumped, the renderer's
  childless-view skip becomes a "skip the view's own painting" skip that
  also works on containers. The plate remains correct and still saves
  work; no rollback needed.
- After plan 005's `active = computed`, the plate's classList reads that
  computed; a future change that adds a new accent state should extend
  `active` (or add a sibling computed) rather than reading the raw props
  in the classList.
- The `resizedRect` rounding couples to `sameRect`'s 0.01 pt tolerance in
  `scene.ts:480-487`. A future change that tightens that tolerance must
  re-read this plan's stop condition about end-of-gesture commit drift.
- Deferred: ID2D1 geometry realization caching (`plan 017`) and nine-patch
  shadows (`plan 018`) would make the plate even cheaper but require the
  NSH fork's visual test infrastructure.
- Deferred: the `viewport-controller.ts:96` card budgets and these detail
  thresholds are independently tuned. If a future change ties them
  together (e.g. "only budget 300 cards when below 0.2"), do it in one
  module and delete the duplicate constants.
