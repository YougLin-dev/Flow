# Flow

An infinite flow canvas built with [Leafer](https://www.leaferjs.com/) and
[Native Shell](https://nsh.dev/) (NSH). The canvas is a Leafer scene rendered
through NSH's native `Canvas`; the window chrome, controls and overlays are
NSH views drawn around it.

The app is sandboxed by `src/nsh.json`: it may read its own bundled assets but
no remote host. An integration that fetches or loads remote images adds that
host to `capabilities.network` deliberately.

## Requirements

- [Bun](https://bun.sh/) 1.4 or newer (`packageManager` pins the exact version)
- The `nsh` CLI 0.4.0 or newer (CI pins `v0.4.0`)

## Quick start

```sh
bun install
bun run dev        # opens the app on this machine's development host
```

The first `nsh` command writes `src/.nsh/types` (NSH's TypeScript
declarations) and `src/.nsh/tsconfig.json`. They are generated, git-ignored and
safe to delete. Build and installer output stay at `.nsh/out` in the
repository root.

## Commands

| Command             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `bun run dev`       | Runs the app on this machine (`nsh run src`).                             |
| `bun run build`     | Builds the bundle for deployment (`nsh build src`, output in `.nsh/out`). |
| `bun run test`      | Runs every app test (`*.test.ts(x)`) headless on a simulated engine.      |
| `bun run test:host` | Runs the tests on this machine's development host (real input).           |
| `bun run test:web`  | Runs the tests in a headless browser host.                                |
| `bun run test:lint` | Runs the dependency-boundary rule's tests (`bun test lint`).              |
| `bun run typecheck` | Type-checks with NSH's compiler settings (`nsh check src`).               |
| `bun run lint`      | Checks types, then lints with Oxlint; `lint:fix` applies fixes.           |
| `bun run fmt`       | Formats with Oxfmt (`vp fmt`).                                            |
| `bun run check`     | Format, lint, type-check and boundary-rule tests.                         |
| `bun run check:fix` | Same, applying every automatic fix.                                       |
| `bun run package`   | Builds the native installer for this OS (`docs/packaging.md`).            |

`bun run check` is what CI runs. `vp check` (Vite+) drives the formatter,
Oxlint (type-aware, with full type checking) and the TypeScript check, and then
`bun run test:lint` proves the boundary rule itself can fail; warnings fail the
gate (`--deny-warnings`). File names are part of lint
(`unicorn/filename-case`, configured per extension), and the one-way
dependency rule is a project Oxlint JS plugin (`lint/boundaries.js`), so a
single command enforces all of it.

The normative engineering standard is [docs/standards.md](docs/standards.md):
read it before changing architecture, the canvas adapter, state ownership or
release tooling.

## Project layout

```
package.json           scripts, dependencies, package manager
vite.config.ts         Vite+ lint/format: type-aware, no `any`
tsconfig.json          extends the app's TS settings, includes src/
src/                   the NSH app: its root, entry, config and assets
  App.tsx              entry: mount(App); the shell composes the title bar and page
  App.test.tsx         end-to-end app tests
  nsh.json             app metadata (name, id, version, icon, theme)
  theme.json           design tokens (light and dark)
  tsconfig.json        NSH's TypeScript settings
  store.ts             app state: private signals behind readers and actions
  tool.ts              the Tool union shared by the store and the controls
  pages/
    FlowPage.tsx       the canvas page: camera, editor, input, overlays
  components/
    TitleBar.tsx       custom title bar (pin, drag, native window controls)
    ZoomControls.tsx   zoom in / out / fit
    ToolSwitch.tsx     Select / Hand
    HintBar.tsx        shortcut hints
    SelectionBadge.tsx selection count
    BrandCard.tsx      branding shown where the desktop shell is absent
  flow/
    data.ts            nodes and edges of the sample flow
    scene.ts           builds the Leafer scene from the data
    grid.ts            draws the dot-grid backdrop
  leafer/
    LeaferView.tsx     NSH <Canvas> hosting a Leafer App (input, frames)
    nsh-platform.ts    public facade of Leafer's platform layer on NSH
    platform/          adapter modules, one responsibility per file
    camera.ts          infinite-canvas camera (pan, zoom, fit, culling bounds)
  lib/
    window-chrome.ts   hides the native title bar and reports its metrics
  assets/              icons and images (imported by modules)
lint/
  boundaries.js        Oxlint JS plugin: dependencies flow down
scripts/
  package.mjs          installer build
  test-host.mjs        native test host for this OS
.github/workflows/     CI and installer builds
docs/                  standards, architecture, conventions, testing, packaging, ADRs
CHANGELOG.md           Keep a Changelog history and unreleased changes
```

`src/` is the NSH application root: `nsh.json`, `theme.json`, the entry
module and its assets all live together, as NSH expects, while the repository
root keeps the toolchain (`package.json`, `vite.config.ts`, `tsconfig.json`,
`scripts/`, CI).

The structure follows NSH's [project structure](https://nsh.dev/zh-CN/docs/project-structure/)
and [coding guides](https://nsh.dev/zh-CN/docs/coding-guides/): dependencies
flow down only (`src/App.tsx → pages/ → components/ → nsh`), the store's
signals stay private behind functions, and tests sit beside the code they
test.

## Documentation

- [Architecture](docs/architecture.md) — the layers, the Leafer adapter, input
  and rendering.
- [Conventions](docs/conventions.md) — naming, imports, types, styling,
  comments and the checks that enforce them.
- [Testing](docs/testing.md) — headless vs host tests, the helpers, and what
  to test.
- [Packaging](docs/packaging.md) — installers, icons and signing per OS.
