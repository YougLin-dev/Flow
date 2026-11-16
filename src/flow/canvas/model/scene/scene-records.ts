/**
 * Record reconciliation for `FlowScene`: keeping repeated snapshot records by
 * identity, the connector pair index and a node's document rectangle. The
 * scene class keeps the maps and signals; these helpers decide the values.
 */
import type { BoxGeometry, EdgeSummary, NodeSummary } from "../../../shared";
import { sameEdge, sameNode } from "./record-equality";

/** Keeps the previous record when a read repeats it, so bindings stay asleep. */
export function keepNode(previous: NodeSummary | undefined, node: NodeSummary): NodeSummary {
  return previous !== undefined && sameNode(previous, node) ? previous : node;
}

/** Keeps the previous record when a read repeats it, so bindings stay asleep. */
export function keepEdge(previous: EdgeSummary | undefined, edge: EdgeSummary): EdgeSummary {
  return previous !== undefined && sameEdge(previous, edge) ? previous : edge;
}

/** A node record's document rectangle. */
export function rectOfNode(node: NodeSummary): BoxGeometry {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** A directional, collision-free key for a connector's pair. */
export function pairKey(fromId: string, toId: string): string {
  return `${fromId.length}:${fromId}${toId}`;
}

/** The pairs an edge map currently contains, for cache retention checks. */
export function topologyPairs(edges: Iterable<EdgeSummary>): Set<string> {
  const pairs = new Set<string>();
  for (const edge of edges) pairs.add(pairKey(edge.fromId, edge.toId));
  return pairs;
}

/** Whether two pair sets hold the same connections. */
export function samePairs(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}
