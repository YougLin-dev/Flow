# Window model v2 review record

Date: 2026-11-17. Scope: NSH window model v2 (`E:\code\mine\nsh-pr`,
`feat/window-model-v2`) and the Flow migration (`E:\code\mine\oflow`,
`feat/window-model-v2`). The author did not review or sign off their own work.

## Round 1 — independent review before the final gate

### NSH, Reviewer A — correctness, lifecycle, state

Blockers: the macOS backend did not compile (`SetQuitOnLastWindowClosed`
arm missing); `nsh-engine` fixtures mounted plain roots; the headless windows
fixture count was stale.

Majors: JS `lastWindowClosed` listeners could not change an already-read
policy; `setQuitPolicy` bypassed the `application` capability; headless ignored
`DesktopCommand::Quit`; the app-root/lifecycle fixtures were unwired; Rust
app-root `on_key` never fired and had no scope; headless Tab ignored the
focused window; macOS URL open showed the host; `Application.quit()` close
semantics were documented wrong; no end-to-end quit-policy test.

### NSH, Reviewer B — platform, API, tests, compatibility, docs

Blockers: TUI mount validation treated a terminal as a desktop; the GPUI dev
host did not compile with the new protocol field; the documented Rust
`is_desktop`/`window()` pattern rendered nothing on a desktop browser and in a
terminal; mobile `<Window>` did not provide `currentWindow()` while the compat
case used it.

Majors: Rust key scope; missing website keymap docs; false JS listener timing;
`quit()` close-policy docs; updates dropped the shipped `application` policy;
menu docs contradicted the implementation; the embedded GPUI example changed
behavior; the tray example relied on the retired `defaultVisible`; macOS host
fixtures were not migrated; Rust off-desktop window docs; a documented Rust
quit setter did not exist.

### Flow, Reviewer C — app root and project window

Blocker: the NSH dependency was a local path, not a commit pin (the task
forbids pushing NSH).

Majors: a failed close could not retry and left a dead window; an open could
race a quit; multi-window session cleanliness used the wrong project; a failed
`quitRequest` quit silently; recovery was offered only under `lastProject`; no
quit coverage and headless could not quit; close-during-failing-open
completed twice.

### Flow, Reviewer D — projects, settings, quit, state

Blockers: only the first app window inherited the hidden title bar; session
cleanliness used the wrong project with several windows; a failed quit was
silent; a failed close could not retry; a post-open close failure orphaned the
lease after the window was removed.

Majors: project-root mismatch missing; no automated quit/reopen coverage; host
coverage lacked multi-window/focus/Settings/native chrome; the store held a
per-window store handle against the new standards text; new areas were absent
from boundary fixtures; CHANGELOG/testing docs/CLAUDE.md stale; path pin.

## Fixes applied after Round 1

- macOS arm; engine/TUI/mobile fixtures and mount validation; GPUI dev bundle
  carries `application`; Rust `window()` degrades to content off the desktops
  and in a terminal; templates/docs use the one-declaration form.
- Headless `DesktopCommand::Quit`, `app.quit()`, `app.quitRequest()`,
  `app.windowIds()`; headless wait loop and per-window viewport sizes; host
  `TestStep::WindowIds`; Screen modal clipping by the containing window.
- JS/Rust key scopes; Rust app-root bindings app-wide; docs state the JS
  `lastWindowClosed` timing; `setQuitPolicy` gated by the `application` grant.
- Flow: explicit `titleBar` on every `<Window>`; the session points at the
  last open project and is clean only after a complete clean quit; `on("quit")`
  returns the shutdown promise; system quit requests enabled on macOS; retry
  guard; quit blocks late opens; unconditional recovery card; New Project
  shortcut; Settings window; multiple project windows; quit/last-window/macOS
  reopen/multi-window/Settings tests.
- Docs: RFC status/known deviations/platform table; website EN/ZH; Flow
  architecture/code map/standards/projects plan.

## Final gate — two independent reviewers on the fixed tree

### Reviewer A — lifecycle/state/correctness

