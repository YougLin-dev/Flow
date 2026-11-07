# Flow Engineering Standard

**Status.** Normative for every change in this repository, human or AI.
**Precedence.** Committed configuration is enforcement truth: `vite.config.ts`,
`src/tsconfig.json`, the root `tsconfig.json`, `lint/boundaries.js`,
`src/nsh.json` and `bun.lock`. If this document and an enforced rule disagree,
the rule wins; fix this document in the same change. Never weaken a rule
silently.
**Language.** MUST and MUST NOT are mandatory; SHOULD is the expected default
unless the PR states a reason and a reviewer accepts it; MAY is optional.
**Enforcement tags.** **Lint** = Oxlint rules in `vite.config.ts` run by
`bun run check`; **Type** = `nsh check src` and the `typeCheck` step;
**Lint test** = `bun run test:lint` (inside `bun run check`); **Test** =
`bun run test` (`nsh test src`); **Host** = `bun run test:host`;
**Review** = the checklist in section 11; **Manual** = light/dark, screen
reader, profiling or target-OS evidence; **CI** = the workflows. A rule claimed
as automated MUST have a fixture or test proving it can fail; for the boundary
plugin that is `lint/boundaries.test.js`. A check that cannot fail is a bug,
not enforcement.

## 1. Purpose, scope and normative language

This standard defines how Flow is extended without eroding its architecture.
Flow is an NSH TSX application whose only canvas is a Leafer scene. Its
correctness depends on three things a generic style guide cannot protect:
the one-way module graph, NSH's recording canvas and its once-run components,
and Leafer's ownership of the retained scene and editor.

**Scope.** Every file under `src/` (the NSH app root), plus repository tooling:
`vite.config.ts`, both tsconfigs, `lint/boundaries.js`, `lint/boundaries.test.js`,
`scripts/`, `.github/`, `package.json`, `bun.lock`, `src/nsh.json` and `docs/`.
Feature specifications, copy and roadmap are out of scope.

**The gate.** A change is verified only by `bun run check` (which runs
`nsh check src && vp check --deny-warnings && bun run test:lint`) and
`bun run test`. Warnings fail the gate. `bun run test:web` runs the same tests
on the web target and is run by CI on Linux; `bun run test:host` adds real
desktop input and window evidence; `bun run package` adds installer evidence
on the target OS. These commands are the contract, not suggestions. Exception
handling is defined in section 12.

Existing documents stay authoritative for their details:
[architecture](architecture.md), [conventions](conventions.md),
[testing](testing.md) and [packaging](packaging.md). This standard states the
rules those documents explain and resolves their conflicts.

## 2. Core principles

1. `src/` is the NSH application root. Every NSH command targets it.
2. Dependencies flow down. Every piece of state has one narrow owner.
3. An NSH component body runs once. Only bindings re-run; there is no
   re-render and no virtual DOM.
4. Derive values; never mirror them. An effect that writes the signal it reads
   is a bug.
5. Leafer owns the retained scene, selection, dragging, resizing and culling.
   The platform adapter owns everything NSH-specific; app code owns neither.
6. Types are proofs at boundaries. `any`, `as` narrowing and `!` replace proof
   with belief and are not allowed in app code.
7. Semantic design tokens and programmatic accessibility are correctness
   requirements, not polish.
8. Test at the lowest layer that can catch the bug. The gate plus the evidence
   for that layer is the definition of done.

## 3. Architecture and dependency rules

### 3.1 App root and NSH configuration

`src/nsh.json`, `src/theme.json`, `src/App.tsx`, `src/assets/` and every app
module MUST stay under `src/`. Every NSH command MUST pass `src` (`nsh run src`,
`nsh build src`, `nsh test src`, `nsh check src`, `nsh package --target <os>
src`). `src/tsconfig.json` MUST extend `./.nsh/tsconfig.json`; the root
`tsconfig.json` MUST extend `./src/tsconfig.json`. Generated `src/.nsh/` and
root `.nsh/out` MUST NOT be edited or committed. Asset and theme paths in
`src/nsh.json` are relative to the app root. (Lint, Type, CI, Review)

### 3.2 The layer graph

`boundaries/no-upward-import` in `lint/boundaries.js` enforces this table for
relative imports. Tests are exempt because they may reach into any layer.

| Layer        | Path                                   | MAY import                                           |
| ------------ | -------------------------------------- | ---------------------------------------------------- |
| Shell        | `src/App.tsx`                          | every layer                                          |
| Page         | `src/pages/**`                         | pages, components, store, types, foundations, assets |
| Component    | `src/components/**`                    | components, types, foundations, assets               |
| Store        | `src/store.ts`                         | store, types, foundations, assets                    |
| Types        | `src/tool.ts`                          | types only                                           |
| Foundation   | `src/flow/`, `src/leafer/`, `src/lib/` | foundations, types, assets                           |
| Asset        | `src/assets/**`                        | nothing                                              |
| Unclassified | any other `src/` module                | nothing until classified                             |

Components, the store and foundations MUST NOT import a page or `src/App.tsx`.
Foundations MUST NOT import the store. Cycles are forbidden. A page MAY import
another page's public module, but MUST NOT reach into another page's private
state or internals; mutable state shared across pages goes through
`src/store.ts`. A new directory or facade MUST be classified in `LAYERS` and
`layerOf`, and MUST extend `lint/boundaries.test.js` with both a file and a
bare-directory spelling plus an allowed and a disallowed direction; an
unexplained `other` classification is a review failure. (Lint, Lint test,
Review)

### 3.3 Facades and internals

