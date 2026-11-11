# Plan 010: Keep at most one viewport read in flight

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- src/flow/viewport-controller.ts src/flow/preview-loader.ts src/flow/viewport-controller.test.ts src/flow/preview-loader.test.ts src/flow/canvas-controller.test.ts plans/README.md`
> This plan depends on plan 007 (`plans/007-reads-wake-only-changes.md`), which
> adds stable-previews target equality in `src/flow/preview-loader.ts` and
> creates `src/flow/preview-loader.test.ts`. It does **not** edit
> `src/flow/viewport-controller.ts`; this plan introduces that change. `plans/README.md`
> is advisor-maintained; only this executor's status row is an allowed change.
> Confirm plan 007's row is DONE in `plans/README.md`; then compare only the
> excerpts this plan edits. A mismatch NOT explained by a dependency plan is
> a STOP condition.
>
> **Pre-flight contract check (before implementing Step 1)**: Read
> `src/pages/FlowPage.tsx:221-229` first; `revealNode` calls
> `viewport.focusBounds(...)` and then `await viewport.refresh()` without a
> synchronous revision bump between them. Run
> `grep -n "viewport.noteRev(" src/pages/FlowPage.tsx`: it must show only the
> `applyChanges` callback that applies command results (line 72), outside that
> interval.
> Trace any additional match before proceeding. If a caller bumps `lastRev`
> between `focusBounds` and the awaited `refresh()`, STOP before implementing.
> The awaited promise must still resolve after that latest rect has been applied
> or deliberately dropped by the existing guards.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/007-reads-wake-only-changes.md
- **Category**: perf
- **Planned at**: commit `1956ebb`, 2026-11-10
- **Reconciled at**: commit `91929e4`, 2026-11-11 — plan 007 landed and
  created `preview-loader.test.ts` with five cases (including the cold-empty
  and emptied-target publication). `viewport-controller.ts` is unchanged
  since planning; the FlowPage and test line references below are updated.

## Why this matters

`ViewportController.refresh()` and `PreviewLoader.refresh()` each fire a DB
read and only drop a stale result after it has resolved. The DB worker at
`src/native/src/db.rs:338-340` is a plain FIFO queue with no cancellation.
Once a single read takes longer than the 80 ms throttle (large document at a
low zoom, or the un-optimized debug host that plan 001 measures against),
the queue grows: every pan/zoom tick enqueues one more read, none applies
until the FIFO drains, and the QuickJS engine still spends time converting
snapshots it will throw away. The bug is invisible on the 11-card reference
document because each read is ~1 ms. Single-flight capping keeps at most one
read queued, every refresh caller still observes the latest rect, and the
engine never does conversion work whose answer it discards.

## Current state

`src/flow/viewport-controller.ts` arms a timer, fires `refresh()`, and
discards stale answers via a generation counter. Relevant excerpt
(`src/flow/viewport-controller.ts:51-78`):

```ts
schedule(): void {
  if (this.timer !== null || this.host.isDisposed()) return;
  this.timer = setTimeout(() => {
    this.timer = null;
    if (!this.host.isDisposed()) void this.refresh();
  }, VIEWPORT_DELAY_MS);
}

