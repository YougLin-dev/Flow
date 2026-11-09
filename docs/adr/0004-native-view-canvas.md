# ADR 0004: Native view canvas

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Flow maintainers
- **Supersedes:** the Leafer scene/editor premise of
  [ADR 0002](0002-rust-document-core.md) and
  [ADR 0001](0001-platform-adapter-split.md). The Rust document core decision
  in ADR 0002 stands.

## Context

The canvas was a Leafer scene replayed through NSH's recording `Canvas`. That
made the canvas fast and culling free, but every interactive part had to be
drawn twice as a workaround: cards, ports and the node composer were Leafer
objects, text editing was a native `Input` overlaid at the same screen
rectangle, and a second native inspector existed only to make the composer
keyboard- and screen-reader-accessible. The adapter that let Leafer believe it
ran in a browser grew into its own subsystem.

The product priority has changed. Flow does not need to render tens of
thousands of nodes at once or chase frame budgets; it needs a better UI. Cards
should use the same type, spacing, color and interaction states as the rest of
the app, and the composer should be an ordinary native panel that follows its
card without a parallel drawn implementation.

NSH's native views already support the geometry this needs: absolute
positioning in a zero-size container, `transform: translate(...) scale(...)`
with a transform origin, transform-aware hit testing, scaled text and inputs,
and the full hover/active/focus styling vocabulary.

## Decision

Remove Leafer and NSH's `<Canvas>` from the app. The canvas is a native view
tree:

- `src/flow/scene.ts` is a headless scene model (signals for visible nodes,
  edges, selection, overrides, previews and the connection preview) with
  world-space hit tests.
- `components/FlowCanvas.tsx` renders one world view positioned and scaled by
  `CanvasCamera`, with the dot grid and the selection overlay in screen space.
  `FlowCard` and `FlowEdge` are presentational views.
- `CanvasController` routes pointer events into select/toggle, drag, resize,
  marquee, hand pan and connector gestures. A drag commits one
  `setNodeBounds` write on release; transient geometry lives in the scene's
  overrides.
- The composer is `NodeComposer`, a native panel placed from the selected
  card's current screen rectangle and measured through layout, so it stays
  readable at every zoom.
- Connectors are sampled from the existing cubic into straight rotated line
  views; there is no path primitive.
- The viewport budget, throttled reads and selected-card pinning remain, so
  the view tree never holds the whole document.

The Rust document core, commands, undo, search and the viewport contract are
unchanged.

### Amendment (2026-11-09): connector strokes

The decision above removed `<Canvas>` with the Leafer scene, when a connector
was a polyline of straight line views. Those sampled views showed joints and
beading at every zoom, which is below the canvas' visual bar, and NSH grew a
native `<Canvas>` that records a drawing and replays it natively at the
transformed device resolution: it is a stroking surface, not a retained scene
or a second render loop.

Connectors therefore stroke their cubic once on that canvas: one shared
`FlowEdges` canvas for the viewport and one `FlowEdge` canvas for the preview.
Cards, ports, selection, the composer, hit testing and every gesture stay
ordinary NSH views; the `<Canvas>` exception is limited to drawing connector
lines.

## Consequences

- The `src/leafer/` adapter, its platform modules and their tests are deleted;
  `@leafer-ui/*` dependencies leave `package.json`. The boundary rule now
  classifies `flow/`, `lib/` and `native/` as foundations.
- The composer and its inputs are ordinary NSH views, so their names, focus,
  keyboard operation and roles come from the platform; the `Mod+Shift+I`
  inspector and the native field overlay are no longer needed. Selection
  handles remain pointer affordances, covered by the canvas direct-
  manipulation exception and the composer's keyboard path.
- All canvas interaction is app-owned geometry. The scene, camera, selection
  and controller tests become the primary coverage, with `App.test.tsx`
  driving the real pointer path.
- There is no retained scene or culling engine. Visible cards are bounded by
  the existing viewport snapshot and card budget; a minimum-size or cluster
  representation at very low zoom is still future work.
- Text inside the scaled world view scales with the camera, while the composer
  and chrome stay in screen space and readable.
- Connectors stroke the cubic directly on native-canvas layers (see the
  amendment): the world's connectors in one shared canvas, the preview in its
  own above the cards. The canvas replays a recorded drawing at the
  transformed resolution, so the line stays smooth and sharp at any zoom
  without changing the scene model.
- Rotation, skew and flip remain unsupported because a node is stored as an
  axis-aligned world rectangle.

## Alternatives considered

| Option                                    | Why it fits                                                       | Why it does not                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Keep Leafer for the canvas only**       | Keeps culling and the editor; no rewrite.                         | Keeps the double implementation, the composer overlay and the adapter.       |
| **Phased replacement**                    | Lower short-term risk.                                            | Two canvas systems and two composer paths would coexist during the rewrite.  |
| **Another canvas or scene-graph library** | Mature hit testing and culling.                                   | Adds a new platform adapter and ignores NSH's native text, styling and a11y. |
| **Native views (chosen)**                 | One view tree, shared design system, native text, focus and a11y. | Rendering cost per visible card; no culling engine; geometry is app-owned.   |
