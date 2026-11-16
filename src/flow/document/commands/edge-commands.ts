/**
 * The edge commands behind the canvas gestures: connect a batch of pairs,
 * delete one edge and reconnect an edge end. They read the scene for the port
 * rules and write through the document; the session facade owns the methods.
 */
import type { ChangeSet, Document, EdgeInput } from "../../shared";
import {
  capacityOf,
  hasPortEdge,
  incomingEdgeCount,
  type ConnectionPair,
  type FlowScene,
} from "../../canvas";
import { canConnectPorts, portsOfNode } from "../../nodes";

/** The document, scene and callbacks an edge command needs. */
export interface EdgeCommandHost {
  document(): Document | null;
  scene(): FlowScene | null;
  isDisposed(): boolean;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
}

/** Connects one or more pairs in one write; duplicates and bad pairs skip. */
export async function connectNodes(
  host: EdgeCommandHost,
  pairs: readonly ConnectionPair[],
): Promise<void> {
  const document = host.document();
  const scene = host.scene();
  if (!document || !scene || host.isDisposed()) return;
  const valid: ConnectionPair[] = [];
  for (const pair of pairs) {
    if (pair.fromId === pair.toId) continue;
    const fromNode = scene.node(pair.fromId);
    const toNode = scene.node(pair.toId);
    if (fromNode === null || toNode === null) continue;
    if (!canConnectPorts(portsOfNode(fromNode), pair.fromPort, portsOfNode(toNode), pair.toPort)) {
      continue;
    }
    if (hasPortEdge(scene, pair.fromId, pair.fromPort, pair.toId, pair.toPort)) continue;
    valid.push(pair);
  }
  // Capacity is checked for the whole batch: one full input rejects the
  // gesture rather than writing a partial fan-out.
  const proposed = new Map<string, number>();
  for (const pair of valid) {
    const key = `${pair.toId}\u0000${pair.toPort}`;
    const capacity = capacityOf(scene, pair.toId, pair.toPort);
    const existing = incomingEdgeCount(scene, pair.toId, pair.toPort);
    const added = proposed.get(key) ?? 0;
    if (capacity === null || existing + added + 1 > capacity) return;
    proposed.set(key, added + 1);
  }
  const edges: EdgeInput[] = valid.map((pair) => ({
    id: `edge-${crypto.randomUUID()}`,
    fromId: pair.fromId,
    toId: pair.toId,
    fromPort: pair.fromPort,
    toPort: pair.toPort,
    portKind: pair.portKind,
    fromOffset: pair.fromOffset,
    toOffset: pair.toOffset,
    kind: "flow",
  }));
  if (edges.length === 0) return;
  const only = edges.length === 1 ? edges[0] : null;
  try {
    const changes = only ? await document.connectEdge(only) : await document.connectEdges(edges);
    if (host.isDisposed()) return;
    host.applyChanges(changes);
    host.schedulePreviews();
  } catch (error) {
    console.error("Flow could not connect the nodes", error);
  }
}

/** Deletes one connector; the change set drops its input snapshot too. */
export async function deleteEdge(host: EdgeCommandHost, id: string): Promise<void> {
  const document = host.document();
  if (!document || host.isDisposed()) return;
  try {
    const changes = await document.deleteEdges([id]);
    if (!host.isDisposed()) host.applyChanges(changes);
  } catch (error) {
    console.error("Flow could not delete the connection", error);
  }
}

/** Moves one edge end to another port in one write. */
export async function reconnectEdge(
  host: EdgeCommandHost,
  edgeId: string,
  pair: ConnectionPair,
): Promise<void> {
  const document = host.document();
  const scene = host.scene();
  if (!document || !scene || pair.fromId === pair.toId || host.isDisposed()) return;
  const fromNode = scene.node(pair.fromId);
  const toNode = scene.node(pair.toId);
  if (fromNode === null || toNode === null) return;
  if (!canConnectPorts(portsOfNode(fromNode), pair.fromPort, portsOfNode(toNode), pair.toPort)) {
    return;
  }
  // The pair a reconnect would write must not already belong to another
  // edge: the writer rejects it, and the gesture should never have offered it.
  if (hasPortEdge(scene, pair.fromId, pair.fromPort, pair.toId, pair.toPort)) return;
  // The edge being moved does not occupy a slot in its new target.
  const capacity = capacityOf(scene, pair.toId, pair.toPort);
  const existing = incomingEdgeCount(scene, pair.toId, pair.toPort, edgeId);
  if (capacity === null || existing + 1 > capacity) return;
  try {
    const changes = await document.updateEdge({
      id: edgeId,
      fromId: pair.fromId,
      toId: pair.toId,
      fromPort: pair.fromPort,
      toPort: pair.toPort,
      portKind: pair.portKind,
      fromOffset: pair.fromOffset,
      toOffset: pair.toOffset,
      kind: "flow",
    });
    if (!host.isDisposed()) host.applyChanges(changes);
    host.schedulePreviews();
  } catch (error) {
    console.error("Flow could not reconnect the nodes", error);
  }
}