async refresh(): Promise<void> {
  const document = this.host.document();
  const scene = this.host.scene();
  if (!document || !scene || this.host.isDisposed()) return;
  const generation = ++this.generation;
  const { rect, margin } = this.visibleRect();
  try {
    const snapshot = await document.scene(rect, margin);
    if (this.host.isDisposed() || generation !== this.generation) return;
    if (snapshot.rev < this.lastRev) return;
    this.lastRev = snapshot.rev;
    const camera = this.host.camera();
    const scale = camera?.scale ?? 1;
    const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
    scene.apply(snapshot, { maxCards });
    this.host.schedulePreviews();
  } catch (error) {
    if (!this.host.isDisposed()) console.error("Flow could not read the viewport", error);
  }
}
```

`src/flow/preview-loader.ts` (lines 49-77) adds plan 007's `lastTargets` and
exported `sameTargets` around `loadPreviews(...)`. An unchanged target list
returns before any read; an empty list issues no read, records the empty list,
and publishes `[]` only when the previous list was non-empty (clearing stale
thumbnails). Preserve all of that as described in Step 2. Results apply via
`current.applyPreviews(views)` once the read returns.

Callers that currently `await viewport.refresh()`:

- `src/pages/FlowPage.tsx:228` (`revealNode`) — awaits the read so the
  revealed node's rect is applied before selecting and opening the composer.
- `src/pages/FlowPage.tsx:284` (`openFlow`) — awaits after
  `fitToDocument(false, false)` so the first scene is on screen before
  announcing the zoom.

Both await the read settlement before continuing, with their existing
scene-selection/announcement behavior preserved. A revision-stale result still
uses the existing drop contract. The DB worker queue is a plain FIFO (`src/native/src/db.rs:338-340`):

```rust
for job in jobs {
    job(&conn);
}
```

There is no cancellation, so "drop stale results" only helps once the stale
result has arrived — the wasted work has already happened.

Conventions that apply here:

- §6.1 of `docs/standards.md` (lines 220-221): "Use one `batch` only when
  several writes form one invariant; `batch` is not a performance ritual."
- §8.1 (lines 366-371): "Signal reads needed by async work MUST happen
  synchronously before the work starts. Stale results MUST be dropped by
  revision or identity."
- §9 (lines 433-475): tests beside the subject; one behaviour per test;
  `app.waitUntil` instead of sleeps; manual clock when time matters.
- File naming: tests are kebab-case next to the subject (`viewport-controller.test.ts`).

The work-count test pattern to copy is
`src/flow/scene.test.ts:402` ("a drag's overrides notify only the cards
it moves") which counts `effect` runs. For fake-document testing, model on
`src/flow/canvas-controller.test.ts`'s host-fake setup.

## Commands you will need

| Purpose                                                         | Command                                                              | Expected on success                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| Run a single flow test file                                     | `nsh test src/flow/viewport-controller.test.ts`                      | all pass                                    |
| Run the matching preview-loader tests                           | `nsh test src/flow/preview-loader.test.ts` (extend plan 007's file)  | all pass                                    |
| Tests by name (filter substring)                                | `nsh test src/flow --filter "one read in flight"`                    | matching tests pass                         |
| Full gate: NSH typecheck + lint + format + Rust format + clippy | `bun run check`                                                      | exit 0                                      |
| All tests                                                       | `bun run test`                                                       | exit 0                                      |
| Format one file                                                 | `./node_modules/.bin/vp fmt --check src/flow/viewport-controller.ts` | "All matched files use the correct format." |

## Scope

**In scope** (the only files you should modify):

- `src/flow/viewport-controller.ts`
- `src/flow/preview-loader.ts`
- `src/flow/viewport-controller.test.ts` (create)
- `src/flow/preview-loader.test.ts` (extend the three cases created by plan 007)
- `CHANGELOG.md` (one `### Changed` bullet)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `src/pages/FlowPage.tsx` — the callers still await `refresh()`; the contract
  ("resolves after the latest rect is applied") is preserved by this plan, no
  caller change is needed.
- `src/native/src/db.rs` and the worker loop — the plan's whole point is that
  we cannot cancel queued jobs. Do not add cancellation in this plan.
- `src/flow/canvas-controller.ts`, `src/flow/scene.ts` — unrelated gesture /
  scene work belongs to other plans.

## Git workflow

- Branch: `git switch -c advisor/010-one-read-in-flight`
- One commit per logical step (single-flight viewport; single-flight previews;
  tests; changelog). Conventional Commits with a lower-case imperative subject
  and a body that explains the why, matching `git log` — e.g.
  `perf: keep canvas gestures to one update per moved card` (1956ebb),
  `fix: open the canvas menu after a click on the canvas` (21dbe05).
