# Plan 019: Typed input and output ports

> **Status**: IMPLEMENTED on 2026-11-11 (phases 1–4 plus the docs pass and a
> port-visibility rule that keeps an idle board's view count unchanged).
> The follow-ups landed on 2026-11-12: port tooltips and a large-board
> performance measurement (below).

## Why

Every card today has one aggregated input port on its left and one aggregated
output port on its right. A connection records only `fromId`/`toId` (the
`from_port`/`to_port` columns exist but are always `"out"`/`"in"`). Every item a
source produced is snapshotted into the target's flat input list, and a
multi-selection fans out one edge per selected card from the same midpoint
anchor.

This cannot say which image is a prompt reference, which is an input photo, or
which output is a caption. A node like Generate Image needs a prompt (text),
image references (up to 16 images) and an image output. The redesign makes
each parameter a named, typed port:

- Inputs and outputs are declared by the node kind, more than one per side.
- A connection binds to a specific input port and a specific output port.
- Only matching port types connect; each type has its own icon and color.
- A multi-selection exposes the union of its input/output types as group
  ports; dragging a group port fans out to every internal port of that type.
- Capacity is enforced per input port. Any shortage rejects the whole
  connection gesture (confirmed by the user).

## Decisions confirmed

1. Group ports show the type icon only, with no count or label.
2. If any target input port lacks capacity, the whole gesture is rejected;
   partial connections are not created.
3. No backward compatibility with existing documents. The app is unreleased,
   so migration 5 resets the document tables like migration 2 did; the app
   reseeds its example. Ports get semantic ids instead of legacy `in`/`out`,
   and the new edge/input columns are `NOT NULL`.

## Data model

### Port schemas (`src/flow/node-kinds.ts`)

```ts
export type PortType = "text" | "image";

export interface InputPort {
  readonly id: string; // stable id, also stored on edges and inputs
  readonly name: string; // "Prompt", "Image references"
  readonly type: PortType;
  readonly capacity: number; // max incoming edges; 1 by default
}

export interface OutputPort {
  readonly id: string;
  readonly name: string;
  readonly type: PortType;
}
```

`NodeKind` replaces `accepts`/`produces` with `inputs` and `outputs`. Array
order defines the top-to-bottom layout. Port ids are semantic and stable; no
legacy `in`/`out` aliases survive.

| Kind  | Inputs                                                               | Outputs               |
| ----- | -------------------------------------------------------------------- | --------------------- |
| Text  | `prompt` Prompt (text, 1), `references` Image references (image, 4)  | `text` Text (text)    |
| Image | `prompt` Prompt (text, 1), `references` Image references (image, 16) | `image` Image (image) |

A future kind may declare several outputs and several ports of the same type;
the schema and storage support it. The first UI pass only needs the two kinds
above.

Add `portType` metadata next to the schemas: a Lucide icon and a theme token
per type (`port-text`, `port-image`). The registry is the single place the
port UI, edges and previews read.

### Edges

- `EdgeInput`/`EdgeSummary` carry required `fromPort`/`toPort` ids.
- Add `portKind` (the shared type of both ports), `fromOffset` and `toOffset`
  (the port's anchor measured from the card's top, in card points) to
  `EdgeInput`, `EdgeSummary`, the `edges` table and history snapshots. They
  are required columns; the reset migration creates them empty.
- Uniqueness is one edge per `(fromId, fromPort, toId, toPort)`. Parallel
  edges between the same two cards on different ports are legal.
- `portKind` lets the renderer color an edge whose far card is outside the
  viewport without resolving the node kind.

### Input snapshots and results

- `node_inputs` gains `portId` (the target input port). Edge-origin rows take
  the connecting edge's `toPort`; the composer's local uploads are images and
  go to `references` (the model has no `in` port).
- `result_items` gains `portId` (the output port that produced it). The mock
  providers assign every item to the node's single output port (`text` for
  text nodes, `image` for image nodes); future multi-output providers can
  split one batch across ports.
- When an edge connects, only the source items whose `portId` equals the
  edge's `fromPort` are snapshotted into the target's `toPort`. `sync_inputs`
  and history restore use the same filter.
