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

/** Native CSS `steps()` count, approximating the former 33 ms cadence rather
 * than running a timer interval. */
export const FLOW_STEPS = 36;

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

/** Counts distinct connectors touching the selection. */
export function flowingEdgeCount(
  edges: readonly EdgeSummary[],
  selected: ReadonlySet<string>,
): number {
  return edges.filter((edge) => edgeFlows(edge, selected)).length;
}

/** Whether the native phase should run; draw suppression must not stop it. */
export function cometRuns(flowing: number, reducedMotion: boolean): boolean {
  return flowing > 0 && !reducedMotion;
}

/** Inputs for choosing between animated comet strokes and resting highlights. */
export interface CometShownOptions {
  readonly flowing: number;
  readonly reducedMotion: boolean;
  readonly dragging: boolean;
  readonly paused: boolean;
  readonly limit: number;
}

/** Whether expensive animated strokes should be recorded in this draw. */
export function cometShown(options: CometShownOptions): boolean {
  return (
    cometRuns(options.flowing, options.reducedMotion) &&
    !(options.flowing > options.limit && (options.dragging || options.paused))
  );
}
