# Plan 018: Skip off-damage view painting and bake outer shadows once per shape

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Work in `E:\code\mine\nsh-pr`, not the Flow app
> repository. Run builds and tests serially in the main executor session;
> delegate no builds to subagents. When done, update the status row for this
> plan in `E:\code\mine\oflow\plans\README.md` — unless a reviewer dispatched
> you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f0b4659e..HEAD -- crates/nsh-platform-windows/src/render.rs crates/nsh-platform-windows/src/decor.rs crates/nsh-platform-windows/src/decor/cache.rs crates/nsh-platform-windows/src/decor/shadow.rs crates/nsh-platform-windows/src/shader.rs docs/dev/windows.md docs/dev/performance.md`.
> These excerpts are at NSH `f0b4659e`; the Flow app planning commit is
> `1956ebb`. If plan 017 already landed, its `canvas.rs` changes are expected
> and are not a dependency of the paths above. Confirm any declared dependency
> is DONE in the Flow `plans/README.md`; then compare only the excerpts below.
> A mismatch unexplained by an explicitly identified prior NSH change is STOP.
> `git status --short` must be clean before creating the branch. If Step 5 /
> Step 6 later determine the nine-patch decomposition needs the optional
> `crates/nsh-platform-windows/src/decor/shadow.rs` split (a file the drift
> list above already names), allow that new file; if ANY additional new file
> or any new module outside the listed scope turns out to be needed, STOP and
> replan rather than expanding the scope unilaterally.
>
> **Cross-repo exception**: the only file this plan touches outside
> `E:\code\mine\nsh-pr` is `E:\code\mine\oflow\plans\README.md`, and only if
> the dispatching reviewer has handed the Flow plan index to this executor. No
> other Flow file may be modified.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none; plan 017 first is recommended to keep Windows measurements attributable
- **Category**: perf
- **Planned at**: Flow commit `1956ebb`; NSH commit `f0b4659e`; 2026-11-10
- **Reconciled at**: NSH `f0b4659e`, 2026-11-11 — the fork is clean on
  `feat/windows-canvas-damage`; the line references below were refreshed
  against the live files. No source drift.
- **Execution note (2026-11-11)**: implemented on NSH branch
  `advisor/018-nsh-partial-frame-paint` as `d13b66dc` (own-paint skip),
  `78a3d4c4` (lazy `BoxShape`), `a5161c5b` (current-frame cache retention) and
  `bc17f693` (docs/measurements), based on the merged plan-017 point
  `921ef920`, then fast-forwarded into `feat/windows-canvas-damage` at
  `bc17f693`. Flow's pin stays `f0b4659e`.
  The Step 1 probe's failing-first run on the unmodified traversal counted
  `backdrops 1, backgrounds 1, shadows 1` for the off-damage parent; after
  Step 2 it is `0/0/0`, while the damaged child still draws and the
  in-damage control keeps `1/1/1`. All partial-frame fixtures compare every
  BGRA byte with a fresh whole frame; the nested backdrop-reader fixture
  captured 1 and 2 buffers, byte-equal to a whole frame.
  Nine-patch outer shadows were **deferred and removed**: after two focused
  fixes the sliced output still differed from the whole bake by 2093 bytes,
  because Direct2D's blur moves the faint outer tail when the destination
  shape's extent changes (the same 66×66 shape matched on one canvas but a
  200×80 destination differed at alpha 1 vs 0). Steps 2–4 ship; the deferral
  and evidence are in `docs/dev/windows.md` / `docs/dev/performance.md`.
  Gates: `cargo test -p nsh-platform-windows` 237 passed / 1 ignored plus 2
  doctests, the host/app crates pass, Windows clippy passes, and the release
  CLI builds. As in plan 017, the installed nightly reformats an untouched
  base file and the shared target cache breaks workspace-level tests in
  unrelated crates; per-crate gates pass. Three alternating baseline/new
  gallery runs per side measured paint mean 4.40→3.16 ms (Home idle) and
  4.60→3.66 ms (Home scroll), with Stocks/Canvas unchanged within noise,
  identical `--trace` ops/items and byte-identical home/Styles/Canvas
  light/dark screenshots; resized screenshots keep repainting and are visual
  evidence only.

## Why this matters

Windows already clips a partial frame to damaged rectangles, but a container with children still paints its own background, shadows and border even when that container is completely outside the damage. On card-heavy boards that repeats expensive decoration and geometry work for every small canvas update. Separately, rounded shadows are baked per exact box size, so resizing does not reuse the expensive blur. Skipping only the view's own off-damage painting, allocating rounded geometry only when needed, and safely reusing outer-shadow slices reduce main-thread paint cost while retaining children, clipping and visual behavior.

## Current state

- `crates/nsh-platform-windows/src/render.rs` — view traversal, transform/opacity/layer state, partial-frame areas, pixel-equivalence tests.
- `crates/nsh-platform-windows/src/decor.rs` — background, border, shadow bitmaps and `BoxShape`.
- `crates/nsh-platform-windows/src/decor/cache.rs` — thread-local 96 MiB decoration LRU, also used for conic gradients.
- `crates/nsh-platform-windows/src/gfx.rs` — device generation; no `ID2D1GeometryRealization` usage at this revision. Do not change it.
- `docs/dev/windows.md` — canonical Windows partial-frame and decoration behavior; `docs/dev/performance.md` — baselines.

`render.rs:725-742` already computes the view's own painted area (`own_area`,
including shadows/effects) before its early skip:

```rust
let own = crate::compose::map_bounds(&world.to_3x2(), &own_area(&state));
// ...
if let Some(damage) = &cx.damage
    && !damage.iter().any(|d| intersects(&own, d))
    && state.natives.is_empty()
    && (state.clips() || view.with_children(<[NshView]>::is_empty))
{
    return;
}
```

For non-clipping parents that miss the condition, `draw_view` continues through opacity handling, `decor::draw_layered` or `draw_content`. `draw_content` (`render.rs:929-1022`) interleaves backdrop, background, content, children, hosted items, scroll indicators and borders. `own_area` unions native rectangles, but those items actually draw after children and can require separate damage hydration.

Partial frames already use a conservative rectangle clip with at most 24 areas (`MAX_AREAS`, `render.rs:1501-1563`) and widen damage for shader backdrop readers (`with_backdrops`, 1575-1593). Do not change that damage model. The applicable constraint is to skip own painting under `source-over` without changing opacity/layer/compositing or descendant traversal; an off-damage view cannot be dropped as a whole.

`BoxShape::new` (`decor.rs:372-386`) currently creates a rounded `ID2D1Geometry` whenever a radius is nonzero:

```rust
let geometry = round
    .then(|| cx.rounded_geometry(rect(inset, inset, w, h), radii))
    .flatten();
