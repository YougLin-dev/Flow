# Plan 017: Record and replay only visible canvas strokes on Windows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Work in `E:\code\mine\nsh-pr`, not the Flow app
> repository. Run builds and tests serially in the main executor session;
> delegate no builds to subagents. When done, update the status row for this
> plan in `E:\code\mine\oflow\plans\README.md` — unless a reviewer dispatched
> you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f0b4659e..HEAD -- crates/nsh-platform-windows/src/canvas.rs docs/dev/canvas.md docs/dev/windows.md docs/dev/performance.md`.
> The app plan was written at Flow `1956ebb`, but this plan executes against
> NSH `f0b4659e`. Compare every "Current state" excerpt against the live file;
> a mismatch is a STOP condition. Also run `git status --short` and require a
> clean tree before branching. Do not treat generated files as source.
>
> **Cross-repo exception**: the only file this plan touches outside
> `E:\code\mine\nsh-pr` is `E:\code\mine\oflow\plans\README.md`, and only if
> the dispatching reviewer has handed the Flow plan index to this executor.
> If a reviewer or the advisor owns the index, do not edit it; report the row
> change to that maintainer instead. No other Flow file may be modified.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; run after the Flow app plans to avoid splitting measurement effort
- **Category**: perf
- **Planned at**: Flow commit `1956ebb`; NSH commit `f0b4659e`; 2026-11-10
- **Execution note (2026-11-11)**: implemented on NSH branch
  `advisor/017-nsh-canvas-replay` as `bc3ffb71` (paint elision), `f9b5c6b7`
  (slot damage index) and `921ef920` (docs/measurements), then fast-forwarded
  into the fork's `feat/windows-canvas-damage`. Flow's pin stays
  `f0b4659e`; the app sees this only after a separate pin bump.
  Gates: `cargo test -p nsh-platform-windows` 220 passed / 1 ignored,
  `cargo test -p nsh-core canvas::damage` 8 passed, the Windows clippy gate
  and `cargo build --release -p nsh-cli` pass, and the release CLI exists.
  Environment limits, reported rather than hidden: the installed nightly
  reformats an untouched base file (`nsh-core/src/core/list.rs:3033`), so
  `cargo +nightly fmt --all -- --check` cannot exit 0 on this toolchain while
  the changed `canvas.rs` passes; `cargo test --workspace` and the combined
  three-crate invocation fail with pre-existing target/toolchain metadata
  errors (`E0462`/`E0463`/`E0786`, missing `std`/`core` metadata) in unrelated
  crates, while each Windows crate passes on its own. The nine-patch/own-paint
  plan 018 branch starts from the merged point.
  Evidence: six alternating baseline/new `perf.py` runs per side, identical
  `--trace` ops/items lines, and byte-identical light/dark screenshots; the
  gallery does not draw Flow's comet, so its paint/canvas numbers move within
  noise and no speedup is claimed. Plan premise corrected: a fully transparent
  foreground does not cast the Direct2D shadow effect, but the predicate still
  conservatively refuses to skip when a shadow is configured, and the test
  asserts that decision plus byte equality. The damage index is narrower than
  the plan's per-operation bounds: it caches the core `DamageScan`'s per-slot
  area for alpha/color/dash-only reads, while slot-driven geometry, clips,
  `clearRect` and non-source-over composites keep the full scans; exactness is
  differential-tested against the core scanner and the production `set_args`
  wrapper.

## Why this matters

Flow draws its connector comet as 48 animated-alpha strokes per flowing connector. Its 0.24 trail leaves about 36 of those strokes at alpha zero at a typical step, but Windows still creates geometry and Direct2D draw calls for them. On the 11-card, 26-connector reference document the release host spent about 0.8 ms of a 2.5 ms wave step painting the canvas. Avoiding guaranteed-invisible paints and limiting damage scans to candidate operations reduces main-thread work without changing the drawing, the shared canvas architecture, or any public API.

## Current state

- `crates/nsh-platform-windows/src/canvas.rs` — owns Direct2D recording, head/tail command lists, slot updates and pixel-level canvas tests.
- `crates/nsh-core/src/canvas/damage.rs` — platform-independent conservative damage calculation, shared with Apple, Linux and GPUI. It may be read, but this plan does not modify it.
- `docs/dev/canvas.md` and `docs/dev/windows.md` — canonical recording/replay and partial-frame behavior.
- `docs/dev/performance.md` — canonical performance baselines.

At NSH `f0b4659e`, `canvas.rs:273-313` scans the complete drawing before and after a slot write:

```rust
let before = scan(canvas);
// ... update canvas.args ...
if before == Damage::All {
    return Damage::All;
}
match before.union(scan(canvas)) { /* ... */ }
```

`scan` (`canvas.rs:317-333`) passes every `drawing.ops` item to the core scanner. The head and tail are retained separately, but `draw_canvas` plays both lists on every draw (`canvas.rs:418-430`). Alpha is captured in replay state (`canvas.rs:736-741`), and `Replay::emit` calls the draw closure under `source-over` (`canvas.rs:1146-1158`). Geometry is made before that call (`shape`, `canvas.rs:1009-1021`; `rect`, 1025-1030), so the skip must precede those paths too.

The app fixture behind the cost is Flow `src/components/FlowEdges.tsx:189-207`: each of `FLOW_SEGMENTS = 48` pieces is stroked with `cx.globalAlpha = alphas[i]`. `src/flow/edge-flow.ts:36` defines `FLOW_TRAIL = 0.24`, and `flowPass` (`edge-flow.ts:57-65`) uses zero-valued endpoints. These files are evidence only; do not modify Flow.

Core types are `Num::{Const, Slot}` and `Paint::{Color, Slot, Gradient}` (`nsh-core/src/canvas.rs:28-47,326-335`). `Paint::Slot` represents animated **colors**, not scalar opacity. The existing `Replay::color` (`canvas.rs:631-639`) resolves those colors; reuse its semantics. `Color::is_transparent()` is the existing transparency predicate used by `casts_shadow` at `canvas.rs:1180-1183`.

Testing already has the right model: `a_split_drawing_draws_what_the_whole_one_does` (`canvas.rs:2669-2734`) records drawings and compares packed BGRA output using the local `pixels` helper (`canvas.rs:2588-2666`). It returns early only when no Direct3D device, including WARP, is available. Unit tests live in the same module, not a new integration-test binary. `render.rs:2114-2190` separately verifies canvas damage against a whole frame.

NSH conventions that apply (from `AGENTS.md` / `CONTRIBUTING.md`):

- Match existing Rust style; context parameters are `cx`, comments explain why, and all new `unsafe` blocks require a `// SAFETY:` comment.
- Item-private implementation stays `pub(crate)` or private. Do not add public API, generated declarations, or a second canvas scene.
- Avoid needless allocation on hot paths; reuse index scratch space. Do not replace the project's dense-node guidance with per-frame hash maps.
- Hot-path changes need before/after `--trace` numbers and mount-item counts. Platform painting improvements should not claim reduced engine commits.
- Documentation changes belong in the same logical unit. This is a rendering optimization, so no compatibility fixture or public-API PR section is needed.

