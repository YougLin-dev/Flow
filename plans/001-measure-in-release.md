# Plan 001: Measure performance on an optimized host

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1956ebb..HEAD -- package.json docs/testing.md docs/standards.md src/components/FrameRate.tsx CHANGELOG.md plans/README.md`
> `plans/README.md` is maintained by the advisor; the only allowed executor
> edit is this plan's status row.
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `1956ebb`, 2026-11-10

## Why this matters

`bun run dev` measures a debug native host, not the performance users get
from an optimized build. On the reference document the selected connectors'
comet costs about 6.2 ms per step on that debug host versus about 2.5 ms on
a release Windows host, so debug readings can misdirect optimization work.
This plan adds a one-command optimized dev host and a reproducible,
appropriately qualified measurement recipe for later performance changes.

## Current state

- `scripts/dev.mjs:15-23` chooses the persistent development database and
  forwards every extra argument directly to `nsh`:

  ```js
  const dbPath = resolve(process.env.FLOW_DB_PATH || ".nsh/dev/flow.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  const result = spawnSync("nsh", ["run", "src", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, FLOW_DB_PATH: dbPath },
  });
  ```

- `package.json:8` has `"dev": "bun scripts/dev.mjs"`; line 19 has the
  headless test command and line 23 the real-host 100k smoke. Adding a
  `dev:release` alias therefore needs no script implementation.
- NSH confirms that `nsh run --release` optimizes the development host, not
  just the bundled JS. At pinned NSH `f0b4659`, its
  `crates/nsh-cli/src/run.rs:185-189` calls `rust_app::set_release_hosts()`;
  `crates/nsh-cli/src/rust_app.rs:2164-2178` includes the resulting `release`
  flag in the generated host's build, and `rust_app.rs:2081-2084` passes
  `--release` to Cargo. The flag is defined in
  `crates/nsh-cli/src/main.rs:269-271` alongside the `Run` command.
- By contrast, NSH's generated dev workspace only promotes named dependency
  packages. `rust_app.rs:1873-1885` says "App Rust code stays easy to debug"
  and emits this for `quickjs-jit-sys`, `taffy`, `objc2`, and `objc2-encode`:

  ```rust
  manifest.push_str(&format!(
      "\n[profile.dev.package.{package}]\nopt-level = 3\n"
  ));
  ```

  Consequently the dev profile leaves nsh-core, nsh-js, the Windows platform,
  flow-native, and bundled SQLite at their ordinary unoptimized level. Do not
  call `--release` merely a minified-JS run in the documentation.

- `src/components/FrameRate.tsx:6-10` already documents that its recurring
  `requestAnimationFrame` loop renders even with nothing else to draw:

  ```tsx
  /** The rate the app renders at, floating above the tool switch. Every
   * `requestAnimationFrame` callback asks for the next frame, so this is the
   * display's real rate — and while the meter runs the app renders even when
   * it has nothing else to draw. `FLOW_FPS=1` shows it; without it no loop
   * runs. */
  ```

  `src/pages/FlowPage.tsx:470` mounts it with
  `{process.env.FLOW_FPS ? <FrameRate /> : null}`; `src/nsh.json:13-15`
  declares that environment variable. Extend the component header with a
  warning rather than creating another measurement loop.

- `docs/testing.md:50-59` describes the 100k real-host smoke and its manual
  screenshot review, followed by `## The test levels` at line 61. Put the new
  `## Measuring performance` section between those blocks.
