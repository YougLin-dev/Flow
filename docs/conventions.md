# Conventions

These are the rules the project follows; `bun run check` enforces the
mechanical ones. When a rule needs an exception, add it to `vite.config.ts`
with a comment saying why — never disable a rule inline without a reason.

App paths below are relative to `src/`, the NSH application root. Repository
tooling (`package.json`, `vite.config.ts`, `tsconfig.json`, `scripts/`,
`docs/`) stays at the root; application modules live under `src/`.

## File names

| File                | Convention                     | Example                          |
| ------------------- | ------------------------------ | -------------------------------- |
| Component           | PascalCase, named after export | `TitleBar.tsx`, `FlowPage.tsx`   |
| Component test      | `<Component>.test.tsx`         | `App.test.tsx`                   |
| Module              | kebab-case                     | `nsh-platform.ts`, `camera.ts`   |
| Module test         | `<module>.test.ts` beside it   | `nsh-platform.test.ts`           |
| Build/check tooling | kebab-case `.mjs` / `.js`      | `test-host.mjs`, `boundaries.js` |
| Directory           | lowercase kebab-case           | `components/`, `leafer/`         |
| Asset               | lowercase, `-` and `@2x`/`@3x` | `pin-active.png`, `node@2x.png`  |

File names are checked by Oxlint's `unicorn/filename-case` in `vite.config.ts`:
PascalCase for `.tsx`, kebab-case for `.ts`, `.js` and `.mjs`, with
`multipleFileExtensions: false` so a `.test` suffix does not change the case.
Directory and asset names follow the table but are reviewed rather than
linted. `src/App.tsx` is the NSH entry and the one `.tsx` that exports
nothing; every other PascalCase file exports a value of the same name.

## Modules and exports

- Use named exports. Default exports are allowed only where tooling needs one:
  `vite.config.ts`, `lint/boundaries.js` (the Oxlint plugin entry) and files
  under `scripts/**` (the `import/no-default-export` overrides in
  `vite.config.ts`).
- One component per `.tsx` file; small helpers that only it uses stay in the
  same file and are not exported.
- Props are an exported `interface <Name>Props` with a doc comment per
  non-obvious field.
- Components take values and callbacks; they do not import the store. Pages
  bind store readers/actions to component props.
- Module-level constants are `const`; mutable state lives inside its owner
  (`let` in a page, component, store closure or adapter class), never as a
  mutable module-level binding.
- Split by responsibility, not by line count. The `max-lines` rule caps a
  module at 500 code lines (blank and comment lines excluded); treat that as a
  prompt to look for a seam, never as a target to fill or an arbitrary split.
  Good seams are already in the code: types and their algorithms, recording
  vs replay, geometry vs painting. Avoid a `utils.ts` grab bag; name a module
  after the one job it does.
- When internal modules need a stable surface, keep one facade module beside
  the directory and export from there; consumers import the facade, while the
  internal modules import each other directly. `leafer/nsh-platform.ts` is the
  facade for `leafer/platform/`, and the same pattern keeps the dependency
  graph acyclic.

## Imports

Order, separated by blank lines:

1. `nsh` and `nsh/*`
2. third-party packages (`@leafer-ui/*`, …)
3. local modules (`../store`, `./data`)

Type-only imports must say `import type` (or `import { type X }`); the
TypeScript setting `verbatimModuleSyntax` and the lint rule
`typescript/consistent-type-imports` enforce it. `import/no-cycle`,
`import/no-duplicates` and `import/no-self-import` are errors.

Dependencies flow down: `App.tsx → pages → components/store`, and
`pages → flow/leafer/lib`. Lower layers never import a page or the shell; the
`boundaries/no-upward-import` rule (`lint/boundaries.js`) reports a violation.

## Types

The compiler runs with `strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch`
(see `src/tsconfig.json`), on top of the lint rules below.

