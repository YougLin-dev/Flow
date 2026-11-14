# Conventions

These are the rules the project follows; `bun run check` enforces the
mechanical ones. When a rule needs an exception, add it to `vite.config.ts`
with a comment saying why — never disable a rule inline without a reason.

App paths below are relative to `src/`, the NSH application root. Repository
tooling (`package.json`, `vite.config.ts`, `tsconfig.json`, `scripts/`,
`docs/`) stays at the root; application modules live under `src/`.

## File names

| File                | Convention                     | Example                             |
| ------------------- | ------------------------------ | ----------------------------------- |
| Component           | PascalCase, named after export | `TitleBar.tsx`, `FlowPage.tsx`      |
| Component test      | `<Component>.test.tsx`         | `App.test.tsx`                      |
| Module              | kebab-case                     | `canvas-controller.ts`, `camera.ts` |
| Module test         | `<module>.test.ts` beside it   | `canvas-controller.test.ts`         |
| Build/check tooling | kebab-case `.mjs` / `.js`      | `test-host.mjs`, `boundaries.js`    |
| Rust module         | snake_case `.rs`               | `db.rs`, `history.rs`               |
| Directory           | lowercase kebab-case           | `components/`, `flow/`              |
| Asset               | lowercase, `-` and `@2x`/`@3x` | `pin-active.png`, `node@2x.png`     |

File names are checked by Oxlint's `unicorn/filename-case` in `vite.config.ts`:
PascalCase for `.tsx`, kebab-case for `.ts`, `.js` and `.mjs`, with
`multipleFileExtensions: false` so a `.test` suffix does not change the case.
Directory and asset names follow the table but are reviewed rather than
linted. `src/App.tsx` is the NSH entry and the one `.tsx` that exports
nothing; every other PascalCase file exports a value of the same name.

## Placement

A module belongs to one **layer** (`pages`, `components`, `flow`) and one
**area** inside it (`flow/canvas`, `flow/document`, `components/canvas`,
`components/composer`). Each area has one `index.ts` facade. Inside an area,
`geometry/`, `model/`, `interaction/` and `test/` are reserved segments; any
other folder is a part folder named after what it draws or does. No new module
at the `components/`, `flow/` or `pages/` root; no `utils/`, `helpers/`,
`common/`, `misc/`, `data/` or `types/`. During the migration the plan's
Appendix A lists the remaining root modules; add no new one.

Decision tree:

1. A view? `components/<area>/...`.
2. Retained state, signals or domain rules? `flow/<area>/model/...`.
3. Pure coordinate math? `flow/<area>/geometry/...` or `flow/shared/geometry.ts`.
4. Pointer/keyboard state machine? `flow/<area>/interaction/...`.
5. Calls the native document, picker, runner or asset store? `flow/document/...`
   (the only runtime `@flow/native` importer); the runner reaches the document
   through page callbacks.
6. Creates/disposes page objects, binds keys or effects? `pages/flow/workspace/...`.
7. Fixture, fake or probe? `test/`, `test-support/` or `components/probes/`.
8. Generic UI used by more than one feature? `components/primitives/`.
9. Otherwise stop: name the job and put it in the owning area.

| Term        | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| Node        | The persisted document entity (`NodeSummary`, `node-kinds`).            |
| Card        | The native view of a node (`FlowCard`, `card-*`).                       |
| Edge        | The persisted directed relation (`EdgeSummary`).                        |
| Connector   | The drawn cubic and the connection gesture for an edge.                 |
| Port        | A typed input/output handle on a node.                                  |
| Composer    | The panel that edits a node's settings, inputs and run.                 |
| Sheet       | The composer's chat-style visual shell (`ComposerSheet`).               |
| Scene       | The visible subset model (`FlowScene`), not the whole document.         |
| Camera      | The world ↔ screen mapping (`CanvasCamera`).                            |
| Viewport    | The visible rectangle and its throttled read loop.                      |
| Document    | The Rust-owned data plus document-backed services (`flow/document`).    |
| Workspace   | The mounted page runtime (`pages/flow/workspace`).                      |
| Area        | A first-level feature directory with a facade.                          |
| Segment     | A reserved internal folder: `geometry`, `model`, `interaction`, `test`. |
| Part folder | Any other internal folder, named after what it draws/does.              |

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
  (`let` in a page, component, store closure or controller class), never as a
  mutable module-level binding.
- Split by responsibility, not by line count. The `max-lines` rule caps a
  module at 500 code lines (blank and comment lines excluded); treat that as a
  prompt to look for a seam, never as a target to fill or an arbitrary split.
  Good seams are already in the code: the scene model vs its views, geometry
  vs gesture routing, or drawing vs hit testing. Avoid a `utils.ts` grab bag;
  name a module after the one job it does.