- NEVER add AI attribution: no `Co-Authored-By:` trailer naming an AI, no
  "Generated with ..." line.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`.

## Steps

### Step 1: Single-flight the viewport read with one drain loop

Edit `src/flow/viewport-controller.ts`. Add private state:

```ts
private inFlight: Promise<void> | null = null;
private dirty = false;
private pendingResolvers: Array<() => void> = [];
```

Use **one** mechanism: a thin public `refresh()` and a private `runReads()`
loop. Do not recurse from a completed read into another `refresh()`.

`refresh()` must implement this exact contract:

1. Read `document`, `scene`, and `isDisposed()` synchronously (§8.1). If any
   are unavailable/disposed, return immediately, exactly as today.
2. If `inFlight !== null`, set `dirty = true`, return a new promise, and store
   its resolver in `pendingResolvers`. All joins share the one in-flight drain:
   one current read plus at most one follow-up per newer change.
3. Otherwise start `runReads()` and assign its promise to `inFlight` **before
   its first `await`**. The loop captures the visible rect synchronously at
   the start of each iteration, increments `generation` once for that issued
   read, then awaits `document.scene(rect, margin)`. Keep the existing
   `snapshot.rev < this.lastRev`, generation, and disposal drops intact. Capture
   `document` and `scene` once before the loop and the rect afresh in every
   iteration. Only a successfully applied snapshot updates `lastRev`, applies
   the scene, and schedules previews; preserve the existing non-disposal error
   logging.
4. After each awaited read, if `dirty` is true, clear it and iterate once for
   the newest rect. Clear `dirty` **before** awaiting the follow-up so a refresh
   arriving during that request marks the loop dirty again.
5. When no dirty read remains, settle `inFlight = null` and resolve all pending
   resolvers via one `finishReads()` helper that copies, clears, then invokes
   resolvers. On read error or a normal generation/rev drop with no newer
   request, do the same: a dropped read resolves after its request finishes and
   no follow-up is queued. Add an inline comment documenting that callers
   observe settlement, not proof that an outdated revision was applied.
6. **Mid-drain disposal**: whenever `isDisposed()` is true after an await (or
   at the top of an iteration), immediately set `inFlight = null`, drain and
   resolve every pending resolver, stop issuing reads, and return. Do not clear
   `inFlight` and recurse. Resolve calls that joined the now-disposed drain too.
   The initial early-dispose branch in item 1 returns without creating a read.

The shape is a shared in-flight wallet owned by `runReads()`, with no recursive
retry. A new refresh can arrive between setting `inFlight = null` and resolving
the copied resolvers; allow it to start a fresh drain. `dispose()` keeps its
existing timer cancellation and relies on the host's disposed flag for the
mid-drain contract; do not add host reads after disposal.

Before wiring Step 2, explicitly compare the two generation strategies: with
this single-flight implementation, do **not** increment `generation` when a
request merely joins; otherwise the current read would be discarded and the
joined follow-up would keep the callers pending forever. A generation increment
belongs to each actual read iteration (or disposal), matching the stale-snapshot
role described above.

Add a fifth viewport case: hold a read's deferred, add one joined refresh,
mark the host disposed, resolve the read, and assert no second read occurs and
both promises settle. The ordinary non-applied drop contract stays covered by
the join and generation tests below.

**Verify**: `nsh test src/flow` exits 0 (no viewport test exists yet, but the
rest of the suite must still pass).

### Step 2: Single-flight the preview loader while retaining plan 007's skip

Repeat the thin-`refresh()` / `runReads()` shape in
`src/flow/preview-loader.ts`, with `inFlight`, `dirty`, and
`pendingResolvers`. Preserve plan 007's `lastTargets` and `sameTargets` as its
optimization; they compose with, rather than replace, the single-flight wallet.

The merge contract is mandatory:

1. An unchanged-target call **while a read is in flight JOINS that drain** and
   returns a promise settled by the current `finishReads()`; it must not
   return early without a joined promise, must not issue another read, and
   must not mark `dirty` solely because its targets equal `lastTargets`.
   This is the in-flight form of 007's equality skip, not permission to
   bypass it: after the active drain finishes, its `lastTargets` is already
   the current equal set, so an idle unchanged-target call still returns
   immediately before any generation increment.
2. Read `scene.previewTargets()` at each actual drain iteration, immediately
   before issuing `loadPreviews`, so every iteration sees the latest targets.
3. Set `lastTargets` at each actual drain iteration immediately before the
   `loadPreviews` call, exactly where plan 007 set it. The equality guard only
   prevents issuing another DB read when no read is active and targets are
   unchanged; it must not overwrite targets when a request merely joins an
   active drain.
4. A changed-target call also joins and marks dirty. The follow-up issues
   exactly one read of the newest targets. Apply only through the existing
   generation/revision/disposal guards; generation increments per actual issued
   read rather than per mere join. Keep 007's unchanged-target early return
   only after confirming `inFlight === null`, before incrementing generation.
5. On errors, ordinary drops, or mid-drain disposal, use the same settlement
   contract as Step 1: stop after an iteration with nothing dirty, set
   `inFlight = null`, and drain/resolve every pending resolver. On disposal do
   not issue another read, and return immediately from an already-disposed
   entry. Retain the existing `dispose()` timer cancellation. Keep the same
   `finishReads()` settlement semantics as Step 1.

**Empty-target contract (plan 007, preserve):** an empty `previewTargets()`
issues no `loadPreviews` call. Record the empty list in `lastTargets`; when
the previous list was non-empty, publish `scene.applyPreviews([])` so stale
thumbnails clear, while a cold empty start publishes nothing. In the drain
this is a completed iteration, not a dirty read loop.

The plan-007 tests for unchanged targets (one read then a skipped read),
changed targets (a second actual read), `sameTargets`, the cold-empty
early-out, and the emptied-target clearing must continue to pass alongside
the new single-flight cases.

**Verify**: `nsh test src/flow` exits 0.

### Step 3: New test for the viewport single-flight invariant

Create `src/flow/viewport-controller.test.ts`. Use synchronous `nsh/test`
tests (the whole `canvas-controller.test.ts` file already shows this style;
no App fixture is needed). Build a typed `ViewportHost` fake with a real
`CanvasCamera`, a real or minimal typed-recording `FlowScene`, and a document
whose `scene(rect, margin)` pushes `{ rect, resolve }` into a `deferreds`
array and returns a manually-resolvable `Promise<SceneSnapshot>`. Cast a
strict minimal stub through `unknown` to `Document`, as permitted by 007;
never use `any`. Supply all required host methods, with `schedulePreviews`
recording calls and no timers used by direct `refresh()` tests.

The fixture gives tests direct control of every returned snapshot:

- `take(index)` returns the next deferred call and its captured rect; assert
  `deferreds.length` before resolving one so no hidden third read exists.
- `flushRead()` is `await Promise.resolve(); await Promise.resolve();`
  (consider a small `await` loop only if the second read has not yet registered
  in two turns). If the read still has not registered, the test FAILS; do not
  wait wall-clock time or use `app.wait` as a sleep substitute.
- For case 1, resolve the first snapshot, call `flushRead()`, then assert the
  second registered read's rect is latest. Resolve that second snapshot with a
  new rev, `await` all refresh promises, and assert the latest scene geometry.
- Case 2 explicitly checks `settled` flags for joined `refresh()` promises
  between `flushRead()` and resolving the follow-up. Immediate reads at already
  disposed hosts require no async fixture.
- Call `controller.dispose()` with `isDisposed = true` or flip that host state
  in each test teardown, so no deferred promise or timer survives. Never
  reuse a disposed host across tests or leave an unresolved read hanging.

Use fixture snapshots with complete typed node records (`node`/`snapshot`
helpers as in `scene.test.ts`) and monotonically increasing revs; do not make
an empty snapshot that accidentally drops the supposed latest rect. `scene.byId`
is private: verify public `cardRect`/`cardCount`/`nodes()`, or record `apply`
arguments in a typed stub rather than pretending `byId` is readable.

Cover exactly these cases (one behaviour per test):

1. "Three refreshes during one pending read cause exactly two `scene()` calls
   and the last applied rect is the latest." Hold the first promise; call
   `refresh()` two more times with different rects (move the camera or call
   `setSize` then `refresh`); resolve the first; two microtask turns with the
   helper above must register follow-up call 2, and if they do not the test
   FAILS. Assert exactly one second call and its latest rect. Resolve that
   second read with a fresh rev, then await all three returned promises and
   assert the scene has the latest rect; never await a still-pending read.
2. "Awaiting a refresh that joined an in-flight read resolves only after the
   follow-up read." Same setup but hold both promises; the awaiting promise
   of the second `refresh()` must not resolve until the second `scene()`
   resolves.
3. "A refresh that arrives after the queue drained starts a new read."
   Sanity: two sequential refreshes → two `scene()` calls.
4. "A refresh during dispose does not enqueue." Set `isDisposed: () => true`
   and call `refresh()`; it should return without invoking `scene()`.
5. "Disposing mid-drain resolves joined callers without a follow-up read."
   Hold the first read, join another refresh, dispose, resolve the held read,
   applies the final snapshot during disposal; require that no further read is
   issued and both promises settle, not that a disposed scene changed.

**Verify**: `nsh test src/flow/viewport-controller.test.ts` exits 0.

### Step 4: Extend the preview single-flight tests without losing plan 007's cases

**Extend** the already-created `src/flow/preview-loader.test.ts`. First run
`nsh test src/flow/preview-loader.test.ts` and keep its five plan-007 cases:
`sameTargets` unit coverage, unchanged-target read skipping (with at least one
non-empty target), changed-target reload, the cold-empty early-out, and the
emptied-target clearing. Mirror Step 3 with a fake
`Document.previews` deferred stub and a fake `AssetUrls`, sharing fixture
factories so the one-image-target fixture remains non-empty.

Add three cases:

1. One pending read plus two further refreshes with different target sets
   yields exactly two `previews()` calls; the second sees the latest
   `previewTargets()`, and a joined promise resolves only after the follow-up.
2. An unchanged-target call while a deferred read is active joins the existing
   drain: when the active request settles, it must not immediately issue a DB
   read for the same targets, its joined promise must settle, and a subsequent
   unchanged-target call with no active drain is skipped per plan 007. If a
   newer target arrives during that drain, the single follow-up uses that
   newer target and updates `lastTargets` only when it is actually issued.
3. A mid-drain dispose settles the initial and joined refresh promises and
   issues no follow-up. Keep plan 007's unchanged-target and changed-target
   non-concurrent cases unmodified to prove this plan preserves its equality
   guard rather than deleting it to make coalescing easier.

Before implementing, record each new test's expected failing behavior against
plan 007's loader (queued reads or missing joined-promise settlement), then
implement Step 2 and re-run. In these synchronous unit tests use the
deterministic deferred promises and explicit two-turn flush helper above.
`app.waitUntil` is for App-level browser tests, not this file; never use sleeps.

**Verify**: `nsh test src/flow/preview-loader.test.ts` exits 0 with the three
preserved plan-007 cases and all three new cases.

### Step 5: Gate + changelog

Run:

```sh
bun run check
bun run test
```

Both must exit 0. Add one `### Changed` bullet to `CHANGELOG.md` near the
other perf entries:

> The canvas keeps at most one viewport read (and one preview read) in
> flight; a pan or zoom that arrives while a read is pending coalesces into
> one follow-up instead of queuing on the document worker.

**Verify**: `bun run check` exits 0; `bun run test` exits 0; the new
`### Changed` bullet appears under `## [Unreleased]`.

## Test plan

- New files:
  - `src/flow/viewport-controller.test.ts` — 5 cases listed in step 3.
- Extended file:
  - `src/flow/preview-loader.test.ts` — plan 007's five cases plus 3 cases
    listed in Step 4.
- Use the fake-host / async-deferred pattern modelled on
  `src/flow/canvas-controller.test.ts` (fake `ViewportHost`) and
  `src/flow/scene.test.ts:305-325` for counting invocations.
- Verification: `nsh test src/flow/viewport-controller.test.ts src/flow/preview-loader.test.ts` — all pass.

## Done criteria

- [ ] `bun run check` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `src/flow/viewport-controller.test.ts` exists with 5 passing tests.
- [ ] `src/flow/preview-loader.test.ts` retains plan 007's five passing cases
      and adds all 3 cases from Step 4. In particular, an unchanged-target call
      during a read joins that drain, `lastTargets` advances only when a real
      iteration issues its read, and the unchanged-target skip remains outside
      an active drain.