```

But `fill` uses `FillRectangle` or `FillRoundedRectangle` for uniform radii, needing the geometry only for non-uniform corners or explicit clipping (`decor.rs:388-404`). `draw_background` currently reads `shape.geometry` directly and takes it when several fills need one clip (`decor.rs:277-313`).

Shadow keys include `w`, `h`, radii, border widths, dx/dy/spread/blur/color/cut and scale (`shadow_key`, `decor.rs:445-466`). `outer_shadow` bakes a shaped blur and, for a normal CSS outer shadow, cuts out the rounded box before drawing one bitmap (`decor.rs:485-530`). Insets are a separate path and must remain sized. `MAX_BAKE` is 4096 pixels per side (`decor.rs:441`); large bakes are resolution-reduced and should not automatically switch algorithms.

`decor/cache.rs:35-45,109-120` uses a monotonic `clock` as LRU `used`. A miss inserted late in a frame and immediately crossing 96 MiB can evict bytes used earlier in the same frame to reach 64 MiB. It has no frame marker and no cache unit tests. The cache is also used by `decor/gradient.rs:242-267`, so any pin/eviction change must be generic and bounded, not shadow-only.

Existing evidence is unusually strong:

- `render.rs:2044-2109` (`a_partial_frame_draws_what_a_whole_one_does`) draws whole, applies move/color/removal damage, then compares BGRA bytes with a fresh whole frame. Its `view`, `target`, `read` helpers are reusable.
- `render.rs:2276-2309` checks clipping and child bounds; 2331-2374 checks layer bounds.
- Windows screenshots exist through `nsh test <entry> --target windows` with `await app.screenshot("path.png")`, including background windows. `render::snapshot` provides the same offscreen Direct2D path.
- `docs/dev/pitfalls.md:374-377` identifies an existing Android smallest-box + nine-slice shadow strategy; it supports the shape direction but is not a Windows pixel-equivalence proof.

Fork conventions to follow:

- Rust comments explain why; context parameters are `cx`; new `unsafe` code has a `// SAFETY:` explanation; private implementation stays private/`pub(crate)`.
- No needless allocation on hot paths, no gratuitous hash-map state, no changes to the retained view model or public APIs.
- Partial-frame correctness means the old pixels plus clipped repaint equal a fresh whole frame, including opacity, overlapping siblings, overflow, shadows and clips.
- Nine-patch is conditional on proof using the existing Windows pixel/screenshot path. Do not ship it based on conceptual equivalence alone.
- A performance change keeps measurements outside CI budget assertions, but records the exact host, build and repeated before/after comparisons in `docs/dev/performance.md`.

## Commands you will need

Run serially from `E:\code\mine\nsh-pr` on Windows with the documented MSVC/SDK/LLVM prerequisites.

| Purpose                 | Command                                                                                                                                                                                                                                    | Expected on success                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Drift/cleanliness       | `git diff --stat f0b4659e..HEAD -- <scope>`; `git status --short`                                                                                                                                                                          | understood drift; clean tree                                       |
| Format                  | `cargo +nightly fmt --all -- --check`                                                                                                                                                                                                      | exit 0                                                             |
| Focused pixel tests     | `cargo test -p nsh-platform-windows partial_frame -- --nocapture`                                                                                                                                                                          | all matching tests pass                                            |
| Cache tests             | `cargo test -p nsh-platform-windows decor::cache -- --nocapture`                                                                                                                                                                           | all cache tests pass                                               |
| All Windows tests       | `cargo test -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app`                                                                                                                                                                | exit 0                                                             |
| Full tests              | `cargo test --workspace`                                                                                                                                                                                                                   | exit 0                                                             |
| Windows lint            | `cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app --all-targets -- -D warnings`                                                                                                                                 | exit 0                                                             |
| Full lint               | `cargo clippy --workspace --all-targets`                                                                                                                                                                                                   | exit 0                                                             |
| CLI build               | `cargo build --release -p nsh-cli`                                                                                                                                                                                                         | exit 0; `target\release\nsh.exe` present                           |
| Gallery trace           | `target\release\nsh test examples\gallery\App.tsx --trace`                                                                                                                                                                                 | scripted gallery entry completes; record ops/items/timings         |
| Real Windows screenshot | `echo 'await app.setColorScheme("light"); await app.screenshot("C:\\Users\\Y\\AppData\\Local\\Temp\\plan-018-light.png"); await app.setColorScheme("dark"); await app.screenshot("C:\\Users\\Y\\AppData\\Local\\Temp\\plan-018-dark.png")' | target\release\nsh test examples\gallery\App.tsx --target windows` | light/dark PNGs in temp |
| Profile                 | `python3 examples/gallery/tools/perf.py --nsh target/release/nsh.exe --only Stocks,Canvas --seconds 4`                                                                                                                                     | completed readings; `paint`/`canvas` phases logged                 |

For a specific gallery fixture, set `NSH_GALLERY_DEMO` and `NSH_GALLERY_SECTION` in the environment, using the gallery's own `examples\gallery\App.tsx:721-750` launch selection. `--filter` is a test-name filter, not a general scripted-entry demo selector. Use `target\release\nsh test --help` if uncertain; do not introduce custom scripts into the repository.

## Scope

**In scope**:

- `crates/nsh-platform-windows/src/render.rs`
- `crates/nsh-platform-windows/src/decor.rs`
- `crates/nsh-platform-windows/src/decor/cache.rs`
- `crates/nsh-platform-windows/src/shader.rs` — test-only observer seam
  for fixture 6: it must capture the `pixels` buffer that `shader::give`
  hands to `view.set_input` (`shader.rs:798-822`). Add a
  `#[cfg(test)]`-scoped capture hook (a `thread_local!` cell with a
  `set_capture(fn(&[u8]))`/`take_capture()` pair near `give`) so the
  fixture can read the bytes the shader receives without changing the
  production signature. **Anything beyond a `#[cfg(test)]` seam in this file
  is a STOP.**
- `crates/nsh-platform-windows/src/decor/shadow.rs` — create only if nine-patch needs a cohesive private implementation/composition helper and `decor.rs` becomes the wrong seam; do not split the initial skip or lazy-shape steps for file-size reasons.
- `docs/dev/windows.md`
- `docs/dev/performance.md`

**Flow index only**:

- `E:\code\mine\oflow\plans\README.md` status row; format it with `E:\code\mine\oflow\node_modules\.bin\vp fmt plans/README.md` from the Flow repo, unless the dispatching reviewer owns it.

**Out of scope**:

- `canvas.rs`, `nsh-core/src/canvas/damage.rs` and other platform backends; plan 017 owns canvas replay.
- `gfx.rs`, `surface.rs`, `view.rs`, `decor/layer.rs`, `decor/gradient.rs` (cache call sites may be exercised by generic tests; do not change them).
- `shader.rs` outside the test-only observer seam above: do not modify `take_backdrop`, `give`, `reads`, renderer dispatch or any production path.
- `ID2D1GeometryRealization` caching and multi-rectangle damage; explicitly deferred.
- Inset-shadow nine-patch, blurred borders and content shadows; keep the original implementation.
- Public rendering APIs, examples, generated declarations, `Cargo.toml` and lockfiles.
- Flow source and the pinned NSH revision in `src/native/Cargo.toml`.

## Git workflow

- Branch from the chosen NSH base: `git switch -c advisor/018-nsh-partial-frame-paint`.
- Commit units: (1) off-damage own-paint skip, (2) lazy `BoxShape` geometry, (3) same-frame cache protection, (4) nine-patch only if its proof passes, (5) documentation/measurements.
- Use NSH's commit style `windows: <Capitalized imperative>`, not conventional `perf:` / `fix:`. Actual example: `f0b4659e windows: Draw a canvas's changed area only while its values animate`. Suggested: `windows: Skip view decoration outside a partial frame`.
- The body explains the invariant and contains exact before/after Windows performance numbers, wrapped at 72 columns.
- No AI attribution in commits. Do not push or open a PR.

## Steps

### Step 1: Add partial-frame counterexamples as regression tests

Before refactoring traversal, create a test helper in `render.rs::tests` for `fill_with_damage_and_compare_whole(surface, size, areas)`. Start from a fresh whole-rendered bitmap, apply a known damage rectangle set using the same `draw_into(..., Some(areas), ...)` route as production, render a fresh whole bitmap, and compare all BGRA bytes. Copy the existing `a_partial_frame_draws_what_a_whole_one_does`, not a wall-clock benchmark.

Add these fixtures with a non-clipping parent that has children and its own background, border and outer shadow:

1. damage intersects the parent's own painted region but not one of its children: parent's own decoration must remain, child cannot disappear;
2. damage intersects only the child: traversal must reach the child and read any visual backing correctly;
3. sibling/overflow cases: a child extends outside a parent whose own area has no damage;
4. rounded clipping, opacity below 1, transform (including translation/scale and one projective-transform control), and a backdrop-filter/blend-mode control;
5. hosted/native control: confirm its own area and item-draw ordering still hydrate the damage; if a test needs production-only native plumbing, describe the gap and add a host scripted case rather than faking it out of the test.

Add a sixth fixture specifically guarding the backdrop-reader contract that Step 2 must preserve (see Step 2 for the mechanism):

6. **partial-child-only update with a parent that reads a backdrop**: a parent `NshView` whose shader reads `ShaderInput::Backdrop` (`shader.rs` `reads(ShaderInput::Backdrop)`), with a child that takes a color/slot change. Compute damage so the parent's own painted area misses every damage rect but the child is intersected. Run the partial pass, capture the bitmap the parent's shader reads (the `pixels` buffer `shader::give` hands to `view.set_input`, `shader.rs:798-822`), then render a fresh whole frame and capture the same buffer; every BGRA byte must match. Include a sub-case where the off-damage parent has a further descendant below it that also reads a backdrop, so the probe proves off-damage filtering does not strand deeper backdrop readers either.

The off-damage-child fixture should fail if an implementation returns for the entire parent; the sibling shadow fixture should fail if it skips the parent's damage-crossing shadow; the sixth fixture should fail if the implementation stops calling `shader::take_backdrop` for an off-damage backdrop reader. A baseline whole-frame byte mismatch is a blocker, not a regression to excuse.

In addition to the pixel tests, add a focused call/counter probe around the parent's decoration path that counts invocations of `decor::draw_backdrop`, `decor::draw_background`, and the outer-shadow bake inside `decor::draw_layered` (or the equivalent existing seams). Expose these counters through a `#[cfg(test)]`-only global or a thread-local read/reset pair in `decor.rs`; do not change the production signature of any decoration entry point. For the off-damage-parent fixture the predicate pass must leave every counter at zero invocations from this view's path; for the in-damage-parent fixture (shadow bounds intersect damage) every counter must record a nonzero invocation. Require an intentional **pre-change failing run** of this probe against the unmodified `render.rs`: build with the probe and Step 1 fixtures on a tree where Step 2's suppression has NOT yet been wired in, observe that the off-damage-parent case currently DOES invoke the decoration entries (i.e. the "skip" has not happened yet, so the counter shows the baseline cost) and the in-damage-parent case also invokes them; document both counts in the test's doc comment. When Step 2 lands, the off-damage-parent count must drop to zero while the in-damage-parent count must stay unchanged. This failing-first recipe is the proof that the probe actually measures the suppression and not just the absence of work in general.

