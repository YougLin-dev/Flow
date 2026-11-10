/**
 * The connector flow: a comet of light that travels along the connectors of
 * the selected cards from their source and leaves through their target.
 * Every connector is stroked from its source to its target, so the light
 * reads as flowing into a selected target and out of a selected source.
 * The comet is drawn as short pieces of the connector's curve, each with an
 * animated alpha, so a step of the light repaints only the pieces under its
 * trail instead of the whole curve's bounds.
 */
import type { EdgeSummary } from "@flow/native";

/** One wave: the comet crosses the connector, its tail leaves through the
 * target, and the next one starts. */
export const FLOW_CYCLE_MS = 1200;

/** How far apart the wave steps, in ms: a step updates the canvas's animated
 * values, so the canvas repaints about 30 times a second instead of on every
 * display frame. */
export const FLOW_STEP_MS = 33;

/** The light's alpha at the comet's head; the trail fades from there. */
export const FLOW_HEAD_ALPHA = 0.9;

/** A selected card's connectors rest at this share of the flow color, so the
 * selection reads between waves; the comet lights them from there. */
export const FLOW_REST_ALPHA = 0.5;

/** How many pieces the connector's curve is split into: more pieces are a
 * smoother trail (the trail fades in this many steps), fewer pieces are
 * fewer strokes to record and replay. */
export const FLOW_SEGMENTS = 48;

/** The comet's trail, as a share of the connector: the light is at its
 * head's alpha there and fades to nothing this far behind it, so a step
 * repaints the trail's pieces, not the whole curve. */
export const FLOW_TRAIL = 0.24;

/** The wave's position `elapsed` ms into a cycle: 1 (nothing lit) falls
 * through 0 (the comet under way) to -1 (its tail left through the
 * target), then the next comet starts. */
export function flowWave(elapsed: number): number {
  const cycle = FLOW_CYCLE_MS;
  const phase = ((elapsed % cycle) + cycle) % cycle;
  return 1 - (2 * phase) / cycle;
}

/** One piece's alpha over the wave, as an `interpolate` range. */
export interface FlowPass {
  readonly inputRange: number[];
  readonly outputRange: number[];
}

/** The alpha timeline of piece `index` of `segments`: none until the
 * comet's head reaches the piece, the head's alpha there, then down to none
 * as the trail leaves it. The last knot drops the alpha a hair after the
 * head, so a piece ahead of the comet stays dark. */
export function flowPass(index: number, segments = FLOW_SEGMENTS, trail = FLOW_TRAIL): FlowPass {
  const centre = (index + 0.5) / segments;
  const span = 1 + trail;
  // The wave value where the head reaches the piece, and where it has moved
  // `trail` past it.
  const head = 1 - (2 * centre) / span;
  const tail = 1 - (2 * (centre + trail)) / span;
  return { inputRange: [tail, head, head + 1e-3], outputRange: [0, FLOW_HEAD_ALPHA, 0] };
}

/** Whether `edge` has a selected card at either end. */
export function edgeFlows(edge: EdgeSummary, selected: ReadonlySet<string>): boolean {
  return selected.has(edge.fromId) || selected.has(edge.toId);
}
