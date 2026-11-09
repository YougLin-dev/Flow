# Node editor (M1)

Flow's first executable node layer: a generic node with one input port and one
output port, typed text/image items, and many-to-many directed connections.
This document records the M1 contract; the long-term direction is still
[the Rust document core plan](plans/rust-core.md).

## Data model

Schema version 2 is a deliberate reset. `migration_2` drops every document
table, including the version 1 nodes and edges, and recreates the current
schema; there is no data migration. The TSX side seeds the text → image
example into an empty database (`flow/data.ts`).

| Table            | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `nodes`          | kind, geometry, body, opaque `settings_json`, `status`, current output |
| `result_batches` | one immutable provider or manual run per node                          |
| `result_items`   | the text/image items of a batch, ordered by position                   |
| `node_inputs`    | a node's ordered input items: edge snapshots or local uploaded assets  |
| `assets`         | metadata for content-addressed bytes under `<database dir>/assets/`    |
| `edges`          | directed output → input connections                                    |

`nodes.output_batch_id` points at the batch the node currently shows. A batch
is never edited: a rerun or manual text edit inserts a new batch and moves the
pointer. Old batches stay because downstream input snapshots may still refer to
their items.

Rust stores `kind` and `settings_json` opaquely. The TSX kind registry
(`flow/node-kinds.ts`) owns ports, default size and settings parsing, and
`flow/execution.ts` owns the provider for each kind. M1 has `text` and
`image`; both accept text and image items, text produces text, and image
produces images.

## Inputs and connections

- Connecting an edge, or reconnecting one, snapshots **all items of the
  source's current batch** into the target's input list. A source with no
  output contributes no items.
- Local uploads are input rows with `origin = "local"` and an asset. Edge
  snapshots are `origin = "edge"` with the contributing `edge_id` and
  `item_id`, so deleting that edge can remove exactly its rows.
- Deleting one input row does not delete its edge. Deleting an edge removes
  the rows it contributed and leaves local uploads alone.
- Running a node rebuilds its edge inputs from the connected sources' current
  batches (`syncInputs`) and clears previous per-item exclusions. Local inputs
  keep their relative order; the rebuilt edge groups follow.
- Inputs are ordered globally by `position`. The composer groups consecutive
  items from the same source (or the local uploads) under a source heading.
- Selecting an edge lets a drag from either endpoint's plus button move that
  end; dragging any other plus starts a new connection (right side forward,
  left side reverse), and a valid card under the pointer snaps into place
  with its border highlighted.
- Self-connections and duplicate edges are rejected in Rust. Provider runs never enter undo;
  document edits (connect, reconnect, delete, input changes, manual text,
  settings) do.
- Undoing a settings edit restores only `settings_json` (and bumps the
  revision); a later run's body, output and status are not history and survive
  the undo. An existing output becomes stale when its settings change, until
  the node runs again.
- Any write that changes a node's searchable text — a title/body/tags edit, a
  manual text edit or a successful run — rewrites its FTS row in the same
  transaction, so search matches the current text rather than the inserted one.

## Status and staleness

A node's status is `idle`, `stale`, `running`, `done`, `failed`, `cancelled`
or `interrupted` (`input-not-ready` is reserved for a later dependency gate).
`stale` is shown as “Upstream updated”.

- Changing a source marks its existing downstream results stale; a downstream
  node with no output stays idle.
- A successful run sets `done` and switches the output. Failed and cancelled
  runs keep the previous output and record the failed/cancelled batch; the
  composer reads the newest batch for the error line while cards keep showing
  the last successful output.
- Startup marks runs left `running` by a previous process as `interrupted`.
- Any change to a node's input list increments the node revision and returns
  the node in the change set even when it has no output, so an open composer
  refreshes. An existing result becomes stale.

## Text and images

- A text node's body is editable in the composer or in an inline screen-space
  editor opened by double-clicking the card.
- Saving a manual edit creates a new manual text batch/item, sets the node's
  output and body, and marks downstream nodes stale.
- Image nodes show up to four thumbnails in the card body and their latest
  images in the composer.
- Assets are stored in Rust as `sha256`-named files next to the database and
  read over the FFI. TSX turns the bytes into `data:` URLs because NSH's image
  loader does not resolve `blob:` URLs.
- Uploads use the NSH image picker (`"picker": true` in `nsh.json`); the
  composer appends them as local inputs.

## Execution

`flow/execution.ts` owns the run lifecycle: one run per node, status
`running`, input sync, provider call, asset import, batch save, cancellation
and failure recording. `flow/node-session.ts` owns the document-facing
composer state (settings, inputs, upload, body commit).

M1 providers are deterministic mocks:

- **Mock Text** waits, then returns `[Mock Text] <prompt>` plus the ordered
  text contexts and a count of reference images.
- **Mock Image** waits, then returns 1–4 generated SVGs at the configured
  aspect ratio. Its prompt is required.

The provider interface is the seam for real integrations; adding one means a
new provider and, if it needs network access, a deliberate host entry in
`capabilities.network`.

## UI split

The canvas is a native NSH view tree. `components/FlowCanvas.tsx` holds the
world-space cards and edges, the screen-space selection frame and marquee
overlay and the interaction surface; `components/FlowCard.tsx` renders one
card, `components/FlowEdges.tsx` strokes the viewport's connectors in one
native canvas and `components/FlowPreviews.tsx` the pulled connection
previews. `components/PortPlus.tsx` is the round plus handle, used both by a
card and, through `components/SelectionPluses.tsx`, by a multi-card frame.
`flow/scene.ts` is the headless model, and `flow/canvas-controller.ts` turns
pointer events into selection, drag, resize, marquee, pan and connector
gestures.
`components/GridBackground.tsx` draws the dot grid in screen space.

The composer is a native panel (`components/NodeComposer.tsx`) in the same
view tree as the rest of the app. `flow/overlay.ts` places it under the
selected card, above it or beside it when the viewport leaves no room, and
clamps it into the stage; the page measures the panel through `onLayout`, so
the placement follows the selected card as the camera or the card moves. Its
drafts live in `flow/composer-state.ts` (the signal-backed settings and
body), written when the composer closes or the selection changes, and the
settings are also written before a run.
All controls are ordinary NSH controls, so they carry names, focus, keyboard
operation and screen-reader semantics without an alternative path.

`flow/overlay.ts` also converts a card's world rectangle to the inline text
editor's screen anchor; `flow/viewport-controller.ts` keeps the scene
reconciled while the camera moves.

Keyboard: `V`/`H` tools, `N`/`I` add a text or image node, `L` connect two
selected cards, `Delete`/`Backspace` delete a selected edge or cards,
`Mod+Z`/`Mod+Shift+Z` undo/redo, arrows pan, `Mod+K` search. `Escape` closes
search, then the inline editor, a selected edge, the composer, and finally the
selection.

## M1 non-goals

Execution cascades and background runs, real APIs or keys, cycles, per-result
deletion, run history UI, multiple documents, Panel/container nodes, token
templates, garbage collection and sync/export are not part of this layer.