**Verify**: `cargo test -p nsh-platform-windows a_partial_frame_draws_a_child_without_repainting_its_parent -- --nocapture` → new fixture fails on an unguarded whole-parent skip prototype or proves the requirement on unchanged code; `cargo test -p nsh-platform-windows a_partial_frame_applies_backdrop_readers_with_off_damage_parent -- --nocapture` → fixture 6 fails when `take_backdrop` suppression would strand a backdrop reader; the call/counter probe's failing-first run preserves its doc-commented baseline counts; the baseline control `cargo test -p nsh-platform-windows a_partial_frame_draws_what_a_whole_one_does` → passes.

### Step 2: Skip only the view's own painting, preserving subtree semantics

Implement a private `own_paint_needed(cx, &own)` query: true when no damage is active, when any damage rect intersects `own`, and conservatively for views whose hosted items, projective transforms, blending/backdrop or unknown painted extent make skipping unsafe. In `draw_view`, when the query is false, continue traversal as normal but suppress the view's own backdrop/background/shader/content/border/scroll-indicator draws; do not drop its children, contextual transform/opacity, clipping, composition state or `set_painted` bookkeeping.

**Critical exception — backdrop readers must still be hydrated.** `draw_content` (`render.rs:929-932`) calls `crate::shader::take_backdrop(cx, view)` BEFORE the background/shadow/shader draws. `take_backdrop` reads the pixels already drawn under the view's box + overflow from the back buffer and hands them to the view's shader via `give(view, input, &pixels)` (`shader.rs:798-822`), which `set_input`s the shader. Skipping this on a backdrop-reading view whose pixels happen to land in the off-damage fast path would leave that shader reading the previous frame's stale backdrop — the elder sibling or parent it overlays may have already been repainted, but `take_backdrop` is the hydration step that reconstructs the pixels the shader samples. Therefore:

- for any view whose shader currently reads `ShaderInput::Backdrop` (probe via `view.state().shader.as_ref().is_some_and(|s| s.renderer.is_some() && s.reads(ShaderInput::Backdrop))`, mirroring the predicate `backdrop_areas` already uses at `shader.rs:836-840`), call `crate::shader::take_backdrop(cx, view)` on the off-damage path as well, at the same point in the traversal ordering as the original `draw_content` does (i.e. BEFORE background/shader would run, BEFORE descending into children);
- or, if preserving traversal order is impractical under the suppression shape, take the original whole-view path for backdrop readers instead of the fast path: that is a legal narrowing of the fast path, not a regression;

but never both skip own paint AND skip `take_backdrop` for a backdrop reader. Pick ONE of the two options above at implementation time and document the choice in the commit body. Fixture 6 from Step 1 (partial-child-only update with a backdrop-reading parent, plus the deeper-descendant variant) is the test that catches the wrong choice; it must pass before Step 2 is considered landed.

Leave the existing hidden/backface/projective subtree-painted bookkeeping untouched. A view that was already projecting an unknown subtree area must not be taught to infer visibility from ancestors in this optimization.

Keep this small by separating `draw_content` into own painting and descendant painting at the existing seams, or by adding an explicit own-paint mode/lambda passed at the call site. Do not add a parallel scene walk. In particular:

- opacity must still apply as one group to descendants; cannot skip `push_opacity` merely because the own decoration is hidden;
- clipping views must keep their clip while descending; overflow children must remain visible;
- `cx.realize` / composed web-view transitions and `Native.item.draw` ordering must remain intact;
- blend/backdrop/filter/3D cases must retain the conservative original whole-view/subtree approach unless an explicit proof and test says otherwise — for backdrop readers this conservatism is enforced by the `take_backdrop` exception above, not by an unguarded fast path;
- unchanged whole-frame behavior must not be altered.

Assert `state.natives.is_empty()` for the eligible fast path unless a later test proves hosted item separation. The original `(state.clips() || no children)` early return stays valid, but the new path is what handles a non-clipping parent with children.

Verify the suppression with Step 1's counter probe: re-run the same off-damage-parent and in-damage-parent fixtures and confirm the off-damage-parent decoration-invocation count is now zero while the in-damage-parent count is unchanged from the doc-commented baseline. The probe must run against the binary actually built with Step 2 installed; an unchanged counter means the suppression did not wire in.

**Verify**: `cargo test -p nsh-platform-windows partial_frame -- --nocapture` → every old/new partial test passes with exact BGRA equality; `cargo test -p nsh-platform-windows a_partial_frame_applies_backdrop_readers_with_off_damage_parent -- --nocapture` → fixture 6 passes; `cargo test -p nsh-platform-windows children_outside_the_visible_area_are_hidden -- --nocapture` → passes; `cargo test -p nsh-platform-windows a_layer_covers_what_the_children_draw -- --nocapture` → passes; the decoration-invocation counter probe drops to zero off damage and matches baseline in damage.

### Step 3: Make `BoxShape` rounded geometry lazy

Change `BoxShape::new` to store `cx` accessor inputs or a private lazily evaluated geometry field without retaining an illegal borrow. A straightforward option is `RefCell<Option<Option<ID2D1Geometry>>>` plus a `geometry(&self, cx) -> Option<ID2D1Geometry>` method that computes only for rounded shapes and caches within this short-lived shape. `draw_background` may take/cloned-hold the returned geometry for its multi-fill clip; `fill` requests it only in the non-uniform-corners branch.

Keep `radii` semantics after clipping (`shape.radii = [0.0; 4]`) intact. Do not allocate rounded geometry for a uniform solid fill, even with rounded corners. Add unit tests or a diagrammed test seam that distinguishes these three cases: uniform solid fills do not request a geometry; non-uniform fills request one once; multi-fill clipping requests it once and does not request the discarded geometry again after `take`.

**Verify**: `cargo test -p nsh-platform-windows decor::tests -- --nocapture` → old decoration and new lazy-geometry tests pass; `cargo test -p nsh-platform-windows partial_frame -- --nocapture` → exact pixel equivalence remains green. Commit this independently.

### Step 4: Stop evicting decoration used in the current frame

