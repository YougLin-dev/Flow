# Node editor (M1)

Flow's first executable node layer: kinds declare named, typed input and
output ports, connections bind one output port to one input port, and types
carry text or image items. This document records the M1 contract; the
long-term direction is still [the Rust document core plan](plans/rust-core.md).

## Data model

Schema version 2 is a deliberate reset. `migration_2` drops every document
table, including the version 1 nodes and edges, and recreates the current
schema; there is no data migration. The TSX side seeds the text → image
example into an empty database (`flow/data.ts`). Version 3 keeps the
document and adds the connector RTree, filled from the existing edges.
Version 5 is the typed-port reset: it drops the document tables and recreates
them with required edge port fields and `port_id` on inputs and result items;
there is again no data migration because the app is unreleased.

| Table            | Role                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `nodes`          | kind, geometry, body, opaque `settings_json`, `status`, current output          |
| `result_batches` | one immutable provider or manual run per node                                   |
| `result_items`   | the text/image items of a batch, ordered by position, with output port          |
| `node_inputs`    | a node's ordered input items, with target port: edge snapshots or local uploads |
| `assets`         | metadata for content-addressed bytes under `<database dir>/assets/`             |
| `edges`          | directed output-port → input-port connections                                   |

`nodes.output_batch_id` points at the batch the node currently shows. A batch
is never edited: a rerun or manual text edit inserts a new batch and moves the
pointer. Old batches stay because downstream input snapshots may still refer to
their items.

Rust stores `kind` and `settings_json` opaquely. The TSX kind registry
(`flow/node-kinds.ts`) owns each node's ports, default size and settings
parsing, and `flow/execution.ts` owns the provider for each runnable kind.
M1 has `text`, `image` and `upload`. Text and image declare a `prompt` text
input (capacity 1), a `references` image input (capacity 4 for text, 16 for
image) and one output: `text` for the text kind, `image` for the image kind.
An upload has no inputs; its outputs are derived from its settings, one port
per media kind it currently holds (`image` in this release), so an empty
upload card has no output port.

## Ports and connections

- An edge carries `fromPort`, `toPort`, the shared `portKind` and each port's
  offset from its card's top, so the connector attaches to the exact port
  even when the far card is outside the viewport. The line ends at the port
  icon's centre, 14 points outside the card's border, not on the border
  itself; an off-screen endpoint carried by the read is moved out by the
  same gap. Ports are spread evenly over their card's side (`justify-evenly`),
  and a visible edge resolves its endpoints from the ports' current layout,
  so a resize keeps the line on the port. Hovering a port springs its icon a
  few points toward the pointer, like the old plus handle; the connector
  anchor does not move.
- A card mounts its ports only when they can be read or acted on: selected,
  hovered, a snapped target, or connected and at least 56 on-screen points
  tall. A fit-to-board overview therefore pays no port views. Hovering a port
  for 150 ms shows a compact name pill above the icon (cards connect left to
  right, so the sides stay clear; the side is configurable and flips at the
  stage edge); a group port shows its type and side.
- Only ports of the same item type connect. A prompt accepts one incoming
  edge; an image references port accepts up to its capacity. A full input, a
  type mismatch and a self-connection never highlight as a target. An upload
  node's output ports are resolved from its `settings_json` when the node is
  read, not declared for the whole kind; the scene caches the result by node
  record, so a pan or zoom parses no settings again.
- A connection snapshots **the source items whose `portId` matches the edge's
  output port** into the target's matching input port. A source with no
  output contributes no items.
- Local uploads are input rows with `origin = "local"`, target port
  `references` and an asset. Edge snapshots are `origin = "edge"` with the
  contributing `edge_id` and `item_id`, so deleting that edge can remove
  exactly its rows.
- Deleting one input row does not delete its edge. Deleting an edge removes
  the rows it contributed and leaves local uploads alone.
- Running a node rebuilds its edge inputs from the connected sources' current
  batches (`syncInputs`) and clears previous per-item exclusions. Local inputs
  keep their relative order per port; the rebuilt edge groups follow in that
  port.