- `docs/standards.md:373-384`, §8.2, is normative and must stay substantively
  unchanged. Quote its relevant rules in the performance section:

  > App code MUST NOT rebuild the scene, traverse the whole document, or
  > write a signal every frame. [...] Frame budgets (about 10 ms of app work
  > and 16.7 ms per frame at 60 Hz, 50 ms input-to-feedback) are SHOULD
  > targets measured manually on the reference host; they MUST NOT be
  > asserted in CI without a stable benchmark.

  In §8.2 itself, leave its approximate budgets and viewport-work rule
  intact. Keep the final CI restriction as the separate sentence
  "`Frame budgets ...` are `SHOULD` targets [measured manually on the
  reference host](testing.md#measuring-performance); they MUST NOT be
  asserted in CI without a stable benchmark." The Markdown anchor is correct:
  `§8.2 Performance` becomes `82-performance`; the link from `docs/standards.md`
  to `docs/testing.md` is `testing.md`, not `docs/testing.md`. No budget or CI
  rule changes are authorized beyond this link.

- `CHANGELOG.md:7-9` has `## [Unreleased]` then `### Added`; add one short
  bullet describing `bun run dev:release`, not an optimization claim.

### Exact Windows monitor semantics to inline into `docs/testing.md`

Source basis in the NSH fork, for verification only (do not edit NSH):
`E:\code\mine\nsh-pr\crates\nsh-platform-windows\src\fps.rs:6-21,165-219`
and `E:\code\mine\nsh-pr\crates\nsh-engine\src\perf.rs:65-188,346-427`.
The latter supplies engine distributions; Windows supplies its paint phases.
Every four-number field is **mean/p50/p95/max in milliseconds**, not
p50/p95/max plus another unspecified number. The monitor excludes its first
four frames and commits as cold (`perf.rs:60-63`).

Document this field glossary in prose or a compact table:

- `fps shown/refresh`: refreshes that changed something per second over the
  last second / the display's refresh rate. Low `fps` while idle is not
  slowness. This host's monitor closes frames on each refresh (`fps.rs:23-24`).
- `frame`, `tick`, `drain`, `paint`, `present`, `canvas`, `gap`, `js`, and
  `core`: four millisecond statistics in the order above. `frame` is
  main-thread work per shown frame, excluding presentation; `tick` is the
  compositor-paced ticker (animations and frame callbacks); `drain` applies
  arriving engine batches; `paint` draws the Direct2D tree; `present` queues
  the swap-chain frame; `canvas` is canvas recording and replay within paint;
  `gap` is time between shown frames.
- `over`: percentage of retained shown frames whose main-thread work exceeded
  one refresh, not a count of dropped input events.
- `commits`: engine wake-ups that produced commits per second over the last
  second. `js` is app code (handlers, timers, microtasks, list binds, and
  render decoding); `core` applies ops, expands components, typesets, lays
  out, and diffs to mount items. `items` is mean mount items per commit.
- `engine`: engine-thread busy share over the last second; `cpu`: process CPU
  over wall time as a percentage of one core (150% is 1.5 cores busy); `mem`:
  working set in MB on Windows.

For headless tracing, describe what pinned NSH actually does rather than
promising a single composite record: `nsh test <file> --trace` prints mount
batches with item counts under named steps (for example
`── press(Fit): N items`) and logs engine `nsh::perf` records separately.
Those records include per-commit op counts, total core-side commit duration,
list-binding JS time, mount items, and node counts; event-handler JS time is
logged as a separate `event js` record. Use command output to compare counts
and timings across repeated runs, not assumed percentile distributions.

### Before baselines to include with provenance

These are observations to reproduce, not thresholds or CI assertions:

- Advisor probe on the real development document (11 cards, 26 connectors),
  1800×1180 release/LTO Windows host at Flow `1956ebb` / NSH `f0b4659`: with
  all cards selected and 26 flowing connectors, about 2.5 ms main-thread work
  per comet wave step (paint 2.4–2.7 ms, canvas about 0.8 ms). The same probe
  on the debug dev host measured about 6.2 ms/step. A separate optimized
  **headless** 11-card group-drag probe measured unbatched `setOverrides`
  about 6 ms JS versus about 0.6 ms batched; another debug-host observation
  was about 14 ms. These distinct setups suggest why host profile matters;
  they are not a universal 2.5× multiplier on every operation.
- User's `bun dev -- --fps -v` log on the debug host and a 240 Hz display:
  dragging the framed 11-card selection reported 70–75/240 fps, 67 commits/s,
  13–15 ms JS per commit, 48–56 mount items per commit, and 97–100% engine
  busy. Preserve the label **debug dev host** beside those numbers.
- `docs/plans/rust-core.md:376-411` is the existing separate release-database
  baseline. Link to it instead of duplicating its older search figures as
  canvas-host evidence.

## Commands you will need

| Purpose                         | Command                                                                                                                       | Expected on success                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Optimized dev host and monitor  | `bun run dev:release -- --fps -v`                                                                                             | cargo/CLI identifies a release host; `nsh::fps` lines appear  |
| Debug dev host and monitor      | `bun run dev -- --fps -v`                                                                                                     | development host opens; use for contrast only                 |
| One traced headless test        | `nsh test src/App.test.tsx --filter "clears the selection with Escape" --trace`                                               | test passes; named-step batches and `nsh::perf` records print |
| 100k real-host smoke            | `bun run test:100k`                                                                                                           | exit 0; screenshots in `.nsh/bench`                           |
| Full gate                       | `bun run check`                                                                                                               | exit 0, no warnings                                           |
| All ordinary tests              | `bun run test`                                                                                                                | exit 0, all pass                                              |
| Format only changed docs/config | `./node_modules/.bin/vp fmt --check package.json docs/testing.md docs/standards.md src/components/FrameRate.tsx CHANGELOG.md` | all matched files correctly formatted                         |

Run commands from the repository root. `bun run dev:release -- --fps -v`
passes `--fps -v` through Bun's separator and `scripts/dev.mjs` to NSH. Do not
confuse this with `bun run test:bench`, which times Rust database calls.

## Scope

**In scope** (the only files you should modify):

- `package.json`
- `docs/testing.md`
- `docs/standards.md`
- `src/components/FrameRate.tsx` — header comment only
- `CHANGELOG.md`

**Out of scope** (do NOT touch, even though they look related):

- `scripts/dev.mjs` — it already forwards `--release`; no behavior edit.
- `src/pages/FlowPage.tsx`, `src/nsh.json`, `src/flow/**`, `src/native/**` —
  no mounting, sandbox, scene, or database changes.
- Any NSH file under `E:\code\mine\nsh-pr` — read its implementation only.
- Frame-rate assertions in CI, automatic pass/fail performance budgets, and
  formatter/build rewrites beyond this documentation/script addition.
- Generated `.nsh` output and development/benchmark databases or screenshots.

## Git workflow

- Branch from `main`: `git switch -c advisor/001-measure-in-release`.
- Commit per logical step; Conventional Commits with a lower-case imperative
  subject and an explanatory body. Match existing commits such as
  `perf: keep canvas gestures to one update per moved card` (`1956ebb`) and
  `feat: show the app's frame rate on the canvas` (`3489486`).
- Never add AI attribution: no `Co-Authored-By:` trailer naming an AI and no
  "Generated with ..." line.
- Do not push and do not open a PR.
- When done, update this plan's row in `plans/README.md`, then run
  `./node_modules/.bin/vp fmt plans/README.md`. The README is the only allowed
  modification outside the in-scope list, aside from the branch/commit.

## Steps

### Step 1: Add and verify the optimized development-host command

In `package.json`, immediately after `dev`, add exactly:

```json
    "dev:release": "bun scripts/dev.mjs --release",
```

Do not change `scripts/dev.mjs`: its `...process.argv.slice(2)` passes flags
through already. In a disposable terminal run:

```sh
bun run dev:release -- --fps -v
```

The first release build can take several minutes. Observe both the Cargo
`Finished \`release\` profile ...`line (or the CLI's explicit
"development host ... (release build)" status) and at least one`nsh::fps`
line after the window opens. A normal warm build may omit Cargo's line
because it has nothing new to compile; the release-host label then identifies
the build. Once both are established, Ctrl+C is an expected manual stop and
is not a failed gate.

**Verify**: `grep -n '"dev:release": "bun scripts/dev.mjs --release"' package.json` → exactly one matching line; the run observed above reports a release-profile host and outputs `nsh::fps` lines. If a fresh build instead prints `Finished \`dev\` profile [unoptimized + debuginfo]`, record the output and STOP.

### Step 2: Document reproducible performance measurement

Add `## Measuring performance` to `docs/testing.md` after the existing 100k
paragraph and before `## The test levels`. Include all of the following:

1. Use `bun run dev:release -- --fps -v` on the real desktop for performance
   investigations. Explain that the release host optimizes the generated host
   and app Rust core, while normal `bun dev` leaves those hot crates at -O0.
   Always record machine, OS, commit, window size, display refresh rate, host
   profile, document/card/connector counts, and selection size with a number.
2. Instruct the reader to let startup settle, discard cold startup readings,
   observe for several seconds after a short warmup, and repeat the same
   gesture several times. Report ranges and work counts; do not promote one
   noisy run to an optimization result. Use the exact monitor glossary above,
   especially mean/p50/p95/max.
3. Distinguish the two overlays: `--fps -v` enables the Windows `nsh::fps`
   monitor; `FLOW_FPS=1` separately mounts the app's `FrameRate` overlay
   (`FLOW_FPS=1 bun run dev:release -- --fps -v` if both are wanted).
   `FrameRate` asks for continuous display frames, so leave `FLOW_FPS` unset
   when measuring idle wakeups or comparing the app's unforced frame rate.
4. Explain the separate headless `nsh test <file> --trace` mechanism exactly
   as described in Current state, using the supplied example command.
   Headless traces exclude Windows presentation and real-input/paint work;
   they are useful for engine work counts, not substitutes for a release-host
   measurement.
5. Reproduce the §8.2 rule that budgets are manual SHOULD targets and MUST
   NOT become CI assertions without a stable benchmark, with a link to
   `standards.md#82-performance` (use the actual generated-heading anchor
   style already used by repository Markdown if different).
6. Add these three scenario recipes with the response metrics to record:
   - **Framed group drag**: reveal enough cards, drag a rectangle around
     several to select them, drag the group by its selection frame; record
     card/connector/selection counts, `commits`, `js`, `items`, `frame`,
     `paint`, `canvas`, and `engine` before/after a change.
   - **Pan/zoom with selected cards**: keep the same group selected, pan with
     the hand tool and zoom around the pointer; record the same fields and
     refresh/over-refresh figures without inferring smoothness from `fps`
     alone. Repeat while idle to measure baseline engine wakeups.
   - **Large document/low zoom**: run `bun run test:100k`, review its ignored
     screenshots, and inspect the pan, zoom, search-reveal, and Fit costs. Its
     database is synthetic; say what fixture revision generated it when
     recording a comparison. For future benchmark additions, keep their
     outputs as manual evidence rather than CI timing gates.
7. Copy all three baseline observations listed in Current state, including
   document dimensions and host profiles, as a short "Before baseline"
   subsection. Mark that the debug readings prompted this plan and should be
   re-measured in release before choosing follow-up work.

**Verify**: `grep -n '^## Measuring performance$' docs/testing.md` → one heading; `grep -n 'mean/p50/p95/max\|bun run dev:release\|FLOW_FPS=1\|Framed group drag\|Pan/zoom\|Large document' docs/testing.md` → each required recipe/measurement detail is present in the new section.

### Step 3: Link the performance standard without changing its rule

In `docs/standards.md` §8.2 line ~382, link "measured manually on the
reference host" to the new `docs/testing.md` section. Do not alter the
approximate budgets, the viewport-work rule, or the CI restriction. Add a
comment-only sentence to the `FrameRate.tsx` header stating that the meter
forces a frame on every refresh and must be off while measuring idle cost.

**Verify**: `grep -n 'measured manually on the reference host.*testing.md#measuring-performance\|measuring idle cost' docs/standards.md src/components/FrameRate.tsx` → the standard links to the recipe and the component has a comment-only idle warning.

### Step 4: Record the developer-facing command

Under `CHANGELOG.md` `## [Unreleased]` / `### Added`, add a concise bullet:
`bun run dev:release` runs the development app against the same persistent
`.nsh/dev` document on an optimized host for meaningful performance checks.
Do not claim that an optimization landed.

**Verify**: `grep -n 'bun run dev:release' CHANGELOG.md` → one Added bullet naming the command and optimized host.

### Step 5: Format and run the complete gates

Apply repository-owned formatting only to the changed files if necessary
(`./node_modules/.bin/vp fmt <same five paths>`), inspect the diff, then run
both required gates. There are deliberately no new behavioral tests: this
plan adds an alias, comment, and measurement documentation. Existing tests
remain the regression check for the comment-only TSX change.

**Verify**: `./node_modules/.bin/vp fmt --check package.json docs/testing.md docs/standards.md src/components/FrameRate.tsx CHANGELOG.md && bun run check && bun run test` → all commands exit 0, formatting is clean, and all tests pass.

### Step 6: Review scope, preserve manual evidence, and update the index

Inspect `git diff --check` and `git status --short`; only the five scope
files plus the executor's status-row update may differ. Summarize the actual
release-host observation (including whether it was a cold build), automated
results, and any host scenario not performed. Update this plan's README row
using its existing status vocabulary, formatting the README as above. Commit
one or more logical units with no AI attribution.

**Verify**: `git diff --check && git status --short` → no whitespace errors and no out-of-scope modifications; README reflects actual completion.

## Test plan

- No new test files or cases: this plan adds a package alias, documentation,
  and a component header comment only. Do not add timing assertions.
- Reuse the existing mounted-app behavior `src/App.test.tsx` case
  "clears the selection with Escape" as the trace example only; do not change
  its assertions or turn its duration into a pass/fail budget.
- Host verification: the manual launch in Step 1 must show a release-profile
  host and `nsh::fps`; capture at least one log line. The 100k smoke is a
  documented scenario recipe, not an additional mandatory run for this small
  DX/docs change unless its behavior is modified.
- Verification: `bun run check && bun run test` → exit 0, all existing tests
  pass with no new performance tests.

## Done criteria

Machine-checkable. ALL must hold:

- [x] `grep -n '"dev:release": "bun scripts/dev.mjs --release"' package.json` returns exactly one match.
- [x] `grep -n '^## Measuring performance$' docs/testing.md` returns one section containing the correct four-number meanings, both FPS mechanisms, three scenario recipes, and baseline build provenance.
- [x] `grep -n 'testing.md#measuring-performance' docs/standards.md` returns the §8.2 reference; the normative frame-budget text is otherwise unchanged.
- [x] The `FrameRate` change is comment-only (`git diff 1956ebb -- src/components/FrameRate.tsx` contains no executable logic change).
- [x] Optimized-host manual launch observed `release` (not dev profile) plus `nsh::fps`, and the result is reported.
- [x] `bun run check` and `bun run test` both exit 0.
- [x] No files outside the in-scope list are modified except the required `plans/README.md` status row (`git status --short`).
- [x] `plans/README.md` status row updated and formatted; commits contain no AI attribution.

## Execution result

2026-11-10: APPROVE on isolated branch `advisor/001-measure-in-release`, commit
`d86ca9d` (`docs: add an optimized host measurement recipe`).

- Release-host evidence: the real `bun run dev:release -- --fps -v` cold build
  finished `release [optimized]` and explicitly identified the Windows release
  host. A captured `nsh::fps` sample reported `fps 4/240`, `frame`
  2.58/3.39/4.15/4.15 ms and `mem 88.3 MB`. This verifies startup and monitor
  wiring only; no performance gestures or `bun run test:100k` were performed.
  The owned host process tree was cleaned up.
- Evidence file: `%TEMP%/flow-release-foreground-9430ada12b394721865de2b934b44d4b.log`.
  The separate `dev` profile building `flow-native`'s describe helper was a
  prerequisite, not a dev-profile Windows host.
- Independent review: five-file scope, formatted, comment-only `FrameRate`
  edit and no AI attribution; representative trace test passed with
  `press(Hand): 8 items`, separate `perf commit` and `perf event js` records;
  `bun run check` and `bun run test` both independently exited 0 — 252 passed,
  0 failed, 2 ignored benchmarks skipped.
- Earlier overlapping builds exhausted memory. Verification was serialized
  with `CARGO_BUILD_JOBS=2`; the successful host launch also used
  `RUSTFLAGS=-Ccodegen-units=16`. These were execution environment settings,
  not source changes.
- Nothing was pushed and the isolated commit remains unmerged.

## STOP conditions

Stop and report back (do not improvise) if:

- A current-state excerpt differs and the drift is not merely line movement.
- The release alias launches a dev-profile host, fails before the app opens,
  or `nsh::fps` cannot be enabled with `-v`; include the actual CLI/Cargo
  diagnostics rather than reverting to debug-host numbers as release evidence.
- The pinned NSH is not `f0b4659` and its release-host implementation or
  monitor semantics differ from those quoted; re-read its local source and
  report the discrepancy before documenting the fields.
- Correct documentation would require an app behavior change, database
  change, new capability, or an edit in the NSH repository.
- A step's verification fails twice after a reasonable fix attempt.
- You cannot distinguish `nsh::fps` host statistics from `nsh::perf` trace
  records in actual command output; do not invent combined fields or timing
  thresholds.

## Maintenance notes

- Any future performance plan must use the release-host recipe for paint and
  input claims, label the profile and document size, and compare repeated
  runs. `nsh test --trace` complements rather than replaces host evidence.
- Keep `--fps` distinguishable from `FLOW_FPS=1`; never leave the latter on
  for baseline idle measurements. The frame meter is itself a workload.
- Later benchmark expansions should provide their own row counts and storage
  setup/provenance so the baseline remains reproducible. Do not turn the
  manual targets in standards §8.2 into CI assertions.
- No executor update to `docs/architecture.md` is expected: app ownership and
  the runtime architecture have not changed, only the development command and
  performance-testing documentation.
- Other documentation-only branches may touch `CHANGELOG.md` or
  `docs/standards.md`; preserve peer changes rather than restoring the
  `1956ebb` excerpt wholesale.