## Commands you will need

Run from `E:\code\mine\nsh-pr` on Windows with MSVC Build Tools, the Windows SDK and LLVM/libclang installed.

| Purpose                  | Command                                                                                                                                                                                                         | Expected on success                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Drift                    | `git diff --stat f0b4659e..HEAD -- <scope>`; `git status --short`                                                                                                                                               | scope understood; clean tree                                               |
| Format                   | `cargo +nightly fmt --all -- --check`                                                                                                                                                                           | exit 0                                                                     |
| Focused tests            | `cargo test -p nsh-platform-windows`                                                                                                                                                                            | exit 0, all tests pass                                                     |
| Core safety net          | `cargo test -p nsh-core canvas::damage`                                                                                                                                                                         | exit 0, unchanged core tests pass                                          |
| Platform lint            | `cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app --all-targets -- -D warnings`                                                                                                      | exit 0                                                                     |
| Windows test gate        | `cargo test -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app`                                                                                                                                     | exit 0                                                                     |
| Full Rust gate           | `cargo test --workspace`                                                                                                                                                                                        | exit 0                                                                     |
| Full lint gate           | `cargo clippy --workspace --all-targets`                                                                                                                                                                        | exit 0                                                                     |
| Build real CLI           | `cargo build --release -p nsh-cli`                                                                                                                                                                              | exit 0; `target\release\nsh.exe` produced                                  |
| Gallery trace            | `target\release\nsh test examples\gallery\App.tsx --trace`                                                                                                                                                      | entry completes; record ops/items/timings                                  |
| Windows scripted smoke   | `echo 'await app.screenshot("C:\\Users\\Y\\AppData\\Local\\Temp\\plan-017-canvas.png"); await app.setColorScheme("dark"); await app.screenshot("C:\\Users\\Y\\AppData\\Local\\Temp\\plan-017-canvas-dark.png")' | target\release\nsh test examples\gallery\App.tsx --target windows --trace` | exit 0 before and after; light/dark screenshots written to temp |
| Platform gallery profile | `python3 examples/gallery/tools/perf.py --nsh target/release/nsh.exe --only Stocks,Canvas --seconds 4`                                                                                                          | completes; `nsh::fps` readings collected                                   |

`nsh test <entry>` runs that entry's scripted open/step session; `nsh test <directory>` runs the directory's `*.test.tsx` files. The gallery's `NSH_GALLERY_DEMO=Canvas NSH_GALLERY_SECTION=<section>` environment variables can select a fixture, as documented by `examples/gallery/App.tsx:721-750`. The `perf.py --only` option is only for its own profiling driver, not a general `nsh test --only` flag. Use `target\release\nsh test --help` for any additional filters rather than assuming a flag. `python3 examples/gallery/tools/perf.py --help` documents the existing profiling driver.

