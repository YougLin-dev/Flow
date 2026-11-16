/**
 * Transient-geometry reconciliation for `FlowScene`: which dragged rects still
 * differ from the document, and which changed cards have settled back onto
 * their committed rect. The scene class keeps the override map and signals;
 * these helpers only compare it with the applied geometry.
 */
import {
  sameRectWithin,
  type BoxGeometry,
  type NodeBounds,
  type NodeSummary,
} from "../../../shared";
import { rectOfNode } from "./scene-records";

/** The overrides that still differ from their committed rect, in map order. */
export function changedBounds(
  overrides: ReadonlyMap<string, BoxGeometry>,
  applied: ReadonlyMap<string, BoxGeometry>,
): NodeBounds[] {
  const changed: NodeBounds[] = [];
  for (const [id, rect] of overrides) {
    const committed = applied.get(id);
    if (!committed) continue;
    if (!sameRectWithin(committed, rect)) changed.push({ id, ...rect });
  }
  return changed;
}

/** The changed cards whose override now matches their committed geometry. */
export function settledOverrideIds(
  nodes: readonly NodeSummary[],
  overrides: ReadonlyMap<string, BoxGeometry>,
): string[] {
  const settled: string[] = [];
  for (const node of nodes) {
    const override = overrides.get(node.id);
    if (override && sameRectWithin(override, rectOfNode(node))) settled.push(node.id);
  }
  return settled;
}
