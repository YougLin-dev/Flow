# ADR 0006: Lucide for interface icons

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Flow maintainers

## Context

The chrome spells icons as text glyphs (`+`, `−`) and ships hand-exported PNGs
for the window pin. Stroke weights, baselines and colors drift, and every new
control draws its glyph by hand.

NSH has no DOM, React or SVG element. Vector content is drawn either on the
native `<Canvas>` (its `Path2D` parses SVG path data) or as an SVG asset
through `<Image>`; NSH's own examples draw icons with a small Canvas and
`Path2D`. An icon library therefore has to expose path geometry as importable
data, not only `.svg` files or framework components.

## Decision

Use the vanilla `lucide` package, pinned exactly (`1.70.0`, ISC), as the icon
source.

- Import icons by name (`import { Plus } from "lucide"`), never the whole
  `icons` record. Lucide sets `sideEffects: false`, so only the icons an
  imported module uses enter the bundle.
- `components/Icon.tsx` draws an `IconNode` on a small native `<Canvas>` at
  Lucide's 24-unit grid, stroking with a theme token. `flow/icon-shape.ts`
  turns the library's `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`
  and `polygon` nodes into one SVG path string; it is unit-tested.
- Interface icons live in screen-space chrome and panels. An icon inside the
  scaled world's cards needs a measurement first: each Canvas re-rasterizes
  when the camera zooms, and the viewport can show hundreds of cards.

## Consequences

- Measured with esbuild: importing three icons is 775 B minified against a
  16 B baseline, about 250 B per icon; twenty icons are about 5 KB. Lucide has
  no runtime dependencies, install scripts or global side effects.
- Its typings are about 2 MB, mostly preview data in JSDoc; with TypeScript 7
  the measured type-check delta was about 17 ms and they never enter the app
  bundle.
- Each icon is one tiny Canvas, rasterized once and cached. A theme switch
  redraws it from the new token; there is no font to load.
- Lucide is outline-only. A filled or duotone need takes another set or a
  fill pass; Lucide's nodes carry no fill attributes.
- Updating the set is an exact-version bump, reviewed like any dependency.
- The window pin keeps its PNG for now; moving it to the icon set is a
  separate visual change.

## Alternatives considered

| Option                     | Why it fits                                                                        | Why it does not                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Lucide (chosen)**        | 1,600+ icons, one 24-unit stroke grid, ISC, named ESM data exports, tree-shakeable | Outline only; the typings' preview JSDoc is large                           |
| **Tabler Icons**           | MIT, 5,000+ icons, outline and filled                                              | The npm package exports SVG files only; no path data for Canvas             |
| **Phosphor**               | MIT, 9,000+ icons, six weights                                                     | `@phosphor-icons/core`'s JS entry is catalog metadata; icons are SVG assets |
| **Heroicons**              | MIT, clean Tailwind-aligned set                                                    | Only 316 icons, and SVG files only                                          |
| **Material Symbols font**  | Huge set, familiar                                                                 | Font loading, no per-icon tree-shaking, weak theming at small sizes         |
| **Hand-drawn local icons** | No dependency, exact look                                                          | Every glyph is maintenance; the drift is the problem being solved           |