Not signed off. Blockers: Flow close retry (the workspace cached the failed
shutdown and the handle was disposed); release CLI/types/gate evidence stale
(path dependency). Majors: terminal `Window.open` and `isAvailable`; Windows
`Menu.popup` owned by the hidden host; host `setViewport` resized the host;
no user-visible quit-failure report. Minors: session key deleted before load;
startup rejection left no window; `Settles` over-promised async listeners;
launch defaults consumed by a denied window; `Screen.window_sizes` leak; stale
logs/docs/dead code.

### Reviewer B — platform/API/compat/docs

Not signed off. Blockers: dev hosts showed the hidden host when `nsh.json` had
no `window` block; GPUI docs claimed the old model while the v2 mount check
rejects plain roots; many website snippets still mounted plain roots; Flow
pin/CLI/README/packaging state stale (path dependency). Majors: capability
reference omitted `setQuitPolicy`; `main_window().show()/focus()` could reveal
the host; stale platform dev docs; the RFC named Flow; no `mod+w` in Flow on
Windows; a failed-open lease could be stranded; `Settles` over-promised; test
API docs missing the new calls and the web `window_ids` default.

## Fixes applied after the final gate

- Flow retry: `shutdownWorkspace` keeps a handle whose close failed; the
  workspace clears its cached failure and runs another close job; `dispose()`
  releases the handle when the window goes. `shutdownAllProjects` uses
  `Promise.allSettled`; a non-last close keeps the session on an open project;
  the startup save effect waits for `appReady`; the startup IIFE catches a
  Storage rejection; `lastWindowClosed` sets quitting; project/document windows
  bind `mod+w`; a quit failure keeps the app open with a notice; Settings save
  failure is shown. Tests/docs updated.
- NSH: dev hosts use `is_some_and(visible_at_launch)`; terminal
  `Window.open`/`isAvailable` use the windowless predicate; the launch-defaults
  flag is set only after the access check; `Screen.window_sizes` is pruned;
  `main_window().show()/focus()` are no-ops at the app root; Windows context
  menus use the app window HWND; the Windows test resize targets the focused
  app window; docs/website updated (GPUI, capability grant, test API, RFC
  application names, keymap scope, `main` id, platform pages).
- Release CLI rebuilt from the frozen tree; Flow types regenerated; gates
  rerun.

## Cross-review — third reviewer on the fixed tree

Verdict: **NOT SIGN OFF**. The reviewer confirmed the earlier fixes listed
above, and found these remaining or newly introduced defects:

- Flow `mod+w` was bound in the component that returns `<Window>`, which runs
  in the app root: the binding was app-wide and the newest binding won in
  every window, so it could close a project window from Projects/Settings.
- Flow's quit-failure notice was unreachable for the ordinary failure: a
  failed close reports `clean: false` (not a rejected promise), and the
  handler quit anyway.
- The Windows context menu fix was dead: JS `Menu.popup` still addressed the
  hidden host, and `app_window::handle` swallowed `WM_NSH_MENU` in its
  `m >= WM_APP` arm.
- macOS/Linux test agents still resized the hidden host, so the migrated
  macOS `Resize.test.tsx` would fail; Windows lacked a first-open fallback.
- Docs: GPUI pages claimed `"defaultVisible"` still shows the host,
  `nsh-desktop` omitted the terminal exception from `isAvailable`, the RFC
  claimed no native tests were updated, and several website mount examples
  still mounted a plain view root.

## Fixes applied after the cross-review

- Flow binds `mod+w` in a `CloseOnModW` child rendered inside the window's
  view tree, so the keymap's window scope is the window the shortcut belongs
  to; a quit with `clean: false` stays open with a notice, keeps the windows
  and leases for a retry, records the session unclean, and clears the cached
  shutdown. `stayOpen` also answers the platform's pending quit request
  (`Application.cancelQuitRequest()`), so macOS notifies the app again on the
  next Cmd+Q instead of holding the failed request forever.
- NSH retargets `Menu.popup` to the focused window root on Windows only (its
  HWND must own the menu); macOS and Linux keep the app-level menu. The
  Windows app window handles `WM_NSH_MENU` itself, and the host falls back to
  the focused app window. The test agents resize the targeted (else focused
  or first open) app window instead of the host on macOS, Windows and Linux.