- When internal modules need a stable surface, keep one facade module beside
  the directory and export from there; consumers import the facade, while the
  internal modules import each other directly. The pattern keeps the
  dependency graph acyclic; use it when a directory actually has internal
  modules, not as indirection everywhere.
- The mixed Rust crate lives in `src/native/`. Its `#[native_module]` exports
  are the only surface TSX sees: only `flow/document` imports `@flow/native`
  at runtime; every other module imports the generated types through
  `flow/shared/native-types.ts`. Do not add a second Rust-backed import path.
  Keep SQLite and search code in Rust, and keep TSX/canvas code out of the
  crate.
- SeaORM entities are one file per table under `src/native/src/entity/`, named
  after the table. Today commands live in `mutation.rs`; reads in `search.rs`,
  `viewport.rs`, `scene.rs` or `detail.rs`; asset bytes in `asset.rs`; `db.rs`
  owns the worker handle, history and startup, and `schema.rs` owns table
  creation. Raw SQLITE SQL belongs only in `schema.rs`/`search.rs` for virtual
  tables. The Phase 6 target is `db/{mod,worker,startup,undo,tests}`,
  `mutation/{mod,nodes,edges,inputs,runs,apply,support,tx}`,
  `reads/{mod,viewport,scene,detail,search,metadata}` and
  `store/{mod,schema,edge_index,document,queries,rows}`; FFI stays unchanged.
  The exact map is in [the plan](plans/code-organization.md) Appendix B.

## Imports

Order, separated by blank lines:

1. `nsh` and `nsh/*`
2. third-party packages
3. local modules (`../store`, `./data`)

Type-only imports must say `import type` (or `import { type X }`); the
TypeScript setting `verbatimModuleSyntax` and the lint rule
`typescript/consistent-type-imports` enforce it. `import/no-cycle`,
`import/no-duplicates` and `import/no-self-import` are errors.

Dependencies flow down: `App.tsx → pages → components/store`, and
`pages → flow`. Lower layers never import a page or the shell; the
`boundaries/no-upward-import` rule (`lint/boundaries.js`) reports a violation.
Cross-area imports use the target's `index.ts`; the same-feature deep import
(`components/canvas` ↔ `flow/canvas`) and `pages/flow` are the documented
exceptions. The area matrix is in [code-map](code-map.md).

## Types

The compiler runs with `strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch`
(see `src/tsconfig.json`), on top of the lint rules below.

- **No `any`.** `typescript/no-explicit-any` is an error, and so are the
  `no-unsafe-*` rules: a value that is `any` cannot be assigned, called,
  dereferenced, returned or passed as an argument. Values from NSH,
  `JSON.parse` or another untyped source are handled at the boundary with
  `unknown` and type guards (`isRecord`, `instanceof`, `in` checks).
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
- Canvas views also use token() or token classes, so the scene follows
  light/dark with the rest of the app.
- The application name is **Flow** (capital F) in user-visible text and
  `flow` in ids, package names and paths.

## Comments and docs

- Document exported functions, types and props with `/** … */`, one line
  where possible.
- Comments explain _why_ (a platform quirk, an invariant, a workaround), not
  _what_ the next line does. The camera, geometry and gesture modules rely on
  this heavily.
- Keep a file's header comment describing its role; update it when the role
  changes.
- Do not leave commented-out code. Delete it; git remembers.

## Formatting

Oxfmt (`bun run fmt`) is the source of truth: two-space indent, double quotes,
semicolons, trailing commas, 100-column width. Do not hand-format around it;
run `bun run check:fix` before committing.

## Checks

| Command                   | Checks                                                |
| ------------------------- | ----------------------------------------------------- |
| `bun run fmt`             | Formatting only                                       |
| `bun run lint`            | NSH check, then Oxlint (names and boundaries)         |
| `bun run typecheck`       | NSH's TypeScript settings via `nsh check src`         |
| `bun run check`           | Formatting + lint + type check + rule/structure tests |
| `bun run check:structure` | Area, facade, root and budget report (part of check)  |
| `bun run test`            | Headless tests                                        |
| `bun run test:lint`       | Boundary and structure rule tests (part of check)     |

`bun run check` must pass before a commit, warnings included
(`--deny-warnings`). It also runs `bun run test:lint`, the tests for the local
boundary and structure rules. `--fix` variants are for the working tree; CI runs the
non-fix command. File names and dependency direction are both lint rules
(`unicorn/filename-case` and the local `boundaries/no-upward-import` plugin),
so there is no separate convention script to keep in sync.