`src/leafer/nsh-platform.ts` is the public facade over `src/leafer/platform/`.
Consumers import the facade, never a `platform/*` module; the platform modules
import each other directly. The same facade pattern applies only when a
directory has internal modules that must stay replaceable; it is not required
for `flow/` or `components/`. (Review; no lint rule bans deep platform imports
today.)

### 3.4 Import safety and ownership

A module MUST be import-safe: top-level code may declare types, constants and
pure functions only. The only permitted import-time effects are `mount(App)` in
`src/App.tsx`, `installWindowChrome()` called exactly once by `src/App.tsx`,
and the guarded, idempotent `installNshPlatform()` on the canvas host. Timers,
frames, listeners, key bindings, editor listeners and subscriptions MUST be
created by the component, page or store action that owns them. (Review)

## 4. Module and public-API design

- One job per module, named after it. Components are PascalCase `.tsx`, one
  component per file, named after the export. Modules and directories are
  kebab-case. Tests are `<subject>.test.ts(x)` beside the subject. (Lint)
- `max-lines` caps a module at 500 code lines, excluding blanks and comments.
  It is a prompt to find a seam, never a target. Avoid `utils.ts` grab bags.
  (Lint)
- Exports MUST be named. Default exports are allowed only in
  `vite.config.ts`, `scripts/**` and `lint/**`, as configured. App modules
  MUST NOT default-export. (Lint)
- Object shapes MUST use `interface`, including every exported
  `<Name>Props`; unions, tuples, mapped and conditional types MUST use `type`.
  Props interfaces MUST document non-obvious fields. (Lint, Type, Review)
- Exported functions SHOULD declare their return type when it is not obvious;
  async exports MUST declare `Promise<T>`. Parameters at an export boundary
  MUST be typed. (Review, Type for the resulting contract)
- The public surface is deliberately small: component props, store readers and
  actions, and the adapter facade. Everything else is internal. Exported
  names and signatures SHOULD evolve additively; a breaking rename MUST update
  every call site, test and doc in the same change. (Review)
- Data is immutable by default. Fields the owner does not mutate SHOULD be
  `readonly`; exported constant tables SHOULD be `readonly` or `as const`. A
  function MUST NOT mutate a parameter, prop or imported object unless its
  name and contract say it mutates. Mutable `let` state may exist only inside
  its owner. (Type, Review)
- Comments explain why (a platform quirk, an invariant, a workaround), not
  what the next line does. No commented-out code. (Review)

## 5. TypeScript and error handling