- **No `any`.** `typescript/no-explicit-any` is an error, and so are the
  `no-unsafe-*` rules: a value that is `any` cannot be assigned, called,
  dereferenced, returned or passed as an argument. Third-party declarations
  that use `any` are handled at the boundary with `unknown` and type guards
  (`isRecord`, `instanceof`, `in` checks), as in `leafer/platform/values.ts`
  and the other adapter modules behind `leafer/nsh-platform.ts`.
  Plain `.js`/`.mjs` tooling (scripts and the lint plugin) is not
  type-checked, so those rules are off there.
- Object shapes use `interface`; unions and aliases use `type`
  (`typescript/consistent-type-definitions`).
- `unknown` is the default for values whose type is genuinely unknown; narrow
  before use. Casts (`as`) are allowed only where a boundary is documented —
  tests mocking a canvas, or a well-known platform object — and never as a
  substitute for a guard in app code.
- No non-null assertions (`!`). Check and throw, or return early.
- Exported functions state their return type when it is not obvious from the
  body; callbacks passed to `map`/`filter`/JSX may rely on inference.
- Switch on a closed union must be exhaustive
  (`typescript/switch-exhaustiveness-check`); add a `default` that throws for
  values from outside the app.

## State

- Signals are private to `store.ts`; export readers and actions.
- A reader is a function (`currentTool()`), not the signal itself, so callers
  cannot write it.
- Read signals in bindings (JSX attributes, `computed`, `effect`) and event
  handlers. Do not read state in a timer or outside an owner.
- Controlled components take the value plus `onChange`/`onPress`; the owner
  updates the state.
- Timers, listeners and bindings registered during render are cleaned up by
  the owner (`cleanup`, `keymap.bind`); work started in the store is explicit
  and documented.

## Styling

- Colors, radii and shadows come from `theme.json` via `token()` or token
  classes (`bg-card`, `text-muted-foreground`, `border-border`). App code
  contains no raw hex, `rgb()`/`rgba()` or palette classes.
- Use the spacing and type scale (`gap-2`, `p-4`, `text-sm`), not arbitrary
  values. A pixel value is justified only for platform chrome geometry
  (the 46-point caption-button lane) or canvas coordinates, with a comment.
- Interaction states use `hover:`, `active:`, `selected:` and component state
  props; do not reimplement them with JS.
- Leafer scene colors also use `token()`, so the canvas follows light/dark
  with the rest of the app.
- The application name is **Flow** (capital F) in user-visible text and
  `flow` in ids, package names and paths.

## Comments and docs

- Document exported functions, types and props with `/** … */`, one line
  where possible.
- Comments explain _why_ (a platform quirk, an invariant, a workaround), not
  _what_ the next line does. The adapter and camera rely on this heavily.
- Keep a file's header comment describing its role; update it when the role
  changes.
- Do not leave commented-out code. Delete it; git remembers.

## Formatting

Oxfmt (`bun run fmt`) is the source of truth: two-space indent, double quotes,
semicolons, trailing commas, 100-column width. Do not hand-format around it;
run `bun run check:fix` before committing.

## Checks

| Command             | Checks                                          |
| ------------------- | ----------------------------------------------- |
| `bun run fmt`       | Formatting only                                 |
| `bun run lint`      | NSH check, then Oxlint (names and boundaries)   |
| `bun run typecheck` | NSH's TypeScript settings via `nsh check src`   |
| `bun run check`     | Formatting + lint + type check + boundary tests |
| `bun run test`      | Headless tests                                  |
| `bun run test:lint` | Dependency-boundary rule tests (part of check)  |

`bun run check` must pass before a commit, warnings included
(`--deny-warnings`). It also runs `bun run test:lint`, the tests for the local
boundary rule. `--fix` variants are for the working tree; CI runs the
non-fix command. File names and dependency direction are both lint rules
(`unicorn/filename-case` and the local `boundaries/no-upward-import` plugin),
so there is no separate convention script to keep in sync.