- Docs: GPUI `defaultVisible` wording, `isAvailable` terminal exception, the
  RFC's native-test status, and every remaining website `mount(...)` example
  (192 mount-bearing blocks in 148 files; EN and zh-CN) now declares a top-level
  `<Window id="main">` — in the mount wrapper, or in the `App` it mounts —
  with the window import added to each block. Every modified TSX block was
  parsed with Bun's TSX transpiler. The macOS menu-bar example now calls
  `currentWindow()` inside the window it declares. The note in
  `jsx-and-components.md` remains for older external copies.

Gate fix outside the v2 diff: the Windows workspace run found a pre-existing
portability bug in `nsh-js`'s browser `path` module (`join_path`/`relative`
returned `\` on Windows); `portable()` maps it back to `/` and the existing
`virtual_cwd_resolves_and_relativizes_browser_paths` test passes.

A second cross-review is recorded below.

## Second cross-review — sign-off

Verdict: **SIGN OFF** (2026-11-18). The reviewer re-read the stable tree and
confirmed the macOS quit retry, the Windows targeted viewport, the GPUI docs
correction, and the complete website sweep (0 plain-root TSX blocks remain;
all 192 mount-bearing blocks declare a top-level `<Window>`). No blockers or
majors remain.

Accepted minors: a stale non-root Windows test target falls back to the host;
the legacy `DocumentWindow` path has no notice on a failed quit; no automated
Flow test for `clean:false`/`cancelQuitRequest` or a two-window `mod+w` (the
NSH keymap/quit mechanisms are covered). 待平台验证: macOS/Linux host resize,
the macOS pending-quit retry, Windows real-host popup ownership and
coordinates, and GPUI. GPUI remains unmigrated: its clippy passes, while its
JS AppView suite (`tests::windows`, one test) still mounts pre-v2 plain roots
and stops at the shared mount check, so the rest of that suite does not run
until the embedding model is migrated; this is recorded in
`docs/dev/gpui.md`.

Delivery follow-up (2026-11-18): the path-dependency blocker is closed. NSH
is pushed on `YougLin-dev/nsh` at `025650b0b3731533773d8a2188e3f2ef97469944`
(rebased onto upstream `main`), with the
[upstream PR](https://github.com/longbridge/nsh/pull/2307) opened; Flow pins
that commit for `nsh-core`, regenerates its types from the same commit, and both
workflows build the CLI from it. The rebase's conflicts (headless host
hiding, the mobile system bar and window sizes in the screen model, packaging
data dirs, and a duplicated `nsh/desktop` docs row) were resolved and the
full gate rerun before the push.

Addendum: the gate found and fixed a pre-existing Windows portability bug in
`nsh-js`'s browser `path` module (see above); the reviewer verified the diff
and confirmed the prior SIGN OFF stands. The same review notes that upstream's
other `path` exports (`join`, `normalize`, `format`, `sep`) still carry
Windows semantics — pre-existing, outside the v2 diff, and a follow-up if
`nsh:path` must be fully POSIX on Windows.

Final review round (2026-11-18, on the delivery commit): three independent
reviewers (the app-root guard, the rebase, and the Flow pin/CI/docs) and an
adversarial verification pass confirmed six findings, all fixed: the Windows
`transparent` example still mounted a plain root (it now declares its window
with `transparent` and `taskbar` attributes); the new app-root guard dropped
`request_attention`, an app-level request (it now passes like the attributes
do, documented and covered by the guard test); the second rebase lost
upstream's Linux desktop-entry rows in `docs/dev/linux.md` (restored); two
upstream TSX entries (`examples/bench/TextViewStream.tsx` and the
`input-focus` gallery fixture) lacked their top-level `<Window>` (added; both
parse with Bun's TSX transpiler); and the PR body's website-sweep count was
stale (192 mount-bearing blocks in 148 files, all declaring `<Window>`). Two
further notes were refuted by verification (a test-coverage suggestion for
the guard, and the gallery fixture, already fixed at verification time). The
final tree passed `cargo test --workspace` (6133 passed, 0 failed, 77
ignored), `cargo clippy --workspace --all-targets -- -D warnings`, the GPUI
workspace's clippy and `cargo +nightly fmt --all --check`, and was pushed as
`025650b0b3731533773d8a2188e3f2ef97469944`.