## Scope

**In scope** (the only NSH source files you may modify):

- `crates/nsh-platform-windows/src/canvas.rs`
- `docs/dev/canvas.md`
- `docs/dev/windows.md` (only the Canvas/performance behavior that changed)
- `docs/dev/performance.md`

**Flow index only**:

- `E:\code\mine\oflow\plans\README.md` status row; format it with `E:\code\mine\oflow\node_modules\.bin\vp fmt plans/README.md` from the Flow repo. Do not edit it if the dispatching reviewer owns the index.

**Out of scope**:

- `crates/nsh-core/src/canvas/damage.rs` and every non-Windows backend. Their conservative scan semantics and public API stay unchanged.
- `render.rs`, `decor.rs`, `gfx.rs`, `view.rs`, `surface.rs`; plan 018 owns partial-frame and decoration work.
- `ID2D1GeometryRealization` caching and multi-rectangle canvas damage: explicitly deferred.
- `Cargo.toml`, `Cargo.lock`, generated `.nsh` output, examples and gallery fixtures.
- Flow application source, `src/native/Cargo.toml` and the NSH revision pin.
- `plans/README.md` dependency rows, other plan rows, or any other file.

## Git workflow

- The checkout starts on `feat/windows-canvas-damage` at `f0b4659e`. Branch from it: `git switch -c advisor/017-nsh-canvas-replay`.
- Commit logical units separately: (1) invisible-paint elision, (2) candidate-indexed damage scans, (3) documentation/measurement records if substantial enough to separate. Keep each unit buildable and tested.
- NSH commit style is `windows: <Capitalized imperative>`; never `perf:` / `fix:`. Example from actual history: `windows: Draw a canvas's changed area only while its values animate` (`f0b4659e`). A suitable subject is `windows: Skip canvas paints that cannot change pixels`.
- Bodies explain why and include before/after `nsh test --trace` timings plus unchanged op/mount-item counts, wrapped at 72 columns.
- Never add AI attribution: no AI `Co-Authored-By` trailer and no "Generated with ..." line.
- Do not push and do not open a PR.

## Steps

### Step 1: Add failing invisible-paint tests and a reusable visibility predicate

In `canvas.rs` tests, add `invisible_source_over_paints_are_omitted` using the existing `pixels` and `record` patterns. Construct one drawing containing static and animated zero-alpha fills/strokes, `Paint::Color(Color::TRANSPARENT)`, a transparent `Paint::Slot`, and a visible control. Assert its output equals an otherwise identical drawing with the invisible paints removed. Test alpha 0 followed by alpha 1 using the same recorded op list so re-recording restores the paint. Add `clear_rect_and_shadows_keep_their_effects`: an invisible source-over paint with a real shadow still renders, and `clearRect` still erases an already-painted area. Also cover an empty current path (which must remain a no-op).

Add five further pixel fixtures that the first predicate (a naïve "fill/stroke transparency" check) would mishandle, so a correct implementation must distinguish the cases below:

- `text_op_zero_alpha_skips_layout`: a `Fill Text` with `globalAlpha = 0` must skip before DirectWrite layout/glyph building, not just before drawing the resulting layout. Assert the output equals an otherwise identical drawing with the text op omitted, and that a later `globalAlpha = 1` re-recording re-draws the same glyphs.
- `conic_gradient_stroke_is_painted_even_under_animated_color_slots`: a conic `Paint::Gradient` stroke whose color-stops are resolved through `brush(...)` returns `Brush::Conic(...)` (`canvas.rs:1119-1125`) and routes through `widen` + `fill_conic`. The predicate must NOT treat conic color actions as a "solid transparent no-op": include a fixture that renders a conic-filled stroke and assert byte equality with a no-skip control even when one stop currently reads as transparent (the gradient may still blend toward an opaque stop). A conic paint that resolves to the empty / all-transparent-stops early-out inside `brush` (`canvas.rs:1430-1432`) is the legitimate skip case, not "any conic whose first stop is transparent".
- `image_with_zero_alpha_is_skipped, image_with_transparent_fill_is_not`: under `globalAlpha = 0` an `image(...)` draw must be elided on the alpha-zero check alone (`state.alpha == 0.0`); under `globalAlpha = 1` with a transparent `state.fill` the bitmap must still draw (the image's pixels, not the foreground brush, supply its color). Pair these two cases.
- `shadows_with_zero_global_alpha_make_no_pixels`: when `state.alpha == 0.0` and a shadow is configured (`blur > 0 || ox != 0 || oy != 0` and shadow color non-transparent per `casts_shadow`, `canvas.rs:1180-1183`), `Replay::shadow` multiplies the shadow color's alpha by `state.alpha` (`canvas.rs:1190`), so even an "opaque configured shadow" is invisible. The predicate MUST return `true` (skip) for alpha-zero regardless of shadow configuration; include a regression guard.
- `reappearance_after_alpha_becomes_nonzero`: a single recorded op list drawn first at `globalAlpha = 0` and then re-recorded at `globalAlpha = 1` must produce the un-elided pixels on the second pass. This is the regression guard against caching the "no-op" decision across recordings.

In `Replay`, add ONE private, conservative no-op predicate parameterized on whether the upcoming paint is geometry-based (shape/rect/text) or bitmap-based (`image`). Use a single return shape, e.g. `enum Skip { None, WholePaint, GeometryOnly }` or two private helpers `skip_geometry_paint(mode)` and `skip_image_paint()`. Do not write four subtly different boolean expressions at the four call sites.

Geometry-paint predicate (drives `shape`, `rect`, `text_op`):

- eligible only when `state.composite == Composite::SourceOver`;
- return "skip" whenever `state.alpha == 0.0`: the foreground has zero coverage and `Replay::shadow`'s alpha multiply (`canvas.rs:1190`) makes even a configured shadow invisible;
- otherwise return "skip" for a resolved transparent foreground **only when `!self.casts_shadow()`**; a transparent foreground may still reveal its shadow and must go through `emit`;
- resolve foreground via the existing `Replay::color` (`canvas.rs:631-639`) and `brush` semantics: an empty-stop gradient and a degenerate linear/radial zero-length or zero-radius gradient are legitimate skips (their `brush` returns `None` at `canvas.rs:1430-1432`, `1437-1439`, `1469-1471`); a conic gradient routes to `Brush::Conic` (`canvas.rs:1495`) and is NOT a skip unless its stops are empty (the whole `fill_conic` path may still produce pixels even when one stop resolves transparent);
- otherwise return "no skip", even for small or unusual values.

Image predicate (drives `image` only):

- eligible only when `state.composite == Composite::SourceOver`;
- return "skip" when `state.alpha == 0.0`;
- return "skip" on the existing bitmap-presence / source-size / destination-size guards already at `canvas.rs:1726-1743` (`bitmap(uri)` returns `None`, `sw == 0 || sh == 0`, `dw == 0 || dh == 0`);
- DO NOT consult `state.fill` / `state.stroke` / any foreground transparency: the bitmap's own pixels are the source of color, and `globalAlpha` (handled by the alpha-zero branch above) is the only state-wide attenuation that applies.

Place the predicate so the early-out fires BEFORE the expensive work it eliminates:

- in `shape` (`canvas.rs:1009-1022`), before `shape_geometry` is called at line 1020 (i.e. right after the existing `singular` / `to_user` invert guards, before line 1019's `rule` binding);
- in `rect` (`canvas.rs:1025-1031`), before `rect_geometry` is called at line 1029;
- in `text_op` (`canvas.rs:1634-1710`), before `self.text.layout(text, &self.state.font)` runs at line 1645 — the layout lookup and glyph building are the cost to avoid, so the predicate must run immediately after the empty/singular guard at line 1642 and well before the conic geometry branch at line 1702;
- in `image` (`canvas.rs:1720-...`), immediately after the `singular` guard at line 1726-1728, before `self.bitmap(uri)` runs at line 1729.

The fixture matrix from Step 1's tests is the contract: each case asserts byte-exact equality against an "omitted ops" control drawing, and the reappearance case proves the predicate is evaluated per-recording rather than memoised on the op list. This is a proof about the current `source-over` state and current slot values, not a blanket transparent-color shortcut, and it does not commute with any non-`source-over` composite.

**Verify**: `cargo test -p nsh-platform-windows invisible_source_over_paints_are_omitted -- --nocapture` → the new test fails before the implementation, passes after; `cargo test -p nsh-platform-windows clear_rect_and_shadows_keep_their_effects` → passes; `cargo test -p nsh-platform-windows text_op_zero_alpha_skips_layout`, `conic_gradient_stroke_is_painted_even_under_animated_color_slots`, `image_with_zero_alpha_is_skipped`, `shadows_with_zero_global_alpha_make_no_pixels`, `reappearance_after_alpha_becomes_nonzero` → all pass after the implementation and the geometry/text/image specific ones fail before it.

### Step 2: Verify whole/tail equivalence before changing scans

Extend the existing split-drawing test fixture with an animated transparent paint in the tail and a visible paint that changes afterward. Compare whole-list output to head+tail output at alpha 0 and a nonzero alpha. Also run a clip + `save` / `restore` case so an omitted stroke cannot accidentally remove clip restoration.

Commit Step 1 with its tests and benchmark setup before proceeding. Include the new zero-alpha cases in a screenshot smoke run, without adding fixtures to the repository.

**Verify**: `cargo test -p nsh-platform-windows a_split_drawing_draws_what_the_whole_one_does -- --nocapture` → exact BGRA equality at all tested values; `cargo +nightly fmt --all -- --check` → exit 0.

### Step 3: Build one replay-dependent candidate index per recording

In `CanvasState`, cache compact dependency metadata for the current `drawing` alongside `scan` and `changed`. Rebuild it when `set` replaces the drawing; invalidate/rebuild it defensively if `drawing.ops` identity changes. Use dense `Vec` storage indexed by slot (library convention: dense slots rather than per-frame hash maps). For each slot, retain the indices of operations that could paint differently when that slot changes. Also retain the complete operation list as a conservative fallback for unsafe/non-finite cases.

In step 3, cache the drawing once with `drawing` and invalidate it in `set`, not based on guessed object identity. For each _ordered real operation index_, the metadata stores a `SlotMask` (dense `Vec<u128>` or equivalent bitset indexed by slot). A mask bit means that op can paint differently when that slot changes; it is not just the slot directly written on that op.

The extra invariants are:

- a paint depends on any animated slot read while building the current path, and on the transform active at `Fill` / `Stroke` / `Clip`, even if that transform last changed before the path was built;
- **state-driven damage is required even for a constant paint**: core `damage.rs:464-471` includes a stroke whose `state.alpha_dep` (or line-width/dash dependence) is true, regardless of whether path geometry itself depends on the slot. A `SetTransform(Slot)` followed by a constant path/fill likewise damages that paint. The index must include these dependent-state paints, not merely ops with a slot in their operands;
- **transparent-dependent paint remains conservative**: core scanning has no global-alpha visibility optimization (`GlobalAlpha`, damage.rs:531-534); an alpha-0-dependent stroke still has a reported damage boundary. Do not shrink a static stroke's damage merely because its animated alpha currently evaluates to zero. The Windows replay shortcut removes its invisible pixels; candidate damage remains governed by the original conservative scan and must match it exactly;
- every source-over paint dependent on a slot goes into that slot's candidate set, including currently invisible ones and static paints after a dependent transform/state read;
- `Clip` never yields its own painted bounds (`damage.rs:473-479`), while `PathBounds.dep` is sticky: a later `Fill` / `Stroke` over that path is damaged even when the current transform is now static. Preserve exactly this prefix/current-path rule. If a changed clip has no current-path dependency and the core cannot bound its influence, choose `Damage::All`; do not invent a smaller region;
- a clip dependent on a slot forces every subsequent paint influenced by that clip, across save/restore, to include that slot; if its exact influence is unknown, that drawing uses full scans;
- `clearRect` or non-`source-over` composition anywhere in the drawing conservatively disables the candidate shortcut for that drawing.

A `Vec<ScanEntry>` retains only real indices whose `SlotMask` is nonempty. Each entry already contains the conservative paint bounds and scan semantics needed for the damage union; when a candidate contains several slots, changing one visits it once. `set_args` converts its small `changed` list to the same slot-mask representation once per write, then scans candidates with `entry.mask & changed_mask != 0`. All earlier state/path writes are already folded into the retained entry so the scanner never needs to rediscover them.

Cache only after the whole drawing has been classified. Unsupported/invalid metadata, or metadata for an older drawing pointer and op count, means `None` and selects the full scans; never partly reuse an index. A bounded `Vec` of used/free slot-mask scratch keeps steady-state slot writes allocation-free; do not allocate a new per-op index on every `set_args`.

Do **not** hand just a candidate subset to the existing whole-list `DamageScan` and do not change its public signature. There is no ready-made per-operation dependency index today. If a private Windows adapter cannot retain equivalent geometry/state/AA rounding (including `Damage::All` fallback and exact same computed rect) without duplicating a subtly different damage algorithm, leave `set_args` on its existing full scans and report that part not achieved. Do not label a smaller or differently rounded damaged area as an optimization.

Implement `candidate_damage_matches_full_scans` with the original full `DamageScan` as the oracle, not only an index-function self-check. Cover static strokes before and after an animated trail, dependent path but static transform, **constant path painted after a slot-driven `Translate` or `SetTransform`**, **constant geometry under slot-driven alpha/width/dash**, save/restore, supplied Path2D, varying color, an unset slot, non-finite values and an animated clip. Include one drawing with only one 48-stroke trail and another alternating trail strokes with 48 later static strokes, so an early-return bug cannot accidentally produce a passing result. A state-only dependence must have identical `Damage::Rect`, including its `AA = 2` inflation, and alpha 0 must not eliminate its conservative damaged region. Add a case that proves no changed slot returns `Damage::None` without paint work.

**Verify**: `cargo test -p nsh-platform-windows candidate_damage_matches_full_scans -- --nocapture` → the index-only oracle matches all fixtures above; `cargo test -p nsh-platform-windows an_animated_canvas_draws_only_its_changed_area` → existing behavior is still green before Step 4 changes `set_args`.

### Step 4: Prove unchanged damage and use the index in `set_args`

Add a test-only reference helper that performs the old full `DamageScan` calls. Compare `Damage::{None,Rect,All}` exactly for candidate and full scans, both before and after changing a slot, over multiple values including zero, non-finite values and an unset slot. Include a drawing with early static strokes, an animated transparent trail, a static stroke after the trail, a changed clip and a composite operation.

In addition to the index-level oracle from Step 3, add a separate `set_args_matches_full_scans_on_the_production_wrapper` differential test that drives the production `set_args(view, values)` entry point (`canvas.rs:273-313`) end-to-end. This is the function whose body Step 4 edits, so the regression net must call it — not just a sibling private helper — for both the indexed path (new) and the full-scan path (old). Route the old behavior behind a test-only flag, a per-test shadow copy of the pre-Step-4 implementation, or a cargo-feature; the choice is the executor's, but it must call into the same `set_args` public shape (same `view: &NshView`, same `values: &[(u16, AnimationValue)]`), not a re-implementation built only for the test.

For each fixture below, build an `NshView` holding the original drawing (using the existing test-fixture `view`, `target`, `read` helpers around `record`/`pixels` and the same `NshView::state_mut()` device the production code uses), then run both paths and compare `Damage::{None,Rect,All}` exactly:

- an original drawing with at least one animated slot and one static stroke, before any slot write (`set_args` returns `Damage::None` because `changed` is empty, `canvas.rs:286-288`) and after a single slot write;
- a slot update that lands inside `within`'s `frame.size` bounds (so the `Rect` variant passes through `within` unchanged at `canvas.rs:303-309`) and one that lands outside it (so `within` clamps to the frame and may collapse to `Damage::None`); the two paths must agree on both the clamped rectangle AND the `Rect → None` collapse;
- a drawing that produces `Damage::None` from the union (e.g. an animated slot that is read by zero paint ops), which must be returned as-is through the `other => other` arm at `canvas.rs:311`;
- a drawing that legitimately produces `Damage::All` (e.g. an unbounded clip influence per the Step 3 fallback rules), which must hit the early `before == Damage::All` return at `canvas.rs:299-301` on BOTH paths.

This test must fail before the Step 4 switch is wired into `set_args`: with the switch off both "paths" are the new indexed one, so the differential collapses to a self-comparison that passes vacuously only after the switch is enabled in production. To force the failing-first behavior, temporarily keep the test-only reference branch behind a `cfg(test)` constant that the differential sets to "legacy" for its control arm while production `set_args` still runs the un-indexed body; the first run therefore compares the new oracle against the new oracle only after the production switch flips, and an intentional broken intermediate Step 4 build (e.g. failing to clamp through `within`, or returning `Damage::Rect` when legacy returned `Damage::None`) must make this test fail. Document that failing-first recipe briefly in the test's doc comment so a future maintainer can re-prove it.

Wire `set_args` through the candidate index for both scans. Keep the existing early return when values are unchanged (`canvas.rs:286-288`), the `Damage::All` short-circuit (`canvas.rs:299-301`), and the frame-clamping behavior in `within` (`canvas.rs:303-310`). If indexing metadata is absent, invalid, or reports an unsupported case, execute the original full scans; never produce a smaller damage boundary based on a heuristic.

**Verify**: `cargo test -p nsh-platform-windows candidate_damage_matches_full_scans -- --nocapture` → every differential case matches; `cargo test -p nsh-platform-windows set_args_matches_full_scans_on_the_production_wrapper -- --nocapture` → every wrapper-level differential case matches, including both `within` branches and the `Damage::All` fallback; `cargo test -p nsh-platform-windows an_animated_canvas_draws_only_its_changed_area` → existing test passes; `cargo test -p nsh-core canvas::damage` → unchanged core tests pass.

### Step 5: Document behavior and collect same-host before/after evidence

Update the Windows Canvas row in `docs/dev/windows.md` and the partial-redraw section of `docs/dev/canvas.md`: guaranteed-invisible source-over paints are omitted at the current recording values, and slot-dependent damage candidates are indexed while preserving full-scan fallbacks. Avoid claiming this semantics in the core or other platforms. Add measured Windows results to `docs/dev/performance.md`, with machine, display scale/rate, build profile and base commit.

**Acquire the baseline executable (required, do not skip).** `python3 examples/gallery/tools/perf.py --nsh <baseline-or-new>` measures whatever binary path you pass; if you only have `target\release\nsh.exe` from your branch, you have no baseline. Build one, outside your working branch so a rebase or branch switch cannot clobber it:

```
# From E:\code\mine\nsh-pr, on a clean tree:
git worktree add --detach E:\code\mine\nsh-baseline-017 f0b4659e
cd E:\code\mine\nsh-baseline-017
cargo build --release -p nsh-cli
mkdir -p C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e
copy target\release\nsh.exe C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\nsh.exe
git rev-parse HEAD > C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\REVISION.txt
```

Confirm `REVISION.txt` starts with `f0b4659e7f1b3f10174905add6096f86ed3736cb`. Keep the worktree at `E:\code\mine\nsh-baseline-017` for the duration of this plan (do not run `git worktree remove` until Step 6's gates pass; cleanup is the maintained tail, not a prerequisite). Pass `C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\nsh.exe` as `--nsh` for baseline runs and `E:\code\mine\nsh-pr\target\release\nsh.exe` for new-build runs. The two binaries MUST serve the same unchanged gallery bundle: do not edit `examples/gallery/App.tsx`, `examples/gallery/tools/perf.py`, or any gallery fixture during the comparison; if Step 1's commit added a temporary probe fixture, remove it before measuring.

**Collect raw logs with an external read-only collector.** `perf.py`'s JSON output stores only phase MEANS (`perf.py:184`); the per-second `name mean/p50/p95/max` strings survive only in the stdout stream that `perf.py` writes to `examples/gallery/.nsh/perf/log.txt` (`perf.py:199`), which is truncated on the next run. To retain per-phase p50/p95/max across alternating runs, write a small Python script OUTSIDE both repositories, e.g. `C:\Users\Y\AppData\Local\Temp\claude\collect-perf-017.py`, that:

1. invokes `python3 E:\code\mine\nsh-pr\examples\gallery\tools\perf.py --nsh <baseline-or-new> --only Stocks,Canvas --seconds 4 --size 1200x800 --out <path-under-temp>` via `subprocess.run`;
2. immediately after each invocation, copies `E:\code\mine\nsh-pr\examples\gallery\.nsh\perf\log.txt` to a unique file under `C:\Users\Y\AppData\Local\Temp\claude\plan-017-logs\<timestamp>-<baseline|new>-<run>.log.txt` so the next invocation cannot overwrite it;
3. parses each retained file using `perf.py`'s own regexes (treat them as the authoritative grammar — `LINE` at `perf.py:44-49` for the `nsh::fps` line and `PHASE` at `perf.py:50` for the per-phase `mean/p50/p95/max` string);
4. aggregates, per `(scenario, phase)`, the per-second `mean`, `p50`, `p95`, `max` across at least 3 baseline runs and at least 3 new-build runs, alternating baseline/new/baseline/new/... so thermal drift is distributed; report each aggregate with nearest-rank p95 (compute on the sorted list of per-second `p95` values, not on the mean of means) and the raw sample count (`n = number of seconds observed`).

The collector is not committed; keep it under the temp directory only. Mount ops/items come from separate `target\release\nsh.exe test examples\gallery\App.tsx --trace` invocations against both binaries (NOT from `perf.py`), and must match exactly (same op list, same mount-item count); a difference is a STOP condition. Take the deterministic screenshot pair (baseline vs new, identical gallery launch and identical scripted steps) using the "Windows scripted smoke" command from the Commands table, run once per binary into `plan-017-canvas-baseline.png` / `plan-017-canvas-new.png` and `plan-017-canvas-baseline-dark.png` / `plan-017-canvas-new-dark.png`, and confirm each pair matches visually before claiming the optimization.

If the gallery workload does not exercise the resize path, do not fabricate resize evidence: record resize-cache reuse through a deterministic synthetic probe (e.g. changing `frame.size` on a test `NshView`) and explicitly label the resulting section in `docs/dev/performance.md` as "synthetic reuse metric only, missing real-host resize coverage" — the honest gap is preferable to a misleading number.

**Verify**: `Test-Path C:\Users\Y\AppData\Local\Temp\claude\nsh-baselines\f0b4659e\nsh.exe` → `True`; the baseline `REVISION.txt` starts with `f0b4659e7f1b3f10174905add6096f86ed3736cb`; the external collector leaves at least three `*-baseline-run*.log.txt` and three `*-new-run*.log.txt` files under `C:\Users\Y\AppData\Local\Temp\claude\plan-017-logs\`, each pairing a unique timestamp; the aggregated JSON reports nearest-rank p95 and `n` for every `(scenario, phase)` cell; `--trace` runs against both binaries produce byte-identical ops/items lines. Do not claim a speedup before the paired numbers exist; do not treat `--help` completing as evidence that the measurement pipeline worked.

### Step 6: Run the fork's gates, build the CLI, and update the Flow plan row

Run formatting, focused tests, Windows clippy, Windows tests, `cargo test --workspace`, and full workspace clippy serially. Then `cargo build --release -p nsh-cli`. Run the gallery on the real Windows host and capture screenshots in a temporary directory.

Only after those gates pass, update this plan's row in Flow's `plans/README.md` and run the Markdown formatter for that file. Do not change the Flow pin: Flow's `src/native/Cargo.toml:10,25` currently pins full revision `f0b4659e7f1b3f10174905add6096f86ed3736cb`, and changing it is a separate maintainer action after the fork changes are accepted/published. The user's local Flow launcher may run this fork's CLI, but that does not update the crate pin.

**Verify**: `git diff --check` → no output; `git status --short` → only the allowed NSH files (and, when assigned, the Flow plan row) are modified; every gate above exits 0; `Test-Path target\release\nsh.exe` → `True`.

## Test plan

- `crates/nsh-platform-windows/src/canvas.rs::tests::invisible_source_over_paints_are_omitted`: static/animated zero alpha and transparent paints are pixel-identical to omission, and later nonzero values reappear.
- `...::clear_rect_and_shadows_keep_their_effects`: clear and shadow behavior cannot be lost by the shortcut.
- `...::text_op_zero_alpha_skips_layout`: zero-alpha text skips before DirectWrite layout/glyph building; reappearance at nonzero alpha.
- `...::conic_gradient_stroke_is_painted_even_under_animated_color_slots`: a conic `Paint::Gradient` stroke is not mistaken for a transparent solid no-op; only the empty-stops `brush(...) → None` early-out legitimately skips.
- `...::image_with_zero_alpha_is_skipped, image_with_transparent_fill_is_not`: under `alpha == 0.0` the bitmap is elided; under `alpha > 0.0` with a transparent foreground fill/stroke the bitmap still draws.
- `...::shadows_with_zero_global_alpha_make_no_pixels`: even a configured non-transparent shadow is invisible at `globalAlpha == 0.0`; the predicate must skip despite the shadow.
- `...::reappearance_after_alpha_becomes_nonzero`: a single recorded op list drawn first at alpha 0 then re-recorded at alpha 1 produces the un-elided pixels on the second pass.
- `...::candidate_damage_matches_full_scans`: candidate old/new damage equals the original full scan for paths, transforms, current path, save/restore, dash, paint slots, unset slots, non-finite values, clips, clear and composites.
- `...::set_args_matches_full_scans_on_the_production_wrapper`: the PRODUCTION `set_args` wrapper agrees byte-exactly between legacy full-scan and the new indexed path, including both `within` clamp/collapse branches and the `Damage::All` fallback. Must fail in a deliberately broken Step 4 intermediate build.
- `...::a_split_drawing_draws_what_the_whole_one_does`: extend the existing exact-pixel regression; model new tests after it, not a screenshot-only test.
- Existing `crates/nsh-platform-windows/src/render.rs::tests::an_animated_canvas_draws_only_its_changed_area` and all `crates/nsh-core/src/canvas/damage.rs` tests remain unchanged and green.
- Verification: `cargo test -p nsh-platform-windows` and `cargo test -p nsh-core canvas::damage` → all pass, including the new named cases; real-host screenshots confirm gallery visuals manually.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo +nightly fmt --all -- --check` exits 0.
- [ ] `cargo test --workspace` exits 0; the new tests named above exist and pass on Windows.
- [ ] `cargo clippy --workspace --all-targets` and the explicit Windows clippy command exit 0 with no warnings.
- [ ] `cargo build --release -p nsh-cli` exits 0 and produces `target\release\nsh.exe`.
- [ ] Candidate-vs-full damage tests pass, including unsupported-mode fallback and nonzero reappearance after zero alpha.
- [ ] Gallery before/after trace records show unchanged op/mount-item counts; measured paint/canvas results and host configuration are recorded in `docs/dev/performance.md`.
- [ ] `git diff --check` exits 0, and `git status --short` shows no out-of-scope NSH files.
- [ ] Flow's `plans/README.md` row is updated and formatted, if this executor owns it.
- [ ] The commit body follows NSH style, includes hot-path evidence and has no AI attribution.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts do not match the live files at the intended base, or the checkout contains unrelated changes.
- Preserving candidate semantics requires changing `DamageScan`'s public API or editing a non-Windows backend/core file. Keep the implementation strictly Windows-private, or retain the original full scans and report the candidate-index reduction as not achieved; do not deliver a known-broken index.
- Skipping a paint would change `clearRect`, clipping, current-path state, save/restore, composite behavior or an active shadow.
- Exact BGRA comparisons differ by more than the already-documented alpha rounding tolerance for the existing split test; new equivalence tests should normally be byte-identical.
- Indexed damage is ever smaller than full-scan damage, cannot represent a clip/composite conservatively, or fails an unset/non-finite case.
- No Direct3D device including WARP is available: unit tests can still run, but the pixel-equivalence done criterion is unproven; report it rather than claiming visual correctness.
- The release gallery measurement regresses materially or mount items change; stop after two reasonable diagnosis/fix attempts and preserve baseline/new logs.
- A required change appears in out-of-scope code, or a verification command fails twice after a reasonable focused fix.

## Maintenance notes

- Future changes to path creation, paint state, clip rules, transforms or save/restore must update the single dependency-index walker and its full-scan differential tests. Any unsupported feature must select the full-scan fallback.
- A transparent paint with a visible shadow is still visible. Re-evaluate the skip predicate when adding animated shadow properties or filter support; both are outside the current core drawing representation.
- If per-slot metadata becomes disproportionate for huge numbers of slots/ops, cap it and fall back to full scans rather than trading expensive recording for tiny per-frame gains.
- `ID2D1GeometryRealization` caching and multi-rectangle canvas damage remain deferred: they are separate device-resource and damage-model designs, not prerequisites for this improvement.
- After maintainer approval/push, Flow must deliberately bump both pinned revisions in `src/native/Cargo.toml` (core and Windows platform), regenerate its lockfile through its normal build and then measure the 11-card/26-connector comet. This plan does not perform that pin update.
