# Code map

The area map for the layer × area standard in
[ADR 0007](adr/0007-code-organization.md). The machine-readable source of
truth is [`lint/structure-map.js`](../lint/structure-map.js); this page is
its human-readable mirror. A new area changes both, adds a lint fixture and
updates the owner.

## Layers

| Layer      | Path                                                                | May import                                    |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------- |
| Shell      | `src/App.tsx`                                                       | pages, components, store, foundations, assets |
| Page       | `src/pages/`                                                        | pages, components, store, foundations, assets |
| Component  | `src/components/`                                                   | components, foundations, assets               |
| Store      | `src/store.ts`                                                      | store, foundations, assets                    |
| Foundation | `src/flow/`                                                         | foundations, assets                           |
| Test       | `src/test-support/`, `**/test/`, `src/flow/node-session-harness.ts` | every layer; never imported by production     |
| Asset      | `src/assets/`                                                       | nothing                                       |
| Other      | any other `src/` module                                             | nothing until classified or allow-listed      |

`boundaries/no-upward-import` enforces this table. Tests are exempt because
they may reach into any layer on purpose.

## Areas

`Facade` is the public entry for the area. `May import` lists areas; a
same-feature deep import is the sibling area in the other layer.

| Area                    | Layer      | Facade                               | May import                                                                           | Owner          |
| ----------------------- | ---------- | ------------------------------------ | ------------------------------------------------------------------------------------ | -------------- |
| `flow/shared`           | foundation | `src/flow/shared/index.ts`           | external packages; `@flow/native` types in `native-types.ts`                         | `@YougLin-dev` |
| `flow/nodes`            | foundation | `src/flow/nodes/index.ts`            | `flow/shared`                                                                        | `@YougLin-dev` |
| `flow/minimap`          | foundation | `src/flow/minimap/index.ts`          | `flow/shared`                                                                        | `@YougLin-dev` |
| `flow/canvas`           | foundation | `src/flow/canvas/index.ts`           | `flow/shared`, `flow/nodes`                                                          | `@YougLin-dev` |
| `flow/execution`        | foundation | `src/flow/execution/index.ts`        | `flow/shared`, `flow/nodes`                                                          | `@YougLin-dev` |
| `flow/composer`         | foundation | `src/flow/composer/index.ts`         | `flow/shared`, `flow/nodes`, `flow/canvas`                                           | `@YougLin-dev` |
| `flow/document`         | foundation | `src/flow/document/index.ts`         | `flow/shared`, `flow/nodes`, `flow/canvas`, `flow/execution`                         | `@YougLin-dev` |
| `components/primitives` | component  | `src/components/primitives/index.ts` | `flow/shared`                                                                        | `@YougLin-dev` |
| `components/app`        | component  | `src/components/app/index.ts`        | `components/primitives`, `flow/shared`                                               | `@YougLin-dev` |
| `components/probes`     | component  | `src/components/probes/index.ts`     | `components/primitives`, `flow/canvas`                                               | `@YougLin-dev` |
| `components/canvas`     | component  | `src/components/canvas/index.ts`     | `components/primitives`, `flow/shared`, `flow/nodes`, `flow/canvas` (same feature)   | `@YougLin-dev` |
| `components/composer`   | component  | `src/components/composer/index.ts`   | `components/primitives`, `flow/shared`, `flow/nodes`, `flow/composer` (same feature) | `@YougLin-dev` |
| `components/minimap`    | component  | `src/components/minimap/index.ts`    | `components/primitives`, `flow/shared`, `flow/canvas`, `flow/minimap` (same feature) | `@YougLin-dev` |
| `components/search`     | component  | `src/components/search/index.ts`     | `components/primitives`, `flow/shared`                                               | `@YougLin-dev` |
| `pages/flow`            | page       | `src/pages/flow/index.ts`            | any area (composition root, deep imports allowed)                                    | `@YougLin-dev` |
| `store`                 | store      | `src/store.ts`                       | `flow/shared` only if a pure helper is needed                                        | `@YougLin-dev` |
| `shell`                 | shell      | `src/App.tsx`                        | `pages/flow`, `components/app`, `store`                                              | `@YougLin-dev` |

Cross-feature component imports (for example `components/canvas` importing
`components/composer`) are not allowed; the page composes them. A pair not
in the table is a lint error once the area rules are enforced.

The repository has one maintainer today, so every area names
`@YougLin-dev`. The column is real, not a placeholder: it is the seam for
splitting ownership when a second maintainer joins. A phase without an
owner does not start; a `STRUCTURE_EXCEPTIONS` entry needs both an owner and
an expiry.

## Inside an area

- Reserved segments: `geometry/` (pure math), `model/` (retained state and
  rules), `interaction/` (gesture state machines), `test/` (test-only
  helpers). A segment folder has no `index.ts`.
- Part folders are named after what they draw or do: `world/`, `selection/`,
  `editing/`, `controls/`, `feedback/`, `context-menu/`, `scene/`, `cards/`.
  They have no `index.ts`; the area facade decides what leaves.
- A component becomes a folder when it has two independently useful parts or
  grows past about 300 code lines.

## Migration status

Phase 1a has started the source moves: `flow/shared` (the shared kernel and
the native type seam), `components/primitives` (`Icon`, `icon-shape`) and
`components/canvas` (`port-visuals`) exist, and the app harness lives in
`src/test-support/app.ts`. Phase 1b added `components/composer`
(`ComposerSheet` with `TextComposer`/`ImageComposer` as configurations).
`flow/shared/async-drain.ts` now backs `PreviewLoader`; the viewport and
minimap loaders migrate in Phase 7. Phase 1d added
`components/canvas/world/{connector-layer,ConnectorCanvas}` for the two
connector layers and `components/primitives/panel.ts` for the floating-panel
chrome. The rest of the source tree is still the legacy flat layout. The old → new map is in
[the plan's Appendix A](plans/code-organization.md#appendix-a--tsx-placement-map);
`LEGACY_FLAT` in the manifest shrinks with every move and disappears in
Phase 5. Do not add a new file at the `components/`, `flow/` or `pages/`
root: `scripts/structure.mjs` fails it.
