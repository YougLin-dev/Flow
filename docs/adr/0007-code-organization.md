# ADR 0007: Layer × area code organization

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Flow maintainers
- **Plan:** [Code organization and architecture standard](../plans/code-organization.md)

## Context

The app was designed as three layers: `pages/`, `components/` and `flow/`.
The layer graph is sound and the boundary rule enforces it, but the layers
were also treated as the only folders: every component sits in
`src/components/`, every foundation module in `src/flow/`, and the page has
35 direct project imports. `flow/` mixes pure geometry, retained scene state,
gesture routing, document sessions, node domain rules and seed data in one
flat namespace. Duplicated composer shells, result-batch construction and
single-flight read loops are the visible result.

The root cause is missing vocabulary below the layer. The standard said a
small directory is imported "module by module", which readers took to mean
subdirectories were forbidden. Lint only classified layers, so nothing
stopped the buckets from growing.

Six reviewers cross-checked the proposal: architecture, implementation risk,
DX/reuse, the Rust core, goal fit and a final consistency pass. Their
findings are recorded in the plan's §16; the blockers (layer-breaking moves,
cross-feature type seams, migration ordering and lint resolution) are folded
into the plan.

## Decision

Keep the existing layers and add two dimensions inside them:

- **Area** — a feature folder with one facade, for example
  `flow/canvas`, `flow/document`, `components/canvas`,
  `components/composer`. Areas exist in both layers for one feature.
- **Segment** — a reserved internal folder: `geometry/`, `model/`,
  `interaction/` and `test/`. Other folders are named after what they draw
  or do (`world/`, `selection/`, `editing/`, `controls/`, `feedback/`,
  `context-menu/`). `utils/`, `helpers/`, `common/`, `misc/`, `data/` and
  `types/` are forbidden.

The dependency matrix, facade rule and exact target tree live in the plan
(§4.4–§4.6, §5). The operating rules:

- Every area has one `index.ts`; cross-area imports use it. A view and its
  model in the same feature (`components/canvas` ↔ `flow/canvas`) may import
  each other deeply. `pages/flow` is the composition root.
- The canvas is layered `geometry → model → interaction → views → page`.
  `FlowScene` remains the single state and batch owner; the split is by
  seam, not by object.
- `lint/structure-map.js` is the machine-readable source of truth.
  `lint/boundaries.js` gains `deep-cross-feature`, `forbidden-area`,
  `segment-direction`, `test-support-in-production`, `native-outside-seam`
  and `unclassified-source`. `scripts/structure.mjs` reports roots,
  facades, forbidden folders and folder budgets. Area rules are
  report-only in Phase 0 and enforced in Phase 5.
- Migration is Phase 0–7, one area or one behavior per PR, behavior
  unchanged, with `bun run check` and `bun run test` as the gate. Phase 0
  is documentation, ownership and report-only tooling; the first code PR is
  Phase 1a, the shared kernel and first reuse extractions.
- Each area has an owner in `docs/code-map.md` and `.github/CODEOWNERS`.
  Today the repository has one maintainer; the owner column is the seam for
  splitting responsibility when a second owner joins.

## Consequences

- New files have a placement answer, and a reviewer can point to the rule
  that decided it. Root buckets cannot grow while the migration runs: the
  legacy allow-list shrinks with every move and disappears in Phase 5.
- The layer graph is unchanged, so the existing boundary rule and tests keep
  their meaning. The new rules add cohesion checks rather than a second
  architecture.
- Areas create one indirection point per feature. The same-feature deep
  import exception keeps the common view/model pair from needing a giant
  facade.
- The migration is mechanical and reviewable but long: 81 flat modules move,
  one area per PR, and the Rust core splits in parallel. There is no data or
  schema change except the optional `assets_fts` decision in Phase 6.
- `docs/code-map.md`, the manifest and the lint fixtures must change
  together; a new area without all three is a review failure.
- The standard does not adopt full Feature-Sliced Design or a monorepo.
  Both remain viable if a second page, package boundary or collaboration
  feature makes the current layer graph too coarse.

## Alternatives considered

- **Keep the flat layers, add discipline only.** Rejected: the flat
  namespace is the cause, and 81 root modules cannot be navigated by
  convention.
- **Technical buckets (`controllers/`, `services/`, `helpers/`).** Rejected:
  they scatter one feature across the tree; the FSD, Bulletproof React and
  VS Code evidence all points to feature cohesion.
- **Full FSD top level (`features/`, `entities/`, `shared/`).** Rejected for
  now: a large rename that duplicates NSH's page/component guidance for a
  one-page app.
- **A monorepo with a `canvas-engine` package.** Rejected: overkill until
  the canvas is extracted or a second consumer appears.
