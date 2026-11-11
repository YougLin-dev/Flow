# Plan 006: Keep the composer on screen when its card is clicked

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- CHANGELOG.md docs/architecture.md src/App.test.tsx src/components/NodeComposer.tsx src/flow/canvas-controller.test.ts src/flow/canvas-controller.ts src/flow/frame-connection.test.ts src/flow/node-session.native.test.ts src/flow/node-session.ts src/pages/FlowPage.tsx plans/README.md`
> `plans/README.md` is maintained by the advisor; only its status row for this
> plan is an executor edit.
> If Step 3 requires the two conditional `composer-changes` files, append
> `src/flow/composer-changes.ts src/flow/composer-changes.test.ts` to this command before running it.
>
> This plan runs after `plans/002-batch-scene-writes.md` and
> `plans/005-card-bindings.md`. Changes made by these plans are expected.
> Confirm each dependency's row is DONE in `plans/README.md`; then compare
> only the excerpts this plan edits. A mismatch NOT explained by a dependency
> plan is a STOP condition. Plan 002 batches pointer entry points; plan 005
> changes card bindings, not the controller's movement threshold or the
> composer session.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-batch-scene-writes.md, plans/005-card-bindings.md
- **Category**: perf, bug
- **Planned at**: commit `1956ebb`, 2026-11-10

## Why this matters

A click on an already selected card currently unmounts the composer on press
and remounts it on release. An advisor trace of a text composer measured 33
removed and 125 added mount items for that click; image panels have still more
native image children [T: headless optimized engine on the 11-card development
document]. The panel blinks and native Input caret/scroll state is lost.
This plan separates a pending press from movement, skips reads for changes the
composer cannot render, and reconciles reactive detail rows in place. A real
card drag, resize or connector pull must still hide the composer.

## Current state

### Pointer lifecycle and composer anchor

`src/flow/canvas-controller.ts` is the sole pointer router. Its `gesturing`
signal (lines 87-89) is intentionally true from a card or connector press:
`startDrag` at lines 511-522 sets it before any movement, and the existing test
at `src/flow/canvas-controller.test.ts:94-108` asserts that behavior. Keep it.
The drag threshold is `const DRAG_THRESHOLD = 2` (line 72), and
`gesture.moved` flips in drag/resize branches at lines 346-383. Connector mode
publishes a preview on `down` through `EdgeGestures.down`; its first `move`
is the point at which this plan regards a connector as pulled.

`src/pages/FlowPage.tsx:167-179` currently hides on that press-wide signal:

```ts
const composerPosition = (): { left: number; top: number; width: number } | null => {
  // Keep the canvas readable while a card is dragged or resized or a
  // connector is pulled; the composer comes back when the gesture ends.
  if (controller.gesturing()) return null;
  const id = currentSession()?.composerId() ?? null;
  if (id === null) return null;
  const rect = scene.cardRect(id);
  if (!rect) return null;
  const size = stage();
  const width = Math.min(360, Math.max(280, size.width - 16));
  const anchor = composerAnchor(rect, camera, width);
  return { left: anchor.left, top: anchor.top, width };
};
```

The inner `<If when={composerPosition()}>` at lines 474-500 owns
`NodeComposer`'s mount. `inlinePosition` (lines 181-192) has no `gesturing`
read; a repository-wide search at the baseline found the composer anchor as
the only `controller.gesturing()` reader outside controller tests. Do not
change inline-editor behavior.

### Detail reads and asset cache notifications

`src/flow/node-session.ts:58-68` reloads whenever the open id appears in
`changed`:

```ts
onChanges(changes: ChangeSet): void {
  const id = this.composerId();
  if (id !== null) {
    // A removed node has no detail to reload; close before the page's
    // selection effect tries to save drafts back into a deleted row.
    if (changes.removed.includes(id)) this.closeComposer();
    else if (changes.changed.some((node) => node.id === id)) void this.loadComposer(id);
  }
  const inline = this.inlineId();
  if (inline !== null && changes.removed.includes(inline)) this.closeInline();
}
```

`loadComposer` at lines 368-389 sets the new `NodeDetail` at line 381 and
increments `assetVersion` at line 385 after every read. `ensureAssets`
(lines 391-409) fills `this.urls`; `assetUrls()` at lines 103-106 reads the
version and creates its record. `src/flow/asset-urls.ts:21-33` has a separate
cache and coalesces in-flight asset reads. The actual invariant is that a URL
newly entered in the session's `urls` map, not every loaded detail, requires
an `assetVersion` notification. An already pending asset resolution may add
such a URL after the awaited `ensureAssets`; this must remain possible.

`src/.nsh/types/@flow/native.d.ts:145-160` defines every `NodeSummary` field:
`id`, `kind`, `title`, `body`, `x`, `y`, `width`, `height`, `z`, `rev`,
`dataJson`, `settingsJson`, `status`, and optional `outputBatchId`.
`ChangeSet` at lines 26-32 also carries `edgesChanged` and `edgesRemoved`.
Rust's bounds mutation (`src/native/src/mutation.rs:106-149`) returns the
moved nodes but an empty edge list. Do not infer geometry-only status merely
from an empty edge list: caller-supplied change sets and later native commands
can combine node and edge changes.

At this baseline no composer or composer-state code reads the detail node's
`x`, `y`, `width`, `height`, or `rev`. The page uses the scene's
`cardRect(id)`, not detail geometry, to position the composer. Re-run the
verification grep before relying on that fact.

### Detail-child shape and keyed-row exemplar

`src/components/NodeComposer.tsx` maps inputs at lines 70-84 and result
thumbnails at lines 189-193. Those maps re-run when `props.detail` changes.
Kind sections at lines 118-176 use plain ternaries over the kind. The body
Input at lines 166-174 is a sibling of the reactive detail accesses, so
keeping its tree mounted matters.

The target form is the existing keyed list at
`src/components/FlowCanvas.tsx:274-303`:

```tsx
<Each of={props.scene.nodes()} key={(node) => node.id}>
  {(node) => {
    const id = node().id;
    return <FlowCard node={node} rect={() => props.scene.cardRect(id)} />;
  }}