- Positions are per `(node, port)`; the composer groups items by input port
  and shows the edge slots in use, such as `3 / 16`. Reorder and remove act
  within a group.
- Pressing a port starts a connection from that specific port, in either
  direction; a release on a compatible port joins them. Dragging the selected
  edge's endpoint moves that end and revalidates its type and capacity,
  excluding the edge itself. A port pair appears at most once; parallel edges
  between two cards on different ports are legal.
- A multi-card selection frame adds the union of its ports: one group port
  per distinct input type on the left and one per distinct output type on the
  right, icon only, alongside each selected card's own ports. Dragging a group
  port proposes one edge per selected
  member port to the single external target. If any proposed edge would
  overflow a port, the whole gesture is rejected and nothing is written.
- Provider runs never enter undo; document edits (connect, reconnect, delete,
  input changes, manual text, settings) do.
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

- A text node's body is edited in place by double-clicking the card, by
  `Mod+Enter` with one text card selected, or with the card's menu item
  (`Edit text`): a borderless input sits at the body's inset, size, type and
  line height, anchored at the body's screen origin and scaled by the camera,
  so its font, wrapping and box match the static text exactly at every zoom.
  There is no panel, border or confirm control. A press elsewhere or a lost
  focus writes the draft; Escape discards it. The composer only holds the
  prompt and its image inputs; a run's text lands on the card.
- Saving a manual edit creates a new manual text batch/item, sets the node's
  output and body, and marks downstream nodes stale.
- Image nodes show up to four thumbnails in the card body and their latest
  images in the composer.
