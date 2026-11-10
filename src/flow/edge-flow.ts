/**
 * The connector flow: a wave of light that fills the connectors of the
 * selected cards from their source and leaves through their target. Every
 * connector is stroked from its source to its target, so the wave reads as
 * flowing into a selected target and out of a selected source. The wave's
 * body is nested spans that all end at its head and fade toward its tail,
 * so it travels as one light with a gradient trail rather than a glowing
 * segment of one color.
 */
import type { EdgeSummary } from "@flow/native";

/** One wave: the light fills the connector, its tail leaves through the
 * target, and the next wave starts. */
export const FLOW_CYCLE_MS = 1200;

/** The head's lit span is the connector's length and this much more, so the
 * whole curve lights up even when the sampled length is a little short. */
export const FLOW_OVERSHOOT = 8;

/** How many spans the wave's gradient is built of: more spans are a smoother
 * trail but more strokes. */
export const FLOW_LAYERS = 16;

/** The light's alpha at the wave's head; the tail fades from there. */
export const FLOW_HEAD_ALPHA = 0.9;

/** A selected card's connectors rest at this share of the flow color, so the
 * selection reads between waves; the wave lights them from there. */
export const FLOW_REST_ALPHA = 0.5;

/** One pass of the wave: a lit body `lit` long that ends at the wave's head,
 * drawn at `alpha` over the passes before it. */
export interface FlowLayer {
  readonly lit: number;
  /** The gap after this pass's dash: past any connector's length, so one
   * wave never meets a dash of another period. */
  readonly gap: number;
  /** The pass's constant dash offset, added to the wave's own: it ends
   * every pass at the same head. */
  readonly shift: number;
  readonly alpha: number;
  /** The head pass (the last and shortest), the only one that glows. */
  readonly head: boolean;
}

/** The passes of a wave whose body is `fill` long, longest first. Every pass
 * shares the head, so alphas accumulate toward it: with a linear ramp of the
 * composed alpha, the tail is the first pass's faint light and the head
 * reaches `FLOW_HEAD_ALPHA`, the trail fading evenly in between. */
export function flowLayers(fill: number): readonly FlowLayer[] {
  if (!(fill > 0)) return [];
  const gap = fill * 4 + 1_000;
  const step = fill / FLOW_LAYERS;
  const layers: FlowLayer[] = [];
  let shown = 0;
  for (let i = 0; i < FLOW_LAYERS; i++) {
    const lit = fill - i * step;
    const wanted = (FLOW_HEAD_ALPHA * (i + 1)) / FLOW_LAYERS;
    layers.push({
      lit,
      gap,
      shift: lit - fill,
      // The pass that takes the composed alpha from `shown` to `wanted`.
      alpha: (wanted - shown) / (1 - shown),
      head: i === FLOW_LAYERS - 1,
    });
    shown = wanted;
  }
  return layers;
}

/** Whether `edge` has a selected card at either end. */
export function edgeFlows(edge: EdgeSummary, selected: ReadonlySet<string>): boolean {
  return selected.has(edge.fromId) || selected.has(edge.toId);
}