</Each>
```

`Each` items and indices are accessors. NSH's `Each` retains a row by key and
updates its item/index accessors (`E:\code\mine\nsh-pr\crates\nsh-js\src\dom.rs:2794-2924`).
`If` remounts only for a truthiness transition
(`nsh-pr/crates/nsh-js/src/dom.rs:2511-2527`). A keyed list compiled as a bare
function among many insert-array children can still re-evaluate its siblings:
keep each reactive list as the single child expression of an owning `<View>`,
whose children accessor re-runs without remounting the other body sections.
Do not read a keyed item into plain scalar props (`input={entry.input}`), or
the retained row freezes. The NSH fixture `control_flow_and_keyed_rows` at
`nsh-pr/crates/nsh-js/src/dom.rs:4295-4344` shows retained siblings and updated
index accessors.

### Rules to preserve

- `docs/standards.md:311-317`: "Hit tests MUST answer from the scene model,
  never from pixel sampling"; `nodeAt` and `portZoneAt` return topmost hits.
- `docs/standards.md:319-324`: "`CanvasController` is the one pointer router";
  "A press that starts an edge gesture MUST be consumed before card selection."
- `docs/standards.md:227-237`: component bodies run once; props and signals
  are read in bindings/accessors, not cached; derived values use `computed`.
- `docs/architecture.md:247-253`: the composer is screen-space geometry and,
  "While a card is dragged or resized, or a connector is pulled, the composer
  hides so the gesture and its target stay visible."
- `docs/standards.md:443-469`: tests sit beside their subject, use stable
  selectors and `app.waitUntil`, and bug fixes add a failing-first regression.
- Signal/geometry owners stay in `src/flow/`; the page binds readers to
  presentational components. No `any`, non-null assertion, pixel assertion,
  timing budget assertion, raw color token, new native command or SQLite/SQL.

## Commands you will need

| Purpose                     | Command                                                                  | Expected on success                           |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| Dependency markers          | `rg -n 'batch\(' src/flow/canvas-controller.ts`                          | matches in pointer entry points from plan 002 |
| Geometry/revision consumers | fenced grep below                                                        | no composer uses detail geometry or revision  |
| Controller tests            | `nsh test src/flow/canvas-controller.test.ts`                            | exit 0, all tests pass                        |
| Native session tests        | `nsh test src/flow/node-session.native.test.ts`                          | exit 0, all tests pass                        |
| One mounted-app behavior    | `nsh test src/App.test.tsx --filter "keeps the composer mounted"`        | exit 0, named regression passes               |
| Selected-file format        | `./node_modules/.bin/vp fmt --check plans/006-composer-stays-mounted.md` | "All matched files use the correct format."   |
| Full static gate            | `bun run check`                                                          | exit 0, no warnings                           |
| Full headless suite         | `bun run test`                                                           | exit 0, all tests pass                        |

```sh
rg -n 'detail\(\)\.node\.(x|y|width|height|rev)\b' src/components/NodeComposer.tsx src/flow/composer-state.ts src/flow/node-session.ts src/pages/FlowPage.tsx
```

## Scope

**In scope** (the only files you should modify):

- `src/flow/canvas-controller.ts`
- `src/flow/canvas-controller.test.ts`
- `src/flow/frame-connection.test.ts` (focused connector cases only)
- `src/pages/FlowPage.tsx`
- `src/App.test.tsx`
- `src/flow/node-session.ts`
- `src/flow/node-session.native.test.ts`
- Optional, only if adding `canSkipDetailReload` in Step 3 reaches the
  500-code-line lint cap: `src/flow/composer-changes.ts` and
  `src/flow/composer-changes.test.ts`, solely for that field comparator;
  add both to the drift command if needed.
- `src/components/NodeComposer.tsx`
- `docs/architecture.md`
- `CHANGELOG.md`
- `plans/README.md` (the index status only, as the final repository change)
- `plans/006-composer-stays-mounted.md` (execution status only if the executor
  is expected to maintain the plan itself)

**Out of scope** (do NOT touch, even though they look related):

- `src/components/FlowCanvas.tsx`: pointer wiring and plan-005 bindings already belong to earlier plans; no second press route.
- `src/flow/edge-gestures.ts`, `src/flow/connection-gesture.ts`: the controller
  already owns the mouse coordinates and determines the first edge move.
- `src/flow/scene.ts`, `src/flow/selection.ts`, `src/flow/connection.ts`:
  no hit-test or scene-refactor work belongs to this UX fix.
- `src/flow/asset-urls.ts`, native Rust and generated types: content-addressed
  assets, their URL representation and database semantics stay unchanged.
- New component tests or global/native monkey-patching: no `src/components/*.test.tsx`.
  Use pure tests, a typed `NodeSession` subclass counter and App.test.tsx. No simulator spy API or
  production observer/telemetry is added: `DeferredAssetUrls` implements only
  the documented `AssetUrlSource` host methods, and `CountingNodeSession`'s
  protected `nodeDetail` is the narrow read-count seam.
  No production telemetry or patchable spy hooks.

## Git workflow

- Branch from `main`: `git switch -c advisor/006-composer-stays-mounted`.
  If earlier plan branches have not merged into `main`, their DONE revisions
  must be integrated by the maintainer first; do not silently stack or rebase.
- Commit per logical step. Conventional Commits use a lower-case imperative
  subject and an explanatory body. Observed examples:
  `fix: open the canvas menu after a click on the canvas` and
  `perf: keep canvas gestures to one update per moved card`.
- Keep the controller/anchor fix separate from detail-read suppression and
  the keyed-composer refactor, each with its own tests and green gate.
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI and no
  "Generated with ..." line. Do not push and do not open a PR.

## Steps

### Step 1: Confirm the dependency state and lock in failing-first tests

Confirm plan 002's `batch(` wrappers with the dependency command. Confirm that
`gesturing()` still turns true at `down` and that detail geometry/rev has no
consumer using the two grep commands above.

Add these tests before changing production code:

1. `src/flow/canvas-controller.test.ts`, modeled on its `setup` helper
   (lines 45-92) and the card-drag test at lines 94-109. Add
   `"a selected card click does not become a moved gesture"`: select `a`,
   `down(150,120,false,1)`, expect `controller.gesturing()` true and the new
   `controller.gestureMoved()` false, `up`, expect both false and no commit.
2. In the same controller file, add a separate case that moves beyond the
   two-point threshold and expects `gestureMoved()` true; keep the current
   bounds-commit test untouched. Add lifecycle assertions in that case for
   `cancel()` or `up()` clearing the new flag.
3. In `src/flow/frame-connection.test.ts` (model its setup on lines 30-52),
   add a connector press/move case: down on the right plus of a card and
   expect no moved gesture before movement; the first nonzero screen-space
   displacement makes it true. A hovered side-zone example already exists at
   controller-test lines 420-450.
4. In `src/App.test.tsx`, add `"keeps the composer mounted while its selected card is clicked"`.
   Copy `openTallApp()` (line 17) and `selectSeed` (lines 4-11). Open seed
   Text, and type a unique draft (not the seed body's existing text) into
   `id:composer-body`, using the existing `clear`/`type` pattern at lines
   315-329. Call `await app.dragAndHold("id:flow-canvas", { x: 0, y: 0 })`.
   This keeps a stationary press on the revealed card at the center of the
   tall stage, so the baseline unmount can be observed before release. While
   held, assert `id:node-composer` and `id:composer-body` remain shown; then
   `await app.drop()` and `await app.type("id:composer-body", " suffix")`.
   Assert the value contains both the unique draft and the suffix, rather
   than becoming a fresh/stale native input. While held, assert all three:

   ```ts
   expect(app.shows("id:node-composer")).toBe(true);
   expect(app.shows("id:composer-body")).toBe(true);
   expect(app.value("id:composer-body")).toBe("fresh click draft");
   ```

   Type exactly `fresh click draft` after `clear` before `dragAndHold`.
   After `drop()` use `await app.waitFor("id:composer-body")` before its
   value assertion. Before the Step 2 replacement, the two visibility
   assertions fail on the selected-card press, even though no movement ever
   occurred; record this failing-first evidence.

   This same-kind content-retention guard must remain identical through the
   Step 4 keyed-row/kind-section refactor, where it is the failing-first
   regression for a plain ternary or accidentally remounted `<Input>`.
   Re-run the same test after Step 4, reading the text through
   `app.value()` rather than inferring identity from mounted text. The draft
   distinguishes a retained `<Input>` from a saved-and-remounted input;
   neither is a caret-position assertion. No sleep, coordinate substitution
   or production telemetry belongs in this case.

   The test is valid only if it targets the selected Text card: retain
   `"1 card selected"` and composer assertions before the hold. Use only
   stable selectors and `app.waitUntil`, no sleeps, pixels or internal-call
   assertion. The pinned NSH API explicitly supports headless inspection
   during drag-and-hold; this is the zero-displacement click path, not a drag
   regression.

The App test is an end-to-end guard of anchor visibility and retained draft
state; it cannot prove native caret or row identity. The unit tests define
the flag. If the canvas center is covered by another chrome element at the
headless viewport, stop instead of guessing a new target coordinate.

Run the three focused commands below before production edits. The two new
controller cases must fail only because `gestureMoved()` does not exist.
The App click case must reach `dragAndHold`, then fail on a disappeared
composer/body (the actual old behavior), not a selector or unrelated
baseline failure. Thus either a missing reader in unit code or a
zero-displacement disappearance is its valid red reason; an unrelated
existing-test failure returns the baseline to the maintainer. Record all of
these runs rather than counting a file's tail summary without reading which
case failed.

**Verify**: `nsh test src/flow/canvas-controller.test.ts` → the new pending
press/move cases fail on missing `gestureMoved`, old cases pass;
`nsh test src/flow/frame-connection.test.ts` → same expected new-case red;
`nsh test src/App.test.tsx --filter "keeps the composer mounted"` → the new
test fails from the press-wide disappearance, with the typed draft observed
before the hold.

### Step 2: Publish actual movement and preserve the composer during a click

In `src/flow/canvas-controller.ts`, keep `gesturing` unchanged and add a
documented `readonly gestureMoved = signal(false)` near it. Set false at the
start of `down`, `up`, and `cancel`. A second press after a completed gesture
must not inherit the old value.

Use a small private helper that sets it only on a false-to-true transition;
call it only when:

- drag `gesture.moved` changes false to true beyond `DRAG_THRESHOLD`;
- resize `gesture.moved` changes false to true beyond that threshold; and
- connector mode processes its first `move` whose coordinates differ from
  the press (`this.gesture.startX`/`startY`), i.e. a nonzero displacement;
  no `DRAG_THRESHOLD` is used for a connector (its `Gesture.moved` field is
  not used today). Do not use `lastX`/`lastY` after the method has updated
  them. Do not flag a pre-move preview published by `EdgeGestures.down`,
  hand-tool panning or marquee selection.

Do not modify `gesture.moved`, `gesturing`, connector behavior, or the
existing press-priority rules. Keep this signal write within plan 002's outer
pointer-event batch; do not add a conflicting inner batch just for it.

In `FlowPage.composerPosition`, replace only
`if (controller.gesturing()) return null;` with the actual-movement reader.
Update the nearby comment to distinguish a pending press from a real drag,
resize or connector pull. Update `docs/architecture.md:251-253` to state
that the composer stays mounted during a click and hides after movement starts.

Add a concise `CHANGELOG.md` `### Fixed` entry: a selected card click no
longer unmounts its composer, so native input drafts/caret do not blink away.

**Verify**: `nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/frame-connection.test.ts && nsh test src/App.test.tsx --filter "keeps the composer mounted"` → exit 0; the old press-level `gesturing` assertions and the new click/movement cases all pass.

### Step 3: Skip detail reloads only for demonstrably geometry-only changes

Add a private pure `canSkipDetailReload(current: NodeSummary, incoming:
NodeSummary)` in `node-session.ts`. Compare every non-bounds field explicitly:
`id`, `kind`, `title`, `body`, `z`, `rev`, `dataJson`, `settingsJson`,
`status`, and optional `outputBatchId` (normalized with `?? null`, matching
plan 007's record equality). All must be equal; only `x`, `y`, `width`,
`height` may differ. An identical incoming summary also skips. `z` and `rev`
always count as content for this predicate. Return a named boolean and do not
use `Object.keys`, broad JSON comparison or a partially enumerated field list.

If adding these few lines would exceed the 500-code-line lint cap, move ONLY
this named predicate into the explicitly scoped `composer-changes.ts` and add
its field tests in `composer-changes.test.ts` (Scope section). Do not
suppress lint or split unrelated session code.

In `onChanges`, if the open id is in `removed`, retain the existing close
behavior. Otherwise, let `current` be `this.detail()` once, and compute one
`reload = false` flag if it matches the open id; set true for any incoming
summary that is not bounds-only, for a touching `edgesChanged`, or for any
`edgesRemoved` entry. Invoke `void this.loadComposer(id)` at most once, only
when that consolidated flag is true. Do not use `changed.every` to make
multiple summaries look safe or reload once per summary. For an open id that
is not in `changed`, an unrelated edge addition alone is not a reload, while
an edge removal still is.

This conservative exception supersedes the tempting "touching edge only"
optimization. Native `delete_edges` bumps the target card's rev
(`src/native/src/mutation.rs:300-340`), but a deleted edge itself carries no
endpoint IDs: `FlowPage.applyChanges` lines 71-76 calls
`scene.applyChangeSet` before `currentSession()?.onChanges`, so the scene no
longer has those endpoints. The safe alternatives are the chosen always-reload
removal policy or an out-of-scope change to change-set history. The extra
detail read is cheap next to a stale input list.

This last requirement prevents stale composer inputs after a connection
change. Multiple summaries for the open node may be redundant but must not
make a content change look bounds-only. Preserve `generation`, the disposed
guard, `onSettled` reloads, and node-removal behavior.

Centralize the cache insertion in one private `cacheUrl(id, url)` helper: if
`this.urls.has(id)`, do nothing; otherwise set the map entry and increment
`assetVersion` once, there. `ensureAssets` calls this only for each nonempty
awaited URL, whether its generation is current or stale, and returns whether
it inserted anything. `loadComposer` no longer contains an unconditional
post-`ensureAssets` version increment and need not infer a late insertion.

For the deterministic late-arrival test use a `DeferredAssetUrls` typed
against the existing host seam. Add `export interface AssetUrlSource` beside
`NodeSessionHost` with only `url(id: string, mime: string): Promise<string |
null>` and `get(id: string): string | null`; change only its `assets()` to
`AssetUrlSource | null`. Production's `AssetUrls` satisfies this interface;
its import remains type-only. Other seeded tests keep the real `AssetUrls`
and its lifecycle. `DeferredAssetUrls implements AssetUrlSource` in the test
owns per-ID explicit deferreds for its `url` promise; test-facing
`resolve(id, url)` records that same string in its map, then resolves once.
No global `URL`/`Blob` mocks, `any`, production observer/callback or fixed
sleeps. A deferred is created before the fake's `url` is called; `url` first
records `pendingCalls.set(id, count + 1)` and then returns that deferred's
promise, so pending proof cannot race a missed `url` invocation. Cache the
completed string for later `url` calls; pending calls at the end are resolved
null by its local cleanup to avoid hangs. The fake never imports native
`Document`, reads asset bytes or mimics `AssetUrls.dispose`.

After the central `cacheUrl` change `ensureAssets` must cache every final
nonempty returned string regardless of load generation; the fake's deferred
notifies the real cache without needing production subscription, effect or
entry-exit arming. The test controls only the asset's promise boundary. The
typed `CountingNodeSession` below increments `detailReads` and
`nodeDetailsCompleted` after `await super.nodeDetail(id)`; no protected field
becomes writable or subclass-only `loadComposer` shortcut appears.

Run the late-arrival native case with the real document and
`NodeSessionHost.assets = () => fake`. First use the real `IMAGE_NODE_ID`
fixture and run the image provider until actual output items and MIME exist;
copy `makeSession` and add the injection seam, rather than replacing its
real-assets image-provider case. Resolve only the detail read normally; use
a named output `assetId`'s controlled pending URL rather than a text item
lacking MIME. Trigger an explicit `onChanges` with that id's unique changed
summary from `document.nodeDetail`, changing a content field for one reload.
Capture the original pending fake deferred and read counter. Trigger a
second `onChanges` with another unique content change; await
`nodeDetailsCompleted` for that second read and the new detail's
installation. Do **not** use `openComposer(sameId)` when current detail is
nonnull: its existing early-out suppresses a read. `ChangeSet.rev` is an
explicit document revision in the synthetic fixture, not substituted by a
node-summary `rev`.

Before resolving the old deferred assert its `pendingCalled` is true and
the second read's detail was installed, with `assetVersion` captured.
`fake.resolve(oldAssetId, "blob:test-late")` is then called once;
`until(() => session.assetVersion() === oldVersion + 1)` uses the existing
bounded polling wrapper without a sleep. Assert `session.assetUrls()
[oldAssetId]` is that exact string, `fake.get` has the same identity and the
superseding detail remains current. One late ID means exactly one increment.
To prove a cached load no longer increments trigger one more content
`onChanges`, await its returned detail and each cached `fake.url` completion
flag (the production ensure-await settles after those promises), then check
version stayed at old+1. No unresolved URL deferred remains before cleanup.
Dispose the real runner/assets/document; the fake resolves remaining pending
promises in its own `finally`, not through a mocked `AssetUrls.dispose`.
These assertions all use ordinary `until` and explicit change sets; no
intermediate-frame race decides success.

Add a `protected async nodeDetail(id: string): Promise<NodeDetail | null>`
method on `NodeSession`. It obtains the current host document, and when
available and not disposed `return document.nodeDetail(id)`—the same promise
value and one read, not a duplicate call. `loadComposer` uses this wrapper in
place of its direct call; keep the rest of `loadComposer` unchanged. For these
tests only, extend `NodeSession` with a typed subclass whose `nodeDetail`
increments a public counter before delegating to `super.nodeDetail(id)`.
`makeSession` continues to use the uninstrumented class for existing tests;
the new detail cases construct the subclass through the same host. No global
no `any`, unsafe cast, global spy or additional module is needed; the
optional capacity-based comparator helper in Scope is a separate fallback.

If widening this local `nodeDetail` seam to `protected` is inappropriate for
the project, STOP and report that choice rather than inventing a monkey patch;
there is no reason to copy the full Document API for this bug.

The test opens Text, captures `detailReads` after the initial load, then
invokes `session.onChanges`. Add separate native cases, each with a real open
composer and explicit `ChangeSet` objects:

- a moved summary constructed from `detail.node` with changed x/y/width/
  height and the SAME rev, with no touching connectors: the counter does not
  increase and `detail()` remains identical; no `assetVersion` increment;
- next invoke a no-op geometry summary (all fields identical): same
  no-read result, with no invalidation between the two negative cases;
- a persisted field/content change (`body`, `settingsJson`, or `z`) increases
  `detailReads` by one and adopts the returned detail;
- a synthetic rev-only change increases it by one even if no other field
  changed (an upload/add-input change may take this shape);
- `edgesChanged` touching the open node, or any nonempty `edgesRemoved`,
  triggers one detail read even if its node summary only moved (update the
  native fixture connection first so expected inputs are meaningful);
- unrelated connector additions without an open-card node change do not force
  a read;
- a newly available asset URL increments `assetVersion` exactly once using
  the deferred `DeferredAssetUrls` and ordered late-completion harness above;
  a subsequent same-URL completion does not increment it.

Use the existing `until(check)` helper at lines 10-25 for native asynchronous
work, not sleeps in app tests. Dispose runner, assets, pending test promises
and document in every test, as existing tests do. The original `onChanges`
JSDoc should explain the bounds exception and connector-input reason, not
claim all commands reload.

**Verify**: `nsh test src/flow/node-session.native.test.ts` → exit 0, including bounds-only identity retention, rev/content and touching-connector reloads, and asset-version cases.

### Step 4: Key detail rows and mount kind sections by truthiness, not object identity

Refactor only `src/components/NodeComposer.tsx`; keep `NodeComposerProps` and
callbacks unchanged. Derive a one-time `const kind = computed(() => props.detail.node.kind)`
inside the component, not a module-level signal and not a signal written by
an effect. Use `<If when={kind() === "image"}>` for the image controls and
`<If when={kind() === "text"}>` for the text body. A computed's ordinary value
change from `"text"` to `"image"` would invalidate these conditions; the
boolean `<If>` truthiness prevents a same-kind detail reload from remounting
the section, including `composer-body`. Do not replace this with a plain
ternary.

Convert input groups and chips to keyed `<Each>` rows, each isolated under a
View whose child is only that Each expression (or an extracted child panel
that keeps the same mount). An outer Each has
`key={(group) => group.id}`; its title and inner list must read the group
Accessor. Inner Each keys are `(entry) => entry.input.id`. Every retained
callback receives an Accessor; use `group()` and `entry()` (and the index
Accessor) in JSX/callback reads, not scalar `group={group}` props. Input
reordering is keyed by stable input ids, not list positions; moving up/down
must read the current `props.detail.inputs` when clicked. Grouping stays the
existing `inputGroups` function (lines 305-319) with consecutive-edge grouping.

`inputGroups` currently assigns `key` from `edgeId ?? "local"` and can create
two non-adjacent groups with the same edge/local key when local uploads lie
between edge groups. Preserve the visual grouping while making each keyed
Each list unique: key by group occurrence (the existing `InputGroup` may gain
a synthetic `id` such as key plus group ordinal), while keeping chip keys as
input ids. Do not move a chip between different groups as part of this
refactor; if a detail update can change an input's source group, preserve its
semantics first even if that means a remount for that move.

For result images, use one computed `imageItems` list derived from
`props.detail`; supply it to an isolated Each View with
`key={(item) => item.id}` and `ResultThumb item={item}` using an accessor
prop. `ResultThumb` must read `props.item()` in `itemUrl`. Image URLs remain
in `assetUrls()`. Do not key by URL or array index. InputChip similarly takes
`input: () => InputItemSummary`, and `index`/`count` as accessors or cheap
closures. Return `[]` from the computed when no batch exists so the list can
be present only inside the existing truthy `<If>` condition; do not leave
plain mapped lists inline.

No empty-input/result tree should flash stale groups. Array static maps for
the immutable `IMAGE_ASPECTS` table stay static. No `if` outside a binding
should capture a once-only detail kind.

The existing app tests cover card-kind switching and draft preservation
(lines 331-361), removing inputs (301-313), body saves (315-329), and editing
and running prompts/body (275-298). They are the mandatory safety net for this
refactor. If a new subtle list behavior is not covered, add a case to
`App.test.tsx`, not a standalone component harness.

**Verify**: `nsh test src/App.test.tsx --filter "composer"` → all existing composer cases and the click regression pass, including text/image switching and preserved drafts.

### Step 5: Format, run every test, record the manual boundary, and update the index

Run the format check and then the full gate below. If formatting is needed,
`./node_modules/.bin/vp fmt` may target only modified files in this plan;
review its diff afterward. Run `bun run check` and `bun run test` last.

The mandatory automated evidence includes the new flag tests, native
change-set tests and App click test. On Windows, a local real-host click is
recommended for caret inspection; it is not a pixel or timing CI assertion,
and this plan does not require adding a `.host.test.tsx` file. Record whether
this manual check was actually run.

After green tests, update this plan's `plans/README.md` row to DONE only if
you own the index; format the Markdown index. Do not invent an index file if
it is missing—report that the maintainer must add the row rather than editing
other plans.

**Verify**: `bun run check && bun run test` → both exit 0, no warnings, all tests pass. `./node_modules/.bin/vp fmt --check plans/006-composer-stays-mounted.md plans/README.md` → "All matched files use the correct format." when both index files exist.

## Test plan

- `src/flow/canvas-controller.test.ts`:
  - pending selected-card press: `gesturing` true, `gestureMoved` false;
  - drag beyond the threshold: true, then false on `up`/`cancel`;
  - resize and connector paths equivalent, with adjacent jitter remaining
    false.
    Copy the existing `setup` helper and lines 94-137; one behavior per test.
- `src/flow/frame-connection.test.ts`: copied setup and existing plus
  examples show group/single-plus down does not prematurely mark a connector
  as pulled.
- `src/App.test.tsx`: modeled on the existing `selectSeed` helper and
  `"selecting a text node opens its composer"` (lines 265-273). A click on
  the revealed selected card preserves the mounted composer, its body control
  and an unsaved draft.
- `src/flow/node-session.native.test.ts`: copied real native document and
  `makeSession` fixtures; bounds-only, rev/content, touching-edge and unrelated
  edge cases plus asset-version notification tests.
- Existing `App.test.tsx` input-removal, reorder/kind-switching, prompt/body
  editing and run cases are the reconciliation safety net; they must remain
  green.
- Verification: `nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/node-session.native.test.ts && nsh test src/App.test.tsx` → all pass.
- No temporal execution budget is an automated test. `nsh test src/App.test.tsx --filter "keeps the composer mounted" --trace` is optional manual evidence that mount items are lower during the click; project §8.2 forbids flaky CI frame-budget assertions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `rg -n 'gestureMoved' src/flow/canvas-controller.ts src/flow/canvas-controller.test.ts src/pages/FlowPage.tsx` finds the reader, writer and regression tests.
- [ ] `rg -n 'composerPosition|gestureMoved|gesturing\\(' src/pages/FlowPage.tsx` shows the composer anchor checks actual movement, not press-level gesturing.
- [ ] `nsh test src/flow/canvas-controller.test.ts && nsh test src/flow/frame-connection.test.ts && nsh test src/flow/node-session.native.test.ts && nsh test src/App.test.tsx` exits 0, including the named click and detail cases.
- [ ] A geometry-only change with no touching connector and no removed edge preserves `detail()` identity, while content/rev and touching/removed-edge changes still reload; demonstrated by test names/results.
- [ ] `rg -n '<Each of=\{inputGroups|<Each of=\{imageItems|computed' src/components/NodeComposer.tsx` finds stable list/kind accessors.
- [ ] `bun run check` and `bun run test` both exit 0 with no warnings.
- [ ] `git diff --check` exits 0; `git status --short` shows only this plan's in-scope edits.
- [ ] `docs/architecture.md` and `CHANGELOG.md` describe click-versus-movement behavior accurately.
- [ ] `plans/README.md` status row updated if the executor owns the index; the index is formatted.

## STOP conditions

Stop and report back (do not improvise) if:

- A current-state mismatch is not attributable to DONE plans 002 or 005, or a
  dependency's row is not DONE when this plan is dispatched.
- `grep` shows that the composer or another view reads the open detail's card
  bounds or `rev`; skipping reloads would then freeze visible state.
- FlowPage's `applyChanges` ordering (scene update before `onChanges`) suggests
  filtering `edgesRemoved` by the open card: the old edge endpoints are gone.
  Treat every removal as requiring an open-composer reload; never make the
  removal filter an endpoint lookup against the already-updated scene.
- The App test's press does not hit the selected card (covered selector or no
  card target). Do not substitute a drag—the reported defect is a click—and
  do not add arbitrary sleep/retry/assertion suppression.
- A modified edge path would require changing `gesturing` semantics or breaks
  the existing assertion at controller-test lines 94-108.
- A keyed `Each` group would reuse a duplicate key, reorder callbacks become
  stale, or a same-kind update still remounts the composer because of plain
  ternaries or scalar child props. Re-read the accessor shape; stop after two
  focused repair attempts fail the same behavior.
- `onChanges` would require an effect-driven signal mirror, more than one
  `nodeDetail` call for the same change set, or bypassing removal/rev guards;
  the explicit field comparator and narrow protected test seam must remain
  the implementation. If its capacity-based helper module is insufficient
  to stay within the lint limit, STOP and report the exact size overrun.
- Composer App tests fail in ways not clearly caused by this refactor, or a
  requested fix would touch native SQL, `AssetUrls`, generated files, scene
  hit-testing or any other out-of-scope file.
- A real drag/resize or connector pull now leaves the composer visible while
  moving, or a cancellation leaves `gestureMoved` stuck true.
- A step's verification fails twice after a reasonable, in-scope fix attempt.

## Maintenance notes

- `gesturing` remains the press-wide state used by cursor/controller behavior;
  `gestureMoved` is solely the movement-derived anchor guard. New gesture
  types should not opt into either signal without deciding their click,
  cancellation and drag thresholds.
- Any future composer visualization of `detail.node`'s position, size or
  revision invalidates the bounds-only skip. Review the complete generated
  `NodeSummary` field list when native types change; no broad shallow
  equality exception should erase rev-only upload/input updates.
- Reordering or reconnecting inputs must always trigger a detail update even
  without a summary change to the destination card. Review every `ChangeSet`
  producer before loosening the edge-touching guard.
- Only a newly added session URL warrants `assetVersion`. The `this.urls`
  map's late cache completions must notify asset readers; never replace that
  signal with an effect that reads and writes itself. A later asset-URL/blob
  plan may change caching, but this boolean contract should survive.
- Keyed `<Each>` rows receive accessors; plain props snapshot the initial
  value. Review group keys for uniqueness and kind guards for truthiness:
  this is the central React/NSH difference in this change.
- Component tests deliberately stay through `App.test.tsx`; the repository
  documents no `src/components/*.test.tsx` pattern.
- This plan intentionally does not implement viewport-level identity
  retention, scene hit-test caching or image URL migration. It should land
  before plans 008 (controller hit-test scale) and 013 (asset URL changes).
- Deviations baked into this plan: connector movement uses its first nonzero
  screen displacement, not the card's two-point DRAG_THRESHOLD; any removed
  edge conservatively triggers a detail reload because its endpoints have
  already left the scene. These preserve the advisor's UI intent without
  silently losing information. The App click case uses NSH's zero-delta drag
  and hold, not a new pointer API; a typed protected nodeDetail wrapper supplies
  read-count observations rather than complex host replacement.