Add a small thread-local frame token to `decor/cache.rs`: a guarded `frame()` probe/increments frame id, or a render-pass scope in `render.rs` if needed. `get_or_make` records `seen` frame id separately from the existing LRU `used`. Eviction must prefer entries not seen in the current frame; only when no such candidate exists may it evict pinned bytes as an emergency memory-bound escape. A frame probe that updates only on `get_or_make` is acceptable only if it also gives newly inserted entries the same id as reads earlier in that paint; no resetting each miss into a distinct frame.

Avoid unbounded recursion: `make` retains the current no-cache-reentry rule. A render-pass RAII token must cover nested offscreen painting and snapshots; it must reset on normal and early returns, not depend on global mutable state crossing threads. Test nested probes directly.

Add tests in `decor/cache.rs::tests` with small byte limits, synthetic `Baked` entries and test-only inspection:

- recent current-frame entries retained while older entries are evicted to the low threshold;
- insertion after the threshold does not pick an earlier same-frame entry if an unpinned victim exists;
- when every cached byte is current, emergency eviction still bounds memory and preserves the newly returned value as normal;
- the cache remains bounded after the next frame; device generation reset remains correct;
- no shadow-specific key changes in this unit.

Use existing `Gfx` and `Baked` construction patterns or a narrowly scoped test constructor that records deterministic dimensions; do not require a gallery to make the eviction order deterministic.

**Verify**: `cargo test -p nsh-platform-windows decor::cache -- --nocapture` → all new eviction probes pass and each test cleans its cache state; `cargo test -p nsh-platform-windows partial_frame -- --nocapture` → unchanged pixels.

### Step 5: Define supported outer-shadow shapes and a byte-exact reference route

Create private helpers `outer_shadow_reference` (the existing `outer_shadow` algorithm) and a new nine-patch implementation. Keep reference behind `#[cfg(test)]` if production no longer uses it. If a cohesive private implementation/composition helper would not fit inside `decor.rs`, place it in the optional `crates/nsh-platform-windows/src/decor/shadow.rs` (the drift list already permits that path); this is the only additional new file this plan allows without a STOP-and-replan. Start with `cut == true`, positive final shape dimensions, normal opaque/transparent shadow colors, blur/spread/offset at a supported scale. Do not optimize insets. Keep original path for:

- dimensions exceeding the bake limits or requiring `bake_scale` below the DPI scale;
- non-finite/negative effective origins/dimensions, extreme spread or degenerate shapes;
- transformed render parameters that make the current cached bitmap interpretation invalid;
- any mixed/corner-dependent behavior that does not fit a supported nine-patch decomposition.

Use the Android smallest-box precedent as an algorithm lead, but require actual Windows proof. The simplest eligible case is four **equal effective final-shape** corner radii. "Effective final shape" is precise: `outer_shadow` at `decor.rs:486-505` first grows the requested radii by the spread (`radii.map(|r| grown(r, s))` at line 505, where `grown(r, d) = if r > 0 { (r + d).max(0) } else { 0 }` at `decor.rs:862-864`), then passes the grown radii AND the spread-enlarged shape rectangle (`rect(spec.dx - s, spec.dy - s, w + 2s, h + 2s)` at line 488) into `crate::render::rounded_geometry`, which re-clamps each radius to `min(shape.width, shape.height) / 2` at `render.rs:633-634`. So:

- two ViewState inputs with identical radii but different spreads can yield different effective final radii (because `grown` adds `s` uniformly when `r > 0` and returns `0` else);
- two ViewState inputs with identical grown radii but different spreads can yield different effective final radii (because `rounded_geometry`'s clamp is against the spread-enlarged shape's `min(w,h)/2`, so a small spread on a short shape can trigger the clamp uniformly while a large spread on a tall shape does not);
- a shape whose effective final radii are equal after `grown` AND after `rounded_geometry`'s clamp is the only eligible case; an input whose `ViewState::radii` happen to be equal but whose `grown(...)` or final-clamped values differ is NOT eligible and must stay on the original whole-bitmap route;
- any sub-minimum shape where the half-min-side clamp fires to zero on any corner produces nonuniform / zero effective corners and must retain the original bitmap.

Concretely: classify the shape AFTER computing `let shape = rect(spec.dx - s, spec.dy - s, w + 2.0*s, h + 2.0*s)` and AFTER `let shape_radii = radii.map(|r| grown(r, s))` and AFTER simulating `rounded_geometry`'s half-min-side clamp (i.e. compute `let max = (shape.w.min(shape.h) / 2.0).max(0.0)` and `let final_radii = shape_radii.map(|r| r.clamp(0.0, max))`, exactly mirroring `render.rs:633-634`). Only when `final_radii[0] == final_radii[1] == final_radii[2] == final_radii[3]` AND that common value is `> 0` (or all four are `== 0` for the uniform-square special case, which is orthogonal and may be left on the original route) does the nine-patch apply. Key tiles on this `final_radii[0]` (the effective final radius), on `bake_scale`, on the blur/spread/color spec, and on the destination-only cutout radius — never on the raw `ViewState::radii`. Keep the original renderer for spread-grown or sub-minimum shapes that yield nonuniform / zero corners; this is not an approximation case.

For an eligible shape, bake one smallest symmetric outer-shadow bitmap without the transparent box cutout: it contains corners and enough straight center span to slice exactly. Distribute it through these routes:

- **Direct2D source-rectangle sprites**: face the actual windows-crate declaration rather than the example already in the codebase. The compiled `windows-0.62` crate (this repo pins `windows = "0.62"` at the workspace root `Cargo.toml:152`) declares `ID2D1DeviceContext::DrawBitmap` (and the identical `ID2D1DeviceContextN` variants) as:

  ```rust
  pub unsafe fn DrawBitmap<P0>(
      &self,
      bitmap: P0,
      destinationrectangle: Option<*const Common::D2D_RECT_F>,
      opacity: f32,
      interpolationmode: D2D1_INTERPOLATION_MODE,
      sourcerectangle: Option<*const Common::D2D_RECT_F>,
      perspectivetransform: Option<*const windows_numerics::Matrix4x4>,
  ) -> windows_core::Result<()>
  ```

  (see, in the locally vendored registry, `windows-0.62.2/src/Windows/Win32/Graphics/Direct2D/mod.rs` near line 3397 / 5002 — confirm against the version actually locked in the local `Cargo.lock` and cite its path in the commit body). The `sourceRectangle` slot takes `&D2D_RECT_F` (or `None`), NOT a `Matrix4x4`; `perspectiveTransform` takes `&Matrix4x4` or `None`. The existing `read_back` helper starts at `render.rs:1222`; grep its body for `DrawBitmap` to see the example that passes `Some(&dest)` as `destinationrectangle`, `None` as `sourcerectangle`, and `Some(&m.to_d2d())` as `perspectivetransform`: that example drives the source rect through the IDENTITY implicitly coded by `sourcerectangle: None`, NOT a typed source crop. The new nine-patch call MUST pass an explicit `Some(&D2D_RECT_F { left, top, right, bottom })` in the `sourcerectangle` slot for any non-identity source crop and `None` in `perspectivetransform`. Do not infer source-rectangle semantics from the example's matrix slot — that example is doing a different job and would silently produce wrong pixels if copied for the nine-patch use case.

  Decide identity copy vs source-pixel crop with a concrete square-pixel proof: confirm `cx.scale` encodes a uniform DPI scale (search `cx.scale` assignment sites and the `bake_scale` helper at `decor.rs:470-483` to confirm the bake uses one scalar for both axes; reject anisotropic scales) AND confirm the cached bitmap's pixel density equals `device_dip * cx.scale` (i.e. square pixels, no source-side subpixel stretch) before any identity-1:1 tile copy. Record this proof in the commit body. If exact sampling cannot be established for the supported shape at a given scale, fall back to the original whole-bitmap route for that case rather than approximating.

- **Nine actual cached bitmap slices** of the smallest blur render: corners and straight edge strips at device scale. Keep them under one shape-generation cache entry (not 9 separately visible top-level entries), with `Baked` dimensions derived from source pixels, and avoid nine independent blurs.

Scale each tile by `cx.scale`; never stretch a corner along its arc. Offset and spread are already in the shape geometry: they change baked tile contents and stay in the key. w and h are the destination placement/cutout, NOT the baked tile key; the effective FINAL radius described above is the tile key, not the requested `radii`. Do not call `fit_corners` a second time inside the new helper: `ViewState::radii` (`view.rs:238-257`) has already clamped to the box, and the new helper consumes the `outer_shadow`-side `grown(...) + rounded_geometry`-equivalent transform as its single classification. Never remove w/h from the original legacy path's cache key: that path stays correct, only the new nine-patch key changes.

Crucially, do not stretch the old center-cut bitmap whole: the box-shaped transparent center would become the wrong size. Assemble the blurred outer alpha shape from slices first, then subtract the **actual destination-size rounded box** using `D2D1_COMPOSITE_MODE_DESTINATION_OUT`. Use `layer::with_context`-style offscreen composition without editing that module, and the existing `record_fill`/bake conventions. Add enough transparent outer padding to preserve the blur, and preserve premultiplied BGRA semantics for translucent colors. Composite all layers in their existing reverse order.

Verify the support contract from `render::rounded_geometry` (`render.rs:618-…`, esp. the half-min-side clamp at 633-634) and the `grown` + spread shape computation in `outer_shadow` (`decor.rs:486-505`) before proceeding; a disagreement between the new helper's classification and what `rounded_geometry` would do is a STOP condition.

**Verify**: `cargo test -p nsh-platform-windows outer_shadow_slices_match_the_reference -- --nocapture` → byte-identical rectangles across at least two sizes at the same effective-final-radius/shadow spec, initially failing if compositing/cutouts differ; the proof-and-classify step above must reject spread-grown nonuniform and sub-minimum cases in unit assertions on the classification helper itself (a tiny pure function test that takes `w, h, radii, spec` and asserts which route is chosen). The real screenshot path exists, so the advisor's nine-patch precondition is satisfied; proceed only with this test green.

### Step 6: Prove nine-patch equivalence across supported shapes before enabling it

Add a matrix covering **uniform radii first**, zero and nonzero spread, blur 0 and positive blur, fractional geometry, 1× and 1.5× scales, a very small target, and an elongated target. Include asymmetric radii only as controls proving that they retain the original route unless a demonstrated separable decomposition exists. Compare every BGRA byte of `outer_shadow_reference` to sliced output rather than accepting only visually plausible images. Test the premultiplied alpha bytes of a translucent shadow and its box cutout directly; a background-color composite is not sufficient. One golden per shadow shape may miss a stretched seam, so test two outer box dimensions with the same shape key.

Key/rendering invariants:

- equal key with different w/h reuses only tiles permitted by the coarse-grained shadow/blur mathematics; hash collisions must not mix different radii/specs;
- changing any blur/spread/radius/color/scale alters the applicable tile key;
- origin placement remains point-snapped like the current route; no extra subpixel drift;
- multi-shadow order unchanged; fallback and original render bytes unchanged.

If the exact comparison cannot be made green after two focused fixes for a supported shape, narrow support to provably uniform corners (or defer all nine-patch) rather than accepting an approximation. If uniform-only still differs, revert the new path and retain Steps 2–4.

**Verify**: `cargo test -p nsh-platform-windows outer_shadow_slices_match_the_reference -- --nocapture` → whole matrix passes exactly; `cargo test -p nsh-platform-windows a_partial_frame_draws_what_a_whole_one_does` → pixel equality retained.

### Step 7: Run real visual comparisons and measure the full result

Before/after render tests now prove low-level pixels, but maintainers also need actual Windows images. Build the optimized CLI, capture gallery Canvas and representative card/shadow demos at light and dark appearance, including fractional zoom/scale and resize. Save screenshots into a temporary directory, not the repository. Compare them against images from the baseline `f0b4659e` CLI at equivalent state.

**Acquire the baseline executable (required).** Use a separate detached worktree at `f0b4659e` so the baseline binary cannot be clobbered by your branch:

```
# From E:\code\mine\nsh-pr, on a clean tree:
git worktree add --detach E:\code\mine\nsh-baseline-018 f0b4659e
cd E:\code\mine\nsh-baseline-018
cargo build --release -p nsh-cli
mkdir -p C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e
copy target\release\nsh.exe C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\nsh.exe
git rev-parse HEAD > C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\REVISION.txt
```

(If Plan 017 Step 5 has already populated that baseline directory with the same `REVISION.txt` content — `f0b4659e7f1b3f10174905add6096f86ed3736cb` — you may reuse it; do NOT overwrite a baseline produced by a different revision.) Keep the worktree in place until Step 8's gates pass.

**Collect raw logs with an external read-only collector.** `perf.py --help` is not evidence: it prints the docstring and exits 0 regardless of whether any measurement worked. `perf.py`'s JSON output stores only per-phase MEANS (`perf.py:184`); the per-second `name mean/p50/p95/max` strings survive only in the stdout stream that `perf.py` writes to `examples/gallery/.nsh/perf/log.txt` (`perf.py:199`), which is truncated on the next invocation. Write a small Python script OUTSIDE both repositories, e.g. `C:\Users\Y\AppData\Local\Temp\claude\collect-perf-018.py`, that:

1. invokes `python3 E:\code\mine\nsh-pr\examples\gallery\tools\perf.py --nsh <baseline-or-new> --only Stocks,Canvas --seconds 4 --size 1200x800 --out <path-under-temp>` via `subprocess.run`;
2. immediately after each invocation, copies `E:\code\mine\nsh-pr\examples\gallery\.nsh\perf\log.txt` to a unique file under `C:\Users\Y\AppData\Local\Temp\claude\plan-018-logs\<timestamp>-<baseline|new>-<run>.log.txt`;
3. parses `frame ...`, per-phase `mean/p50/p95/max`, and `items` using `perf.py`'s own grammar (the `LINE` regex at `perf.py:44-49` and the `PHASE` regex at `perf.py:50`);
4. aggregates per `(scenario, phase)` across at least 3 baseline runs and 3 new-build runs, alternating baseline/new/baseline/new..., reporting each cell with nearest-rank p95 (computed on the sorted list of per-second p95 values, not on the mean of means) and a sample count `n`.

The collector is temp-only and is not committed.

Run the paired stock/canvas host measurements at least three alternating times per revision, driving each binary through the same unchanged gallery bundle (do NOT edit `examples/gallery/App.tsx`, `examples/gallery/tools/perf.py`, or any gallery fixture during the comparison; remove any temporary Step-5 probe fixture before measuring). Record paint p50/p95/max, canvas share, frame percentage and the commit op/mount-item counts. Mount ops/items come from separate `nsh.exe test examples\gallery\App.tsx --trace` invocations against both binaries (NOT from `perf.py`), and must match exactly — a difference is a STOP condition.

Resize evidence: include a card-like resize fixture via a maintainer-provided existing gallery path if available; if no such path exercises resize in the gallery workload, record resize-cache reuse through a deterministic synthetic probe (e.g. a `NshView` driven through repeated `frame.size` changes in a unit test) and label the resulting section in `docs/dev/performance.md` EXPLICITLY as "synthetic reuse metric only, missing real-host resize coverage" — the honest gap is preferable to a misleading number, and the label is a verbatim string a reviewer can grep.

Document that off-damage own paint is skipped conservatively (with the Step 2 backdrop-reader exception), `BoxShape` allocation is lazy, current-frame cache entries are preferred retention candidates, and exactly which outer shadows use slices (driven by the effective final radius classification, never by the raw `ViewState::radii`). Record unsupported shapes and measured evidence in `docs/dev/performance.md`, with CPU/GPU, DPI scale and release profile.

**Verify**: `Test-Path C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\nsh.exe` → `True`; `REVISION.txt` starts with `f0b4659e7f1b3f10174905add6096f86ed3736cb`; the external collector leaves at least three `*-baseline-run*.log.txt` and three `*-new-run*.log.txt` under `C:\Users\Y\AppData\Local\Temp\claude\plan-018-logs\`; the aggregated JSON reports nearest-rank p95 and `n` for every `(scenario, phase)` cell; `--trace` against both binaries produces byte-identical ops/items lines; the synthetic-resize coverage label is verbatim in `docs/dev/performance.md` when applicable; `cargo +nightly fmt --all -- --check` exits 0 after docs updates.

### Step 8: Complete gates, CLI build and Flow plan index

Run formatting, all Windows tests, `cargo test --workspace`, the Windows and full workspace clippy gates, then `cargo build --release -p nsh-cli`. Do not claim a successful nine-patch if its tests or visual comparison were skipped: in that case its implementation must not remain enabled, and the final result is only own-paint skipping, lazy shape and cache retention, with the deferred nine-patch noted.

Update the Flow `plans/README.md` row and format it when responsible. Flow picks up no native-crate change until its maintainer pushes/accepts the fork work and bumps both NSH revision pins in `src/native/Cargo.toml`; plan measurement in Flow only after that separate change. A locally rebuilt CLI can exercise the view host but does not update the app's pinned Rust core.

**Verify**: `git diff --check` → no output; `git status --short` → only permitted files plus assigned Flow index; `Test-Path target\release\nsh.exe` → `True`; all above gates exit 0.

## Test plan

New tests by file and case:

- `crates/nsh-platform-windows/src/render.rs` — partial-only child repaints, off-damage parent decoration, shadows/outlines entering damage, clipping/overflow, opacity, hosted-item control, whole-vs-partial byte comparisons; use existing `a_partial_frame_draws_what_a_whole_one_does` helpers. Add `a_partial_frame_applies_backdrop_readers_with_off_damage_parent` (fixture 6) for the backdrop-reader preservation case, including the deeper-descendant variant. Add a decoration-invocation counter probe (a `#[cfg(test)]` scoped counter around `decor::draw_backdrop`, `decor::draw_background`, and the outer-shadow bake) with a doc-commented pre-change failing-first run on the unmodified parent path.
- `.../decor.rs` — lazy geometry call counts; `outer_shadow_slices_match_the_reference` for dimensions, effective-final radii, spread, blur, offset, scaling, translucency, ordering and fallback; `shadow_keys` extended to changed appearance/shape inputs. Add a small pure-function test for the Step 5 route classifier that takes `(w, h, radii, spec)` and asserts which route is picked, including cases that probe: identical `ViewState::radii` but non-equal `grown(...)` (nonzero spread), identical `ViewState::radii` and equal `grown(...)` but unequal `rounded_geometry` clamp (sub-minimum side), and the eligible uniform-effective-final-radius case.
- `.../decor/cache.rs` — deterministic same-frame retention, emergency escape, next-frame reclamation, nested scope/probe and device-generation behavior. When `gfx::generation()` increments during a test, restore the prior value before the test returns so subsequent tests do not clear their cache unexpectedly; expose the narrowest test-only setup/inspection seam.
- Real-host `nsh test <entry> --target windows` screenshots are supporting evidence; they do not replace exact pixel tests.
- Verification: `cargo test -p nsh-platform-windows`, `cargo test --workspace` → all pass; new cases show exact pixels and unchanged public API.