- [ ] Both implementations use `runReads()` loops (no recursive `refresh()`);
      disposal mid-drain stops further reads and settles all pending callers.
- [ ] `grep -n "inFlight" src/flow/viewport-controller.ts src/flow/preview-loader.ts` shows the single-flight state in both files.
- [ ] `grep -n "pendingResolvers\|dirty" src/flow/viewport-controller.ts` shows at least one match.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `CHANGELOG.md` contains the new `### Changed` bullet.
- [ ] Plan row updated in `plans/README.md`.

## STOP conditions

Stop and report (do not improvise) if:

- The pre-flight check at the top of this plan finds a `viewport.noteRev(...)`
  caller between `focusBounds` and its awaited `refresh()` in
  `src/pages/FlowPage.tsx`; STOP before implementing and report the caller.
- After plan 007 the live preview `refresh()` no longer has plan 007's
  documented `lastTargets`/`sameTargets` behavior, or the live viewport
  `refresh()` no longer has the shape quoted in "Current state" (plan 007
  does not edit viewport-controller.ts), and you cannot map single-flight
  onto the actual source.
- `revealNode` or `openFlow` in `src/pages/FlowPage.tsx` depends on the
  read being issued synchronously with `refresh()` (rather than awaiting it)
  — in that case the contract change is wider than this plan; STOP.
- You find a caller that uses the OLD `refresh()` promise's resolution as
  proof the read applied — e.g. code that reads `scene.byId.has(id)`
  synchronously the line after an awaited `refresh()`. The single-flight
  promise still resolves after "the latest rect was applied or dropped",
  which means a rev-stale drop would falsify such a caller's assumption.
  Name the caller; the right fix is larger than this plan.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Future pan/zoom work must not bypass `schedule()`/`refresh()` to call
  `document.scene()` directly; that would reintroduce the queueing. Grep for
  `document.scene(` in review.
- If the worker later grows true cancellation, the in-flight wallet still
  has value: it replaces "issue and discard" with "issue one follow-up",
  saving the engine from converting a snapshot nobody needs. Don't remove
  it just because cancellation exists.
- A reviewer should scrutinize: (a) the contract that a dropped read still
  resolves pending callers, with an inline comment at the site; (b) that
  `dispose()` clears the timer and does not create further reads, and that
  any resolver held at dispose is drained to a clean resolution rather than
  leaking a hanging promise; (c) the tests actually simulate two-pending-
  read timing through the deferred promises rather than assuming.
- Plan 011 scales the read payload itself; it composes with this plan once
  both land (`db.scene` still takes a `maxCards` but ≤1 in flight).