- Code MUST compile under the committed flags: `strict`,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch`. A contributor MUST NOT weaken a flag.
  `@ts-ignore` is forbidden. `@ts-expect-error` is allowed only with the
  upstream issue and a removal condition on the same line. (Type)
- `any` MUST NOT appear in app code or tests, explicitly or through an unsafe
  flow. `typescript/no-explicit-any` and all `typescript/no-unsafe-*` rules
  are errors. Values from Leafer, NSH, `JSON.parse` or any untyped source MUST
  enter as `unknown` and be narrowed with `typeof`, `in`, `instanceof`,
  `isRecord` or a validating type predicate before use. Only
  `src/leafer/nsh-platform.ts` and `src/leafer/platform/**` may touch Leafer's
  untyped internals. (Lint, Type, Review)
- `as` MUST NOT replace a guard in app code and `!` MUST NOT be used.
  Exceptions are narrow: tests may cast through `unknown` to build a canvas
  stand-in, and a documented platform boundary may cast after a guard and with
  a comment naming the invariant. Any remaining cast is a review item. (Lint
  `no-unsafe-type-assertion` and `no-non-null-assertion`; tests disable only
  the former.)
- A switch over a closed union (`Tool`, operation kinds, path rules, editor
  modes, future routes) MUST handle every member or end with a `default` that
  throws an `Error` naming the unexpected value. A normal fallback is
  forbidden because it hides a new member. (Lint, Type, Review)
- Type-only imports MUST use `import type` or `import { type X }`. With
  `exactOptionalPropertyTypes`, optional props MUST be passed conditionally,
  not assigned `undefined`. (Type, Lint)
- Every promise MUST be awaited, returned, or have both handlers. No floating
  promise, no async function in a `void` position, no `await` on a
  non-thenable. Use `try/catch` with a `catch` variable of type `unknown`, or
  return the rejection. A bare empty catch is forbidden; a catch that
  deliberately skips an unsupported native call MUST say so in a comment and
  belongs only at the adapter's replay/measurement boundaries. Throw `Error`
  objects; unsupported async platform operations MUST return
  `Promise.reject(new Error(...))`, not throw synchronously. (Lint for empty
  blocks, Review for deliberate skips.)

## 6. State, reactivity, UI and accessibility

### 6.1 State has one narrow owner

| Owner                           | Owns                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| `src/store.ts`                  | tool, zoom percentage, selection count, window pin                      |
| Page (`src/pages/FlowPage.tsx`) | `CanvasCamera`, `IEditorBase`, stage size, zoom frame, user-camera flag |
| Component                       | transient press, hover, cursor and pinch state it renders               |
| Future route (`NavStack`)       | stable route identity and the data the page needs                       |

Every signal in `src/store.ts` MUST stay module-private. The module MUST export
readers (`currentTool()`, `zoomPercent()`) and actions (`setTool`,
`togglePinned`), never a signal, setter or mutable object. Actions MUST enforce
their invariants; `togglePinned` no-ops when `nsh/desktop` is unavailable. A
reader MUST read the signal when called, not capture it at module load. The
store MUST NOT hold per-mount handles such as the camera or editor. A page
MUST NOT keep a private copy of store state. Components MUST take values and
intent callbacks as props and MUST NOT import the store. A controlled
component keeps no private copy: it receives the current value plus a change
callback, and the owner applies the change so the next value matches what the
control reported. Use one `batch` only when several writes form one invariant;
`batch` is not a performance ritual. (Review; boundary lint for component and
foundation imports; `store.test.ts` and `App.test.tsx` for behavior. No lint
checks signal privacy.)

### 6.2 Reactivity

A component body MUST be one-time setup. Props and signals MUST be read where
they are used (`props.title`, `currentTool()`), never destructured or cached in
the body unless a one-time read is intended. Conditional bindings (`&&`,
ternary) are fine; reactive lists SHOULD use `<Each>` and reactive conditionals
MAY use `<If>` or function children. Static `.map` over a constant array is
fine. Event handlers are installed once and MUST read the current value when
invoked. Async work MUST read signals synchronously before the first `await`;
reads after `await` or in timers are not tracked. Values derivable from other
state MUST use `computed` (or a cheap closure), not a second signal written by
an effect. An effect MUST synchronize an external system (Leafer recolor,
window level, frame scheduling) and MUST NOT write a signal it also reads.
User intent belongs in the handler or keymap action that received it. NSH does
not accept signal writes during `draw`; publish after the frame, as
`FlowPage` does for the zoom label. (Review; behavior tests expose stale
snapshots. No lint sees destructuring, mirroring or effects.)

### 6.3 UI, design tokens and accessibility

Colors, radii, spacing, typography and shadows MUST come from semantic tokens
in `src/theme.json` via `token()` or token classes such as `bg-card`,
`text-muted-foreground`, `border-border` and `rounded-(--radius)`. App code
MUST NOT contain raw hex, `rgb()`/`rgba()`/`hsl()` or palette classes. When a
role is missing, add a semantic token with both light and dark values. Token
classes adapt automatically, so `dark:` MUST NOT be used for token colors; use
`hover:`, `active:`, `focus:`, `selected:` and `disabled:` or component state
props. Exceptions: `src/theme.json` itself, test fixtures, and the Canvas 2D
protocol defaults in `src/leafer/platform/recording-context.ts` (`#000000`,
`rgba(0,0,0,0)`), which MUST keep a comment. A new or changed token pair MUST
be checked as an actual foreground/background pair: 4.5:1 for normal text,
3:1 for large text, UI boundaries, focus and state indicators. Do not assume a
token is accessible in every pairing. Raw point values are allowed only for
audited platform chrome geometry or canvas coordinates, with a comment.
(Review, Manual light/dark; no lint rule covers raw colors.)

Every interactive element MUST expose a programmatic name, role and state.
Prefer `nsh/base` controls (`Button`, `Checkbox`, and the like) over a
pressable `View`; an icon-only control MUST set `accessibilityLabel`, and a
`testID` is not a name. Expose selection with `selected`, disabled with
`disabled`, and never with color alone. The canvas MUST have a label;
selection count, active tool and zoom MUST be mirrored in accessible text, as
the overlays do. Every chrome action MUST be keyboard operable except a
documented path-dependent exception. Keyboard-operable views MUST have a
visible `focus:` style. Canvas direct manipulation is the documented
exception: selecting, moving and resizing cards is a pointer gesture owned by
Leafer's editor, and a keyboard editing path is adoption debt. A drag- or
pinch-only non-canvas operation MUST have a single-pointer, non-drag
alternative; new camera animation MUST honor `reduceMotion()`. Small icon
targets SHOULD use `hitSlop` to reach roughly 44 by 44 points. Contrast is
4.5:1 for normal text and 3:1 for large text, interactive control boundaries,
focus and state indicators; decorative card and section borders are exempt.
(Review, Manual host screen-reader pass; `App.test.tsx` uses `id:` and
`label:` selectors.)

## 7. Canvas, Leafer and the platform adapter

### 7.1 The NSH canvas contract

NSH `<Canvas>` is a recording surface. `draw` runs after first layout, on
resize, and when a signal read inside it changes; each run replaces the whole
drawing. Signals MUST be read inside `draw` if they should schedule it, and
work MUST be proportional to what is visible. Code MUST NOT mutate the canvas
outside `draw`. (Test, Review)

### 7.2 Leafer owns the retained scene and editor

Build the scene once in `src/flow/scene.ts` from `src/flow/data.ts`, in world
coordinates. Only the camera group moves. Selection, dragging, resizing and
rotation MUST use Leafer's editor (`app.editor` in the `sky` layer), not
hand-written pointer math. Decorative children MUST set `hittable: false`;
editable cards MUST set `editable: true`. Do not recreate nodes per frame or
per resize and do not add a parallel cull walk. The dot grid is the only
immediate-mode drawing: screen space, before replay, never hit-tested. Derived
geometry such as connectors MUST be recomputed when its owner moves or resizes
(the current `PropertyEvent.CHANGE` listeners in `flow/scene.ts` are the
mechanism) and MUST be covered by a scene test after a drag or resize. Moving
the camera changes the selected elements' world bounds without changing the
elements, so pan, zoom and fit MUST refresh the editor box with
`refreshEditBox` (`src/leafer/editor-box.ts`); `updateEditBox()` is required
for multi-selection, whose box is built from a simulated element. (Test,
Review)

### 7.3 Adapter confinement

`Platform`, `Creator`, `InteractionBase`, raw canvas contexts,
`NshRecordingContext`, `NshCanvasSurface` and every `src/leafer/platform/*`
module MUST stay inside `src/leafer/nsh-platform.ts` and its implementation
modules. Pages, components, `flow/` and `store.ts` MAY use Leafer's public
scene/editor API (`@leafer-ui/miniapp`, `App`, `IEditorBase`) but MUST NOT
import a platform module, call `Platform`/`Creator`, or hold a recording
context or surface as app state. New platform behavior MUST land in exactly
one matching module. Export it through the facade only when app code needs it.
A page-level workaround is not an adapter extension. A hidden Leafer field MUST
be read behind a narrowly typed, guarded adapter helper with a test; the
`renderer.requestTime` reset lives in `src/leafer/platform/frame.ts`. No other
app module may read a hidden Leafer field. (Review; adapter tests.)

### 7.4 Recording and replay are one contract

Every state mutation Leafer can make MUST be recorded in order, and every
recorded operation MUST have a defined replay behavior: replayed, deliberately
emulated, or explicitly skipped. A skip MUST be documented and tested as a
no-op, never a crash or a silent wrong result. `beginFrame()` MUST reset ops,
CTM, state stack, path, hit regions and styles. `replay()` MUST reset the
native transform and dash list first. `save()`/`restore()` cover styles and
transform, not the current path; only `beginPath()` starts a new path. Style
properties MUST be recorded as data: `globalAlpha`, `lineWidth`,
`globalCompositeOperation` and shadows pass through verbatim; only
`fillStyle`/`strokeStyle` may hold paint records. Offscreen surfaces are
ephemeral: snapshot before Leafer recycles, copy the ops array, and replay as
vectors into the destination rectangle. `drawImage` MUST support the 2-, 4- and
8-argument forms. A snapshot is a layer: its recorded `globalAlpha` values MUST
multiply the destination's current alpha, its `setTransform`/`resetTransform`
MUST compose with the placement matrix, and its content MUST be clipped to the
destination rectangle (and the source rectangle when `drawImage` supplies one).
A full offscreen `clearRect` starts a new recording; a partial clear is not
emulated and MUST NOT be relied on. Pattern fills are emulated for `fill` and
`fillRect`; patterned strokes and text are skipped as documented limitations.
Replaying a snapshot or a patterned `fillRect` may replace the native current
path; a caller that needs the path afterwards must rebuild it. Snapshot tile
dimensions MUST be positive and finite. (Test: every newly supported operation
gets a record, replay and effect test in `src/leafer/nsh-platform.test.ts`;
Review.)

### 7.5 Geometry, coordinates and numeric robustness

Use the canvas matrix convention: `a b c d e f` maps `(x, y)` to
`(ax + cy + e, bx + dy + f)`. `transform`, `translate`, `scale` and `rotate`
post-multiply; `setTransform` replaces the CTM; `resetTransform` clears it.
Pair `save()` with `restore()` and start every frame at identity. Hit paths are
recorded in the context's user space and transformed when filled or hit-tested,
so a caller MUST NOT change the CTM between path construction and
fill/hit-test and expect Canvas's bake-at-command semantics; baking at command
time is adoption debt. The camera MUST store logical `x`, `y` and `scale` and
rebuild its matrix from identity; it MUST NOT compose deltas onto a previous
matrix. Keep world, screen/points and canvas user space explicit, converting
only through `CanvasCamera.toWorld`/`toScreen` or an explicit matrix. NSH draws
in points: `devicePixelRatio` MUST remain 1, sizes MUST NOT be multiplied by a
ratio, and canvas dimensions MUST be rounded once at the frame boundary with
`Math.max(1, Math.round(...))`. Reject non-finite coordinates, zero or
negative sizes, non-positive scales and singular matrices. `invert` returns
`null` for a singular or non-finite matrix; a hit under a degenerate transform
MUST return `false`; `lineWidth` MUST be positive and finite. Geometry MUST NOT
be coerced with truthiness such as `Number(x) || 0`; use `Number.isFinite`.
(Test, Review)

### 7.6 Hit testing is geometry, not pixels

Hit tests MUST answer from recorded geometry: `isPointInPath` applies the fill
rule (nonzero by default, even-odd when requested), `isPointInStroke` applies
the transformed stroke width, and a hit canvas's `getImageData` returns a
synthetic alpha mask. Hits MUST be tested topmost-first, and hit canvases MUST
stay separate from render canvases (`hitOnly`). `addHitRegion` MUST NOT be
used. Fill closes open subpaths implicitly; stroke does not; both behaviors
MUST be tested. Hit canvases MAY flatten curves; render canvases MUST NOT.
Text uses `measureText` through the frame's native context; its approximations
MUST be documented and edge-tested. (Test, Review)

### 7.7 Resources and input

Every Leafer `App`, `Leafer`, host, editor listener, frame requester,
animation frame and measure context MUST be owned by the scope that creates it
and released when that scope is disposed: `app.destroy()`, the cleanup from
`addDrawRequester`, `cancelAnimationFrame`, `editor.off(...)`, and
`LeaferHost.dispose()` for the measure context. The last frame's native context
may be retained between frames for text measurement; `measureText` falls back
if it throws. Cleanup MUST be idempotent and MUST restore globals it replaced.
Tests MUST destroy every Leafer `App` or `Leafer` they create.
`installNshPlatform()` is the one guarded, process-wide install. Each view
registers its own draw requester; `Platform.requestRender` notifies all of them.
(Test: adapter and lifecycle tests; Review.)

Canvas input MUST use NSH responders. A canvas inside a scroll view MUST claim
drawing touches on start (`onStartShouldSetResponder={() => true}`). NSH
press, mouse and touch events MUST be fed to Leafer through `pointerData()`,
and the cursor state MUST mirror Leafer's. Trailing mouse events after a touch
MUST be ignored, as `LeaferView` does. Gestures belong to Leafer's editor;
hand-written input SHOULD stay minimal. (Test: `editor.test.ts`,
`App.test.tsx`; Host for real pointers.)

## 8. Async, lifecycle, performance and security

### 8.1 Async and lifecycle

Signal reads needed by async work MUST happen synchronously before the work
starts. Stale results MUST be dropped by revision or identity. Errors MUST
surface in the UI where the owner can act; log-only feedback is not handling.
An effect MAY return its cleanup; otherwise use `cleanup(fn)`. NSH has no
`onMount`; do not write one. Cleanup MUST be idempotent. Store-started one-shot
work is allowed only when explicit and documented. (Review, Type, Test)

### 8.2 Performance

Each NSH `draw` is a full frame: record, draw the backdrop, render Leafer's
`tree` and `sky`, replay, clear render marks. Per-frame work MUST be
proportional to visible primitives; let Leafer cull. App code MUST NOT rebuild
the scene, traverse the whole scene, or write a signal every frame. Batch
paths and style changes, avoid per-pixel or per-scanline allocation, and never
add a second render loop: `Platform.requestRender` is coalesced into one
`requestAnimationFrame` by the canvas host. `usePartRender` MUST remain
`false` until replay understands dirty rectangles and that is tested. Frame
budgets (about 10 ms of app work and 16.7 ms per frame at 60 Hz, 50 ms
input-to-feedback) are SHOULD targets measured manually on the reference host;
they MUST NOT be asserted in CI without a stable benchmark. (Review, Manual
profiling; the `perf` lint category is only a warning.)

### 8.3 Security and the sandbox

`src/nsh.json` MUST keep the `capabilities` key; its presence is what switches
the app to allow-list mode. `capabilities.network.hosts` MUST stay empty unless
a real integration needs a host. Adding a host MUST be a reviewed change with
an ADR, using the exact host; a wildcard MUST NOT be used. Bundled files MUST
use imported assets or `asset:` URIs. Even though NSH enforces the sandbox in
Rust, app code MUST validate a document-supplied URL (HTTPS scheme, expected
host) before `fetch`, `Image.getSize` or `loadContent`. `eval`, `new Function`,
`vm` and dynamic `import()` of user-controlled strings MUST NOT be used.
Untrusted JSON MUST be size-limited, parsed with `JSON.parse`, schema-validated
for required and additional properties, nested types and array lengths, and
rejected on failure; numbers MUST be finite and bounded before geometry or
image use. Clipboard, drop, picker, query strings and file names are untrusted.
(Review; NSH build/package validation when run.)

### 8.4 Dependencies, CI and release

Dependencies MUST be declared in `package.json`, pinned exactly (no `^` or
`~`), resolved by the committed `bun.lock`, and installed in CI with
`bun install --frozen-lockfile`. `packageManager` MUST name an exact Bun
version and `engines` the supported minimum. A new runtime dependency MUST have
an ADR covering need, license, maintenance, runtime and bundle cost, and why
the adapter or an existing package is insufficient. Lifecycle scripts and
`trustedDependencies` require review. Removing a package MUST remove its
imports, types, tests and docs. `bun audit --audit-level=high` SHOULD run
before a release. (CI, Review)

Workflows MUST declare `permissions: contents: read` and elevate per job only.
Secret-bearing actions SHOULD be pinned to a full commit SHA. Secrets MUST be
available only to the release job through `env:` and MUST NOT be interpolated
into `run:` or exposed to fork code. Installer scripts SHOULD be vendored or
checksum-verified instead of piping a mutable remote script to a shell; the
NSH version (`NSH_VERSION`) MUST be pinned. The release workflow MUST run
`bun run check` and `bun run test` before `bun run package`, and the release
tag MUST equal `version` in `src/nsh.json` (the workflow checks this). `build`
increments per release; `id` never changes. Installers SHOULD be
signed/notarized and checksummed before public distribution, as described in
[packaging](packaging.md). (CI, Review)

No `console.log`, `debugger`, scratch file, probe test, commented-out code or
unreviewed suppression may remain in `src/`. `console.error` is allowed for a
failure that is surfaced to the user; `scripts/**` may log progress. (Lint,
Review)

## 9. Testing and verification

| Level       | Files                                                                                                                                 | Proves                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unit        | `src/leafer/camera.test.ts`, `src/leafer/nsh-platform.test.ts`, `src/flow/data.test.ts`, `src/flow/grid.test.ts`, `src/store.test.ts` | Pure logic, the adapter, data and store behavior                     |
| Lint rule   | `lint/boundaries.test.js`                                                                                                             | Layer classification and the rule's upward/unknown reports           |
| Integration | `src/leafer/editor.test.ts`, `src/leafer/culling.test.ts`, `src/flow/scene.test.ts`                                                   | Leafer editor/culling and the built scene against `NshCanvasSurface` |
| End-to-end  | `src/App.test.tsx`                                                                                                                    | The mounted app: text, presses, drags, keyboard                      |

Tests under `src/` MUST sit beside the subject, import from `nsh/test`, and use
the lowest level that catches the bug. Tooling tests such as
`lint/boundaries.test.js` use `bun:test` because they run under Bun, not NSH,
and are part of `bun run check` through `bun run test:lint`. Each test MUST
cover one behavior and be named for the user action or invariant. App tests
MUST select by `id:<testID>`,
`label:<accessibilityLabel>`, `text:<text>`, `view:<id>` or a bare string (test
id, label, then text). There is no `role:` selector; do not write one.
Positional selectors MUST NOT be used. `app.waitUntil` MUST be used instead of
sleeps; the only permitted real timer is the documented 200 ms double-click
spacing in `src/leafer/editor.test.ts`, and any new one needs the same comment
and reviewer approval. Tests MUST NOT share mutable state. Every Leafer
`App`/`Leafer` MUST be destroyed. App tests MUST stub the network (a request
not listed fails by default) and use a manual clock when time matters; `live`
network is allowed only in an explicit integration test with review. Canvas
state MUST be asserted through overlays, the scene or the camera, not pixels.
`store.ts` readers and actions MUST be unit-tested directly in `store.test.ts`
and their page wiring MUST be covered by `App.test.tsx`; this resolves the
older "store through the page" wording in `docs/testing.md`. (Test, Host,
Review)

A deterministically reproducible bug fix MUST add a regression test that fails
before it and passes after. Every newly supported adapter feature MUST add a
record, replay and effect/hit test in `src/leafer/nsh-platform.test.ts`.
`bun run test:host` MUST be reported for desktop input, window chrome or
window level changes; `bun run package` MUST be reported for packaging changes.
CI runs the headless suite and the Linux web target; it does not run a native
host job, so host evidence is a local/manual gate. The PR MUST separate
automated evidence from host/manual evidence. (Test, Host, CI)

## 10. Documentation and design records

A change that alters behavior, commands, architecture, conventions, testing,
packaging or the sandbox MUST update the affected canonical document in the
same PR: `README.md`, `docs/architecture.md`, `docs/conventions.md`,
`docs/testing.md`, `docs/packaging.md`, `CLAUDE.md` or this standard. Each rule
MUST have one canonical home; summaries MUST link to it, and if a summary and
the canonical text disagree, the PR MUST fix the summary. Examples MUST use
real paths and commands. (Review)

An ADR MUST be added under `docs/adr/NNNN-kebab-title.md` before adding or
removing a runtime dependency, adding a network host or capability, adding a
platform module or changing the facade contract, adding a page or `NavStack`,
adding a semantic token that changes the design language, or changing release
or versioning policy. Each ADR MUST state Status, Context, Decision,
Consequences and Alternatives considered. Accepted ADRs are immutable and are
superseded by a new ADR, never edited in place. Routine fixes and
pattern-following components do not need one. (Review)

Commits SHOULD follow Conventional Commits. A user-visible change MUST add an
`Unreleased` entry to `CHANGELOG.md` using Keep a Changelog categories; create
the file with the first entry. A release is a SemVer `vX.Y.Z` tag whose version
equals `version` in `src/nsh.json`. `feat` maps to MINOR, `fix` to PATCH and a
breaking change to MAJOR, except while the app is `0.y.z`. A stable surface
(store reader/action, facade export, documented module) MUST be marked
`@deprecated` with its replacement and removal release and survive at least one
MINOR release before removal as a breaking change. (Review, CI)

The repository SHOULD add `.github/CODEOWNERS` for `src/leafer/platform/`,
`src/pages/`, `src/components/`, `src/store.ts`, `src/theme.json`,
`src/nsh.json`, `docs/` and `.github/workflows/`, and SHOULD link this standard
from `README.md` and `CLAUDE.md`. A PR MUST implement one self-contained
behavior, ideally one layer. It SHOULD stay near 100 changed lines and SHOULD
be split above roughly 1,000, excluding `bun.lock` and generated output.
Refactors, formatting, dependency bumps and behavior changes MUST be separate
PRs, and each split MUST leave the gate green. (Review)

## 11. Review checklist and definition of done

**Definition of done.** A change is DONE only when all of the following hold:

1. `bun run check` passes with zero warnings.
2. `bun run test` passes.
3. Input, window chrome or OS changes pass `bun run test:host` on the affected
   OS, or the PR states why not; packaging changes pass `bun run package` on
   the target OS.
4. A behavior change has a regression test that fails before and passes after;
   a new adapter feature has a record, replay and effect test.
5. Affected docs, `CLAUDE.md`, this standard, the changelog and any required
   ADR are updated in the same PR.
6. No probe/scratch file, commented-out code, `console.log`, `any`,
   unreviewed suppression or warning remains.
7. New colors use tokens and their pairs were contrast-checked; new controls
   have a name, role, state, keyboard path and a non-drag alternative where
   needed.
8. The PR states automated evidence, host/manual evidence, and every
   incomplete item with its reason, owner and follow-up.

**Review checklist.** Reviewers MUST verify:

- Imports follow the layer table, have no cycles, and use the facade rather
  than `leafer/platform/*`.
- Only the facade and platform modules touch Leafer internals; `unknown` is
  narrowed; no `any`, `as` narrowing or `!`.
- Store signals are private; every write goes through an action; components
  do not import the store; no state is mirrored.
- Component bodies are one-time setup; props are read in bindings; effects
  only synchronize; every timer, frame, listener, key binding and Leafer
  object has an owner and cleanup.
- Canvas changes are in the adapter with a record/replay test; Leafer's editor
  owns selection, drag and resize; there is one render loop.
- Geometry is finite, the camera rebuilds from identity, the CTM is not
  changed between path construction and fill on a hit canvas, and hit tests
  use recorded geometry.
- Tests are at the lowest level, use `waitUntil`, stable selectors, no sleeps
  except the documented one, and destroy Leafer apps.
- Tokens, contrast, names, roles, states, focus and drag alternatives were
  checked.
- `src/nsh.json` still declares `capabilities`; no convenience host was added;
  untrusted input is validated; dependencies are exact and locked.
- Docs, changelog and ADR are updated; no scratch files or debug output.

Reviewers MUST try to falsify the change at its boundaries: non-finite, zero
and negative inputs; a singular matrix; minimum and maximum zoom; empty
selection; a 1 by 1 resize; touch followed by mouse; light and dark; reduced
motion; unmount during async work; stale bounds; and an unsupported adapter
call. Reviewers SHOULD approve when the change definitely improves code
health, not when it is perfect; optional style notes MUST be marked `Nit:` and
formatting owned by Oxfmt is not a review topic. (Review)

## 12. Enforcement matrix and exception process

| Area                                                          | Enforced by                                                                          | A finding is                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| App root and commands                                         | Scripts pass `src`; `nsh check src`; Review                                          | A command without `src`, a moved config or an edited `.nsh/`                             |
| Formatting                                                    | `bun run check` (`vp check --deny-warnings`)                                         | Any diff or warning                                                                      |
| Types and strict flags                                        | `nsh check src`, `vp` typeCheck                                                      | Type error, weakened flag, unexplained suppression                                       |
| `any`, unsafe values, assertions, promises, exhaustive unions | Oxlint in `vite.config.ts`                                                           | A lint error                                                                             |
| Names, default exports, 500-line cap                          | `unicorn/filename-case`, `import/no-default-export`, `max-lines`                     | A lint error                                                                             |
| Layer direction and cycles                                    | `boundaries/no-upward-import`, `import/no-cycle`, `lint/boundaries.test.js`          | A lint error, including bare directory and unclassified imports; a failing rule test     |
| Store privacy, derivation, props, resources                   | Review; `store.test.ts`, `App.test.tsx`                                              | A review finding; no lint rule sees these                                                |
| Tokens, contrast                                              | Review; Manual light/dark                                                            | A raw color, a new token without both schemes, a failing pair                            |
| Accessibility                                                 | Review; App tests using `label:`/`text:`; Manual host pass                           | An unnamed control, color-only state, missing keyboard path                              |
| Canvas adapter and scene                                      | `nsh-platform.test.ts`, `editor.test.ts`, `culling.test.ts`, `scene.test.ts`; Review | A new operation without a record/replay/effect test                                      |
| Input and lifecycle                                           | `editor.test.ts`, `App.test.tsx`; Host (manual/local); Review                        | A missing cleanup or a hand-written hit path                                             |
| Performance                                                   | Review; Manual profiling                                                             | A second loop, per-frame scene rebuild, `usePartRender` enabled without dirty-rect tests |
| Sandbox                                                       | NSH build/package when run; Review                                                   | A missing `capabilities` key or an unjustified host                                      |
| Dependencies                                                  | `bun install --frozen-lockfile`; Review; ADR                                         | A range, missing lockfile change, unreviewed install script                              |
| Tests                                                         | `bun run test`, `test:web` on Linux CI, `test:host`                                  | A failing or missing test                                                                |
| Release                                                       | `.github/workflows/release.yml` (check, test, tag/version); Review                   | A tag/version mismatch (CI); an unsigned installer or missing smoke test (Review)        |
| Docs, ADR, changelog                                          | Review                                                                               | A missing update                                                                         |

**Exceptions.** A rule MAY be broken only through a written exception. Prefer
a scoped override in `vite.config.ts` with a comment naming the rule, reason,
owner and tracking issue or expiry. An inline suppression
(`oxlint-disable`, `@ts-expect-error`, a cast) MUST carry the same
justification at the narrowest scope. Global disables of type-safety,
boundary, filename or sandbox rules MUST NOT be merged. An exception that
outlives its expiry MUST be removed or promoted to an ADR. An emergency fix
that bypasses review MUST be reviewed retroactively within one business day.
(Review)

**Adoption debt.** These current deviations MUST NOT be copied, and each MUST
be fixed when its file is touched:

- Hit paths apply the fill-time CTM; a caller that changes the CTM after
  building a path and before filling it gets non-Canvas semantics. Bake the CTM
  when each path command is issued when that becomes observable.
- `src/leafer/platform/values.ts` `numberArg` can return `NaN` or `Infinity`
  for a malformed recorded argument. Replay catches the resulting native error,
  but a finite-argument guard would make the skip explicit.
- `src/leafer/platform/recording-context.ts` treats any offscreen `clearRect`
  as a full reset; partial clears are not emulated. Leafer currently clears
  whole offscreen canvases, so this is not observable yet.
- The workflows still use mutable action tags and pipe NSH installers to a
  shell; the tag/version check is now in `release.yml`. Vendor or checksum the
  installer scripts when CI security is next reviewed.
- `scripts/package.mjs` builds and uploads installers but no CI job installs,
  hashes or launches them; packaging changes need a manual smoke test on the
  target OS, and Linux resource placement in cargo-packager is still unverified.
- macOS signing on CI is incomplete: `FLOW_MACOS_SIGNING_IDENTITY` names an
  identity, but a clean `macos-latest` runner has no certificate installed. A
  release that must be signed needs an import step and notarization
  credentials; until then CI produces ad-hoc-signed builds.
- The floating overlays use fixed 16-point insets and do not account for
  mobile safe areas; check notched/home-indicator devices and add an inset
  when NSH exposes one.
- The app tests target the headless/desktop surface. They are not a phone
  device matrix; use `test:host` with a phone target before claiming mobile
  layout evidence.
- The 4K dot grid records a large number of canvas operations per frame; it is
  a measured performance target, not a functional failure. Raise the spacing
  or cache the pattern when profiling shows a missed frame.
- `docs/standards.md` is adopted with this change; keep it in the same commit
  as the code it governs, and update it in the PR that changes a rule.

## 13. Recipes for common changes

**New page.** Add one `src/pages/<Name>Page.tsx` exporting one PascalCase
component; mount it in `src/App.tsx`. When a second page exists, create one
`createNavStack<Route>()` at the root and render through `<NavStack>`; pages
stay mounted, so use stable route identity and carry page data in the route.
Share mutable state only through `src/store.ts`; keep camera and editor state
in the page. Add an `App.test.tsx` flow and update `docs/architecture.md` if
ownership changes. (Test, Review)

**New component.** Add one `src/components/<Name>.tsx` with an exported
`interface <Name>Props`; take current values and intent callbacks, not setters.
Do not import the store, a page or `App.tsx`; the page binds readers and
actions. Use tokens, a stable `testID`, an accessible name and the documented
states. Test it through the page; unit-test only pure helpers. (Review, Test)

**New canvas feature.** Check whether Leafer already supports it. Put scene
data in `src/flow/data.ts`, construction in `src/flow/scene.ts`, and camera
math in `src/leafer/camera.ts`. If a platform call is needed, implement it in
exactly one `src/leafer/platform/` module behind the facade and add a failing
record, replay and effect test in `src/leafer/nsh-platform.test.ts` before the
implementation. Use Leafer's editor for interaction; never hand-draw handles
or a second loop. Update the module table in `docs/architecture.md` and the
coverage list in `docs/testing.md`. (Test, Review)

**New adapter hook.** Identify the exact Leafer call and the module that owns
that concern: `recording-context` and `replay` for draw calls, `path` and
`hit-test` for geometry, `paint` for paints, `snapshot` for offscreen
surfaces, `host` for platform hooks, `measure` for text, `frame` for the
hidden render-mark reset, and `canvas`/`op` for shared types. Implement
recording and replay or hit behavior there; export through `nsh-platform.ts`
only if app code needs it. Prove it with a record, replay and effect test.
Unsupported behavior is an explicit, tested, documented no-op, never a throw
or a silent wrong result. Keep `installNshPlatform()` idempotent,
`devicePixelRatio` 1, and each view's `addDrawRequester` cleanup paired with
its mount. (Test, Review)

**New dependency.** Add an ADR first for a runtime dependency. Use
`bun add --exact <package>`, commit the updated `bun.lock`, verify
`bun install --frozen-lockfile`, review new transitive packages, install
scripts, maintainers and licenses, and run `bun audit --audit-level=high`
before release. Remove imports, types, tests and docs when removing a package.
(CI, Review)

**New semantic token.** Add the role to both `light` and `dark` in
`src/theme.json`; use it through `token()` or a token class; validate the
actual foreground/background pair for contrast; do not add `dark:` for it. If
Leafer nodes use it, extend `recolor` and verify with an app appearance test.
(Review, Test, Manual)

## 14. Anti-patterns

- **Architecture:** a component importing the store; a foundation importing a
  page; a page importing another page's internals; a deep
  `leafer/platform/*` import from app code; a second `mount()`; a new `src/`
  directory without a boundary classification.
- **State and reactivity:** exporting a signal or setter; a page-local copy of
  store state; mirroring zoom or selection into a second signal; destructuring
  props in a component body; an effect that writes the signal it reads; a
  `setInterval` that writes state every frame; reading a signal after `await`
  and expecting tracking.
- **Types:** `any`; `as` instead of a guard; `!`; `@ts-ignore`; a union
  `default` that returns a normal fallback; `JSON.parse(text) as T`.
- **Canvas:** hand-drawn selection handles; pixel `getImageData` hit testing;
  imperatively mutating the canvas outside `draw`; a new Leafer call with no
  adapter test; rebuilding the scene per frame; a second animation loop;
  enabling `usePartRender` without dirty-rect replay; leaving a measure
  context or draw requester pointing at a dead frame.
- **UI:** raw hex, `rgb()` or a palette class in app code; `dark:` for token
  colors; a `testID` used as an accessible name; color-only selection; a
  drag-only chrome action with no keyboard or single-pointer alternative; an
  icon button with no label. Canvas direct manipulation is the documented
  pointer exception, not a precedent for chrome.
- **Process and security:** removing `capabilities` or adding a wildcard host;
  `eval` or `new Function`; an unpinned action tag or `curl | sh` in the
  release path; `console.log`, probe tests or commented-out code left in
  `src/`; a large mixed-purpose PR; a behavior change with no test, doc,
  changelog or ADR where required.

## Sources

Local, enforced truth: `package.json`, `vite.config.ts`, `src/tsconfig.json`,
the root `tsconfig.json`, `lint/boundaries.js`, `src/nsh.json`, `src/store.ts`,
`src/leafer/**`, [architecture](architecture.md), [conventions](conventions.md),
[testing](testing.md) and [packaging](packaging.md).

External references used for the rules: NSH
[project structure](https://nsh.dev/docs/project-structure),
[coding guides](https://nsh.dev/docs/coding-guides),
[reactivity](https://nsh.dev/docs/reactivity),
[canvas](https://nsh.dev/docs/canvas),
[testing and trace](https://nsh.dev/docs/testing-and-trace) and
[sandbox and capabilities](https://nsh.dev/docs/sandbox-and-capabilities);
[Leafer](https://www.leaferjs.com/); the TypeScript Handbook's
[Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html);
[WCAG 2.2](https://www.w3.org/TR/WCAG22/); Google's
[small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
and [review standard](https://google.github.io/eng-practices/review/reviewer/standard.html);
[Semantic Versioning](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/);
Bun's [lockfile](https://bun.sh/docs/install/lockfile) documentation.