## Done criteria

- [ ] Format, full Rust tests, Windows clippy and full workspace clippy all exit 0.
- [ ] `cargo build --release -p nsh-cli` exits 0; `target\release\nsh.exe` exists.
- [ ] A parent whose own decoration misses every damage rect does not invoke its own decoration path, yet a damaged child repaints; tested by exact BGRA output AND by the Step 1 counter probe dropping to zero off damage while matching the doc-commented baseline count in damage.
- [ ] A parent or deeper descendant whose shader reads `ShaderInput::Backdrop` keeps `shader::take_backdrop` hydrated on the off-damage path (or takes the original whole-view path); fixture 6 (`a_partial_frame_applies_backdrop_readers_with_off_damage_parent`) produces byte-equal shader-input pixels vs a fresh whole frame.
- [ ] Rounded `BoxShape` geometry is not requested for uniform fills and is requested at most once for multi-fill/non-uniform clips.
- [ ] Cache tests demonstrate no available current-frame entry is chosen before an unpinned victim under pressure, without unbounded retention.
- [ ] Either: all supported sliced outer-shadow matrices produce exact reference BGRA bytes, the route classifier is unit-tested against spread-grown and sub-minimum shapes, and key proof exists on the effective final radius; or nine-patch is absent/reverted and the deferred reason is recorded in the plan/maintenance report.
- [ ] All whole/partial pixel comparisons, including clips, opacity, shadows and child overflow, pass; actual light/dark Windows screenshots are captured and reviewed.
- [ ] Before/after release-host traces measure the same workload, with engine op/mount-item counts unchanged and evidence recorded in `docs/dev/performance.md`.
- [ ] Only in-scope files are modified; Flow `plans/README.md` status is updated and formatted if assigned.
- [ ] Commit(s) follow `windows: ...`, carry trace evidence, no AI attribution, and are not pushed.

## STOP conditions

Stop and report (do not improvise) if:

- The current excerpts differ unexplained at execution, the tree is dirty, or a required change falls outside the scope.
- The off-damage optimization would skip opacity group creation, clips, descendants, native/composed drawing, backdrop/filter work, or unknown painted extents. Keep the original path for that case. In particular, any shape of the fast path that fails to call `shader::take_backdrop` for a backdrop reader, OR fails to substitute the original whole-view path for it, is a STOP — fixture 6 makes this byte-visible.
- The Step 1 decoration-invocation counter probe is missing, never failed before Step 2, or its counts do not drop to zero off damage / match baseline in damage after Step 2 — without the failing-first evidence the probe is decoration, not proof.
- The Step 5 / Step 6 route classifier disagrees with the `grown(...) + rounded_geometry` effective-final-radius computation on any input, OR a nonuniform / zero effective corner is mis-classified as eligible for nine-patch.
- The optional `crates/nsh-platform-windows/src/decor/shadow.rs` split turns out to be insufficient and ANY additional new file or module outside the listed scope would be needed.
- Any full-vs-partial byte comparison differs, especially shadow edges, nested clips, translucent parent content, overflow, overlapping siblings or transforms.
- Lazy shape evaluation changes multi-fill `under_border`/radius/clipping behavior or allocates before its measured fast path.
- Frame pinning can retain memory without bound or loses the newly made bitmap; the original 96 MiB hard cap must retain an emergency path.
- The supposed screenshot-test prerequisite is unavailable (contrary to current `render.rs` and Windows test-agent evidence), or nine-patch cannot prove equivalence for a shape after two focused fixes. Finish only Steps 2–4 and record the deferral.
- A nine-patch case needs w/h to compute its blurred tiles rather than only the final cutout/placement, or CSS radius fitting disagrees with slice construction; keep original for that case.
- No D3D/WARP device or real Windows host exists to establish required rendering evidence; report the verification gap rather than marking the rendering change fully DONE.
- Gates fail twice after reasonable focused remediation, measurements materially regress, or generated files/dependencies become necessary.

## Maintenance notes

- Future changes in draw order, hosted/composed views, filters, opacity groups or projective transforms must re-run all new partial-frame tests. The fast path must stay a conservative own-paint skip, never a blanket ancestor skip.
- Any new decorative effect expands `own_area` and its conservative logic; a missing outset could produce stale pixels. Cache retention must continue to cover conic gradients without making frame pinning into an unbounded cache.
- Shadow work intentionally excludes inset shadows, `MAX_BAKE` reduced-resolution sizing, transformed shadows needing a different scale model, `ID2D1GeometryRealization` caching and multi-rectangle damage. Do not combine those with the equivalence-focused change.
- The original reference renderer is kept for tests as an equivalence oracle. If nine-patch cannot be proven exact, only Steps 2–4 are delivered; this is an explicit reduced scope, not permission to ship an approximation.
- Flow adoption requires a later maintainer push/pin revision update for both `nsh-core` and `nsh-platform-windows`, normal lockfile regeneration and then the app's own performance recipe. Do not imply this fork work changes Flow immediately.