- Input positions become per `(node, port)`. `node_detail` returns the port on
  every input item; the composer groups by it.

### Capacity

- An input port's capacity counts incoming edges, not items. `references` on
  the image kind accepts up to 16 edges; a prompt accepts one.
- Validation lives in TS (`node-session.ts`): it can see the port schemas and
  the current scene edges. It validates the complete pair list before one
  `connectEdges` transaction; the native layer keeps enforcing self-connection
  and port-pair uniqueness.
- Reconnecting an edge excludes that edge from its target's count.
- A group gesture is atomic: if any proposed edge would overflow a port, no
  edge from that gesture is written.

### Native changes

- Migration 5 (schema version 5) is a **breaking reset**, like migration 2:
  drop the document tables and recreate them from the entities with the new
  `NOT NULL` columns. The app reseeds its example after opening. Current
  development documents are intentionally discarded.
  - `edges`: `from_port`, `to_port`, `port_kind`, `from_offset`, `to_offset`
    are required; unique index on
    `(document_id, from_id, from_port, to_id, to_port)`.
  - `node_inputs`: `port_id` is required.
  - `result_items`: `port_id` is required.
- `EdgePoint::output/input` take the port offset. `scene.rs` computes edge
  points per edge (node bounds + the edge's offsets), not once per node; the
  far-endpoint query returns bounds and the same calculation applies.
- `edge_index.rs` builds each RTree box from the card border plus the edge's
  stored port offsets, not from the icon centres the UI draws; the boxes are
  conservative (they contain the true curves) and only decide which edges a
  viewport read returns.
- `connect_edge_tx`/`update_edge`/`sync_inputs` filter snapshotted items by
  port and write `port_id`; history ops carry the new fields.
- JS bindings in `src/native/src/lib.rs` and the generated `@flow/native`
  types follow.

## Interaction

### Card ports

- Inputs sit just outside the card's left border, outputs just outside the
  right border; each is a small circle with the type icon, a type-colored
  ring and the card background. There is no plus. Ports are distributed
  evenly over their side's height, like `justify-evenly`, so adding a port
  spreads the stack instead of crowding it near the title. A hovered port
  springs a few points toward the pointer, as the old plus did, while its
  connector anchor stays fixed.
- A card's ports are mounted when it is selected, hovered, a connection
  target, or connected with at least 56 on-screen points of card height.
  At a fit-to-board zoom an idle 100k board therefore mounts no port views at
  all; zooming to a readable level brings them back.
- Hovering a port for 150 ms shows a compact pill with the parameter name
  only, for example "Prompt" or "Image references"; a group port shows its
  type and side ("Image inputs"). The pill sits above the icon by default,
  because cards connect left to right and the sides belong to the
  connectors; `placement` can force `auto` (away from the card),
  `left`/`right`/`above`/`below`, and a bubble that would leave the stage
  flips to the opposite side and clamps inside the margin. The pointer
  surface owns hover, so the bubble is drawn from the controller's hovered
  port rather than a native tooltip on the port view.

### Connection gesture

- Pressing a port starts a connection from that specific port; the gesture
  works in both directions (output → input or input → output).
- The preview dashed curve uses the port type's color. The snapped target's
  card border highlights like hover; individual ports are not highlighted
  during the drag (the target card is the visible affordance).
- Release on a port connects. Release on a card body snaps to the nearest
  compatible port within a small radius; outside any candidate the gesture is
  cancelled.
- A type mismatch, a full input, a self-connection or a duplicate port pair
  never highlights the target. A rejected release leaves everything unchanged
  and briefly marks the reason (for example a short shake or an inline
  tooltip).
- Dragging an existing edge's endpoint reconnects that edge to another port;
  the other end stays fixed. Type and capacity are revalidated, excluding the
  edge being moved.

### Multi-selection group ports

- The selection frame shows one group port per distinct input type on the left
  and one per distinct output type on the right. Each is icon-only, in the
  type color. It is present only if at least one selected card has a port of
  that type. Per-card ports stay suppressed as they are today.
- A group port is the set of every selected card's ports of that type:
  - Dragging a group **input** of type T to an external output of type T
    proposes one edge from that output to every selected T input.
  - Dragging a group **output** of type T to an external input of type T
    proposes one edge from every selected T output to that input.
- Availability is computed before the gesture: every matching internal port
  must have capacity left (for inputs), and the external input must have room
  for the number of matching outputs. If not, the group port is disabled and
  cannot start a connection.
- The gesture publishes one preview line per internal port and writes all
  edges in one transaction. A capacity change before release rejects the
  whole gesture.
- Group-to-group connections are deliberately out of scope for this pass; a
  gesture has at most one group side. Add them only with a defined capacity
  rule for the cross product.

### Edges

- Lines, previews and the selected edge use `portKind`'s color token. A
  connector rests faint at a third of its color; the clicked edge and every
  connector touching a selected card are stroked one point thicker and fully
  lit.
  The edge ends at the specific port icons' centres, 14 points outside the
  card, so it meets the circle rather than the border; two edges between the
  same cards on different ports stay visually separate.
- Several edges may leave one output port (fan-out) or enter one input port up
  to its capacity.

### Composer

- Inputs are grouped by port with the port's icon and name. The image
  references group shows its capacity ("3 / 16"); uploads land there. The
  prompt group lists upstream text inputs.
- Reorder and remove operate within a port. `ProviderRequest.inputs` carries
  each item's port so a provider can read prompt context and image references
  separately.
- The run response assigns each produced item to an output port. The mock
  providers keep one output port, `text` or `image` by node kind.

## Visual language

- Add `port-text` and `port-image` (plus optional foreground variants) to
  `src/theme.json`, light and dark. Choose hues that fit the neutral palette
  and do not reintroduce the blue cast: for example a terracotta text port and
  a sage image port. `port-*` tokens are used by port icons, edges, previews
  and the selected edge.
- Icons: `Type` for text and `Image` for image from the existing Lucide
  package; future types add their own icons through the registry.
- The node kind icon next to the card title stays as it is today; the type
  icon belongs to each port.

## Implementation map

- `src/flow/node-kinds.ts` (+ tests): port schemas, type registry, port lookup,
  `canConnectPorts`, capacity helpers.
- `src/flow/connection.ts`: per-port anchors, offsets, circle hit zones,
  nearest-compatible-port search.
- `src/flow/scene.ts`: `portWorld(nodeId, portId)`, `portAt`, edge endpoints
  from offsets, group type unions.
- `src/flow/connection-gesture.ts`: fixed ports carry `portId`/type; the
  target is a specific port; `ConnectionPair` carries `fromPort`/`toPort`.
- `src/flow/canvas-controller.ts`: port hits take precedence over resize
  handles and edges; start/reconnect gestures pass port ids; remove the side
  zone plus logic.
- `src/flow/edge-gestures.ts`: reconnect with a target port and capacity
  validation.
- `src/flow/node-session.ts`: typed `connectNodes`, capacity validation,
  atomic batch writes.
- `src/components/PortPlus.tsx` → `Port.tsx` (or a new port component);
  `FlowCard.tsx`, `FlowCanvas.tsx`, selection frame/pluses: render typed ports
  and group unions.
- `src/components/FlowEdges.tsx`: color by `portKind`; previews use type
  colors.
- `src/components/NodeComposer.tsx`: group inputs by port, capacity labels,
  uploads to the image port.
- `src/native/src/{types,entity/edges,entity/node_inputs,entity/result_items,
  schema,mutation,scene,edge_index}.rs`: columns, migration 5, offsets,
  per-port snapshots, index points.
- `src/flow/data.ts`: seeded edge uses `prompt`/`references`/`text`/`image`
  port ids explicitly.
- `docs/architecture.md`, `docs/conventions.md`, `CHANGELOG.md`: typed port
  model and the group fan-out rule.
- Tests: `node-kinds.test.ts`, `connection.test.ts`,
  `connection-gesture.test.ts`, `canvas-controller.test.ts`,
  `scene.test.ts`, native `db.rs`/`schema.rs` tests, composer and headless
  connection tests.

## Phases

1. **Core storage** — port schemas, edge offsets/port kind, migration 5 reset,
   per-port snapshots and results, history and index. The UI still draws one
   port per side until phase 2; it uses the type's primary port ids.
2. **Single-card typed ports** — port layout, icons/colors/tooltips, hit
   testing, connection and reconnect gestures, edge colors, capacity
   validation. The two kinds get their prompt/references/output ports.
3. **Group ports** — union of types on the frame, fan-out in both directions,
   atomic capacity rejection.
4. **Composer and runs** — grouped inputs, capacity labels, per-port provider
   request and result assignment.
5. **Polish** — docs, tokens, tooltip, accessibility labels, performance
   measurement (fan-out can create many edges; re-check the viewport budget).

## Measurement

Release host (`bun run dev:release -- --fps -v`), Windows 11 (10.0.26300),
2560×1600 at 150%, 240 Hz; fixture `flow-100k-typed.db` (100,000 text nodes
in a 100×1000 grid, 99,000 typed edges, 2,000 image batches), uncommitted
typed-port working tree after 401d297. At ~72% zoom about 100 connected cards
are on screen, each mounting its three port views.

| Gesture                       | fps           | frame (mean) | paint mean / p95     | canvas       | over refresh |
| ----------------------------- | ------------- | ------------ | -------------------- | ------------ | ------------ |
| Right-drag pan, ports mounted | 218–234 / 240 | 1.2–1.8 ms   | 4.0 / 4.5–4.9 ms     | 0.07–0.08 ms | 8–22%        |
| Left-drag one card            | 213–234 / 240 | 1.7 ms       | 4.3–4.6 / 5.0–5.7 ms | 0.12–0.14 ms | 28–29%       |
| Idle                          | 240 / 240     | 0.15 ms      | 1.2 ms               | 0.06 ms      | 0%           |

A separate run on the seeded demo (five cards, four marquee-selected, a
continuous 125 Hz drag for 20 s) isolates the drag path: 119–128 frames a
second — every input event commits — with frame 0.45–0.56 ms, paint ~0.5 ms,
js 0.5–1 ms per commit, gap p50 8.32 / p95 8.8 / max 8.8–41 ms and `over 0%`.
The fps readout during a drag is the input cadence, not a cap: the app renders
when something moves, so a 125 Hz mouse shows ~125/240 and a 60 Hz one ~60/240.
Gap maxima of 100 ms and more in a run can occur while per-frame work stays
under a millisecond; those are waits between frames (input pauses or
compositor scheduling), not render cost, and the `over` column stays 0%.

One 240 Hz refresh is 4.17 ms: the pan's paint mean sits at the budget and
its p95 goes slightly over, while the host still presents 218–234 frames a
second. Connectors stay under 0.1 ms in their single Canvas layer. At the
fit zoom (~5%) no port views are mounted at all. A group-output drag (many
selected outputs → one external input) cannot be wider than the target
port's capacity (4 references for text, 16 for image), so that gesture's
edge count is bounded by design; a group-input drag (one external output →
many selected inputs) writes one edge per selected input and is bounded by
the selection, not by the source. The cost either way is the per-card port
views measured above.

## Acceptance criteria

- A connection stores and displays the exact output and input ports it joins.
- A type mismatch or a full input port rejects the gesture; no partial writes.
- The Image kind shows Prompt (text), Image references (up to 16), and an
  image output; each has its own icon and color, and no plus button remains.
- A mixed multi-selection shows one icon per input type on the left and one
  per output type on the right. Dragging a group port connects every matching
  internal port; a shortage rejects the whole gesture.
- The composer groups inputs by port, shows reference capacity, and uploads
  images to the references port.
- Migration 5 resets old document data by design; the app reseeds its example
  with the semantic port ids.

## Out of scope / open

- Group-to-group connections (defer until their capacity rule is defined).
- Additional port types beyond text and image.
- Multiple output batches per node; this plan keeps one batch with a `portId`
  per item.
- Exact port colors and the card-side layout offsets are design details to
  settle in phase 2 with a real screenshot.
