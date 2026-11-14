# ADR 0005: Stroke connectors on native canvas layers

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Flow maintainers
- **Supersedes:** the connector-rendering consequence of
  [ADR 0004](0004-native-view-canvas.md). The native-view canvas decision
  itself stands.

## Context

ADR 0004 replaced the retained Leafer scene with native views and drew each
connector by sampling its cubic into overlapping, rotated line views. That
kept the whole canvas in the view tree, but the sampled segments read as beads
and visible joints at every zoom, below the canvas' visual bar.

NSH's `<Canvas>` records a drawing and replays it natively at the transformed
device resolution (the window's scale factor, the views' scales and rotations).
It is a stroking surface, not a retained scene, and it runs no per-frame JS
loop. It supports cubic paths, round caps and joins, and `Path2D` parses SVG
path data.

## Decision

Stroke each connector's cubic once on a native `<Canvas>`:

- `components/FlowEdges.tsx` draws every connector in the viewport in one
  shared canvas, sized to the union of their control-point bounds.
- `components/FlowEdge.tsx` draws the connection preview in its own canvas
  above the cards.
- The control points and bounds stay in `flow/connection.ts`
  (`connectorControls`, `connectionBounds`); hit testing stays geometric in
  the scene model (`edgeAt`), never pixel-based.
- Cards, ports, selection, the composer and every gesture remain ordinary NSH
  views. The `<Canvas>` exception covers connector lines only.

## Consequences

- Lines are smooth and sharp at any camera scale: zooming re-rasterizes the
  recorded drawing natively, and panning moves it as a translation.
- One canvas replaces a view per sampled segment, so the view count per
  viewport drops.
- Connector colors are resolved in the drawing from theme tokens, so a theme
  switch redraws them.
- A canvas is a raster of its drawing; NSH rasterizes only the visible part of
  an oversized canvas, which keeps memory bounded.
- Hit testing and selection stay independent of how the line is drawn.

## Alternatives considered

| Option                          | Why it fits                                 | Why it does not                                                       |
| ------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| **Keep sampled line views**     | No canvas; everything stays a view          | Visible joints and beading; the reason for this record                |
| **One canvas per connector**    | Simple component boundary                   | One pixmap and texture per edge; the shared layer is cheaper          |
| **SVG data-URI image per edge** | Reuses NSH's native SVG rasterizer          | Regenerates a data URI per geometry change; less direct than `Path2D` |
| **A browser-style SVG element** | What XYFlow / React Flow renders edges with | NSH has no SVG element; Canvas plus `Path2D` is its path primitive    |