- Assets are stored in Rust as `sha256`-named files next to the database and
  read over the FFI. TSX turns the bytes into one cached `blob:` URL per
  asset (NSH resolves the blob's native image bytes once) and owns its
  revocation until the page closes.
- Uploads use the NSH image picker (`"picker": true` in `nsh.json`); the
  composer appends them as local inputs.
- An Upload node writes its file as its **output**, not as an input: the
  picked images are imported as content-addressed assets and become one
  immutable result batch whose items carry `portId = "image"`. The same write
  stores the node's media settings (`{"version":1,"media":["image"]}`), its
  body (the file names, for search), the output pointer and the fitted card
  rectangle, and is undoable like a manual text edit: one undo restores the
  previous output and size together. Replacing the upload switches the output to a new
  batch and marks downstream nodes stale; a failed import records a failed
  batch and keeps the previous output. The card resizes to the image's aspect
  ratio (fitted in a 320-point box, with a 220-point minimum width that keeps
  the button usable) and keeps its centre, so the image shows whole instead
  of being cropped. A ratio too extreme for both the box and the minimum
  stops at the floor with its long side in the box; that image is contained
  rather than stretched. The image is contained in the body without the
  usual inset, inside the card's rounded border. The card's own bottom-right Upload/Replace button is a native pill
  in the canvas's world-point controls layer above the pointer surface, with
  an icon for its state (image upload, refresh, or a busy import), so it
  scales with the camera and holds its place on the card. The
  layer takes no pointer events itself and the button sets
  `pointerEvents: "auto"`, so the button takes its press while the rest of
  the canvas still receives its gestures. Its busy state belongs to the
  import and write, not to the picker: an open picker leaves the button
  reading Upload/Replace. The button shows on the selected
  upload card, which the canvas stacks above every unselected card; selecting
  an upload card opens no composer.

## Execution

`flow/execution.ts` owns the run lifecycle: one run per node, status
`running`, input sync, provider call, asset import, batch save, cancellation
and failure recording. `flow/node-session.ts` owns the document-facing
composer state (settings, inputs, upload), and `flow/inline-editor.ts` owns
the in-place body editor: its draft, the generation that keeps a late write
from closing a reopened editor, and the write itself. An external body change
under an open draft (a run, undo or another writer) closes it instead of
letting the stale draft write back.

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
overlay, the interaction surface and the selected upload card's world-point
controls layer; `components/FlowCard.tsx` renders one
card with its typed ports (`components/Port.tsx`), `components/FlowEdges.tsx`
strokes the viewport's connectors in one native canvas and
`components/FlowPreviews.tsx` the pulled connection previews.
`components/SelectionPorts.tsx` renders the multi-card frame's group ports
from `flow/group-ports.ts`. `flow/scene.ts` is the headless model,
`flow/scene-ports.ts` answers typed-port hits and capacity queries, and
`flow/canvas-controller.ts` turns pointer events into selection, drag,
resize, marquee, pan and connector gestures.
`components/GridBackground.tsx` draws the dot grid in screen space.
`components/CanvasContextMenu.tsx` is the right-click menu: on empty canvas,
Add text node, Add image node and Add upload node place the card at the
pressed point; on a card, Edit text opens a text card's body in place,
Copy node duplicates that card's content and settings beside it and Delete
node removes it; both write an open editor's drafts first, so a copy matches
what is on screen and undo restores what was deleted; on a connector, Delete
connection removes it. Opening a card's menu
selects that card, without opening its composer, and opening a connector's
menu selects that connector; a card already in a multiple selection keeps it.
`flow/node-commands.ts` performs those two commands:
a copy writes an open editor's drafts first, then inserts the card beside its
source; delete removes the card and its connectors. An upload copy carries
its output batch in the same command, so one undo removes the whole copy
rather than leaving an empty card behind. `flow/right-gesture.ts`
decides whether a right press becomes a camera pan or leaves the press to the
menu, and `flow/context-menu.ts` holds the menu's anchor, target and delay.
The canvas root listens with `onWheel`, so the mouse wheel and touchpad
scrolls over any part of it reach TSX, which zooms the camera about the
pointer.

An Upload card has no composer. Its empty body shows the upload icon, label
and format hint, and `components/UploadButton.tsx` renders its native
Upload/Replace pill, icon included, in the canvas's world-point controls
layer above the pointer surface, so the button scales with the camera and
stays where the card's bottom-right corner is. The layer is `box-none`: its own area passes
pointer events through, and the button takes its own press before the canvas
surface below sees it. Selecting the card raises it above unselected cards,
so another card passing touches through cannot cover the button.

The composer is a native panel in the same view tree as the rest of the app.
`flow/overlay.ts` places it directly under the selected card, centred on it,
so the placement follows the card as the camera or the card moves; it never
flips above or beside the card, and it may extend past the viewport. A text
node gets the chat-style sheet (`components/TextComposer.tsx`): its image
inputs from upstream cards or local uploads sit in the attach row with an
add-image button, the prompt and its 10,000-character counter take the middle,
and the model and round send button close the sheet; the generated text is
shown only on the card. The image node keeps `components/NodeComposer.tsx`,
whose input groups follow the node kind's input ports and show the edge slots
in use. Its draft lives in `flow/composer-state.ts` (the signal-backed
settings), written when the composer closes or the selection changes, and the
settings are also written before a run. All controls are ordinary NSH
controls, so they carry names, focus, keyboard operation and screen-reader
semantics without an alternative path.

`flow/viewport-controller.ts` keeps the scene reconciled while the camera
moves.

Keyboard: `Delete`/`Backspace` delete a selected edge or cards, `Mod+Z` /
`Mod+Shift+Z` undo/redo, `Mod+Enter` edits a selected text card's body,
arrows pan, `Mod+=`/`Mod+-` zoom, `Mod+0` fits, `Mod+K` search. A secondary-button drag pans the canvas, and a right click
opens the context menu for what it pressed: a card's Copy node/Delete node
menu, a connector's Delete connection menu, or the canvas's Add text node/Add
image node/Add upload node menu. `Escape` closes the canvas menu, then search,
the inline editor, a selected edge, the composer, and finally the selection.

## M1 non-goals

Execution cascades and background runs, real APIs or keys, cycles, per-result
deletion, run history UI, multiple documents, Panel/container nodes, token
templates, garbage collection and sync/export are not part of this layer.
