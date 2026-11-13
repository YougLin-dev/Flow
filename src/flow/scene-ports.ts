/**
 * Typed-port queries over a `FlowScene`: offsets, anchors, hit testing and
 * capacity arithmetic. They are free functions because they read the scene
 * through its public surface; the scene model keeps to reconciling records.
 */
import type { EdgeSummary } from "@flow/native";
import type { PortSide, Point } from "./connection";
import { portCenter, portHit, portOffset, PORT_CENTER_GAP } from "./connection";
import { type PortKind, portsOfNode } from "./node-kinds";
import type { FlowScene } from "./scene";

/** One typed port under a pointer. `point` is the icon's centre, where its
 * connector attaches. */
export interface PortHit {
  readonly nodeId: string;
  readonly side: PortSide;
  readonly portId: string;
  readonly portKind: PortKind;
  readonly offset: number;
  readonly point: Point;
}

/** A port's vertical anchor from its card's top, centred on its side. */
export function portOffsetAt(
  scene: FlowScene,
  id: string,
  side: PortSide,
  portId: string,
): number | null {
  const node = scene.node(id);
  const rect = scene.cardRect(id);
  if (node === null || rect === null) return null;
  const ports = side === "in" ? portsOfNode(node).inputs : portsOfNode(node).outputs;
  const index = ports.findIndex((port) => port.id === portId);
  return index < 0 ? null : portOffset(index, ports.length, rect.height);
}

/** Where a specific port's connector attaches: its icon's centre. */
export function portCenterWorld(
  scene: FlowScene,
  id: string,
  side: PortSide,
  portId: string,
): Point | null {
  const rect = scene.cardRect(id);
  const offset = portOffsetAt(scene, id, side, portId);
  return rect && offset !== null ? portCenter(rect, side, offset) : null;
}

/** The topmost typed port under a world point, optionally of one side/type. */
export function portAt(
  scene: FlowScene,
  x: number,
  y: number,
  side?: PortSide,
  portKind?: PortKind,
  exclude?: ReadonlySet<string>,
): PortHit | null {
  let best: (PortHit & { depth: number; distance: number }) | null = null;
  for (const node of scene.nodes()) {
    if (exclude?.has(node.id)) continue;
    const rect = scene.cardRect(node.id);
    if (!rect) continue;
    const depth = scene.cardDepth(node.id);
    const spec = portsOfNode(node);
    for (const portSide of side === undefined ? (["in", "out"] as const) : [side]) {
      const ports = portSide === "in" ? spec.inputs : spec.outputs;
      for (let index = 0; index < ports.length; index += 1) {
        const port = ports[index];
        if (!port || (portKind !== undefined && port.kind !== portKind)) continue;
        const offset = portOffset(index, ports.length, rect.height);
        if (!portHit(rect, portSide, offset, x, y)) continue;
        // Another card covers the port's icon, even though the icon sits just
        // outside a card's body; the topmost card under it owns the press.
        const center = portCenter(rect, portSide, offset);
        const covered = scene.nodeAt(center.x, center.y);
        if (covered !== null && covered !== node.id) continue;
        // The reaches of one card's ports overlap at this size; the nearer
        // icon wins, so a press between two ports grabs the intended one.
        const distance = Math.hypot(center.x - x, center.y - y);
        if (
          best === null ||
          depth > best.depth ||
          (depth === best.depth && distance < best.distance)
        ) {
          best = {
            nodeId: node.id,
            side: portSide,
            portId: port.id,
            portKind: port.kind,
            offset,
            point: center,
            depth,
            distance,
          };
        }
      }
    }
  }
  if (best === null) return null;
  return {
    nodeId: best.nodeId,
    side: best.side,
    portId: best.portId,
    portKind: best.portKind,
    offset: best.offset,
    point: best.point,
  };
}

/**
 * The nearest port of one side and type within `radius`, for snapping a
 * release. Only the winner allocates a hit; `accept` applies the join rules
 * to each candidate, so an invalid nearest port cannot hide a joinable one.
 */
export function nearestPort(
  scene: FlowScene,
  side: PortSide,
  portKind: PortKind,
  exclude: ReadonlySet<string> | undefined,
  x: number,
  y: number,
  radius: number,
  accept?: (hit: PortHit) => boolean,
): PortHit | null {
  let best: (PortHit & { distance2: number }) | null = null;
  const limit = radius * radius;
  for (const node of scene.nodes()) {
    if (exclude?.has(node.id)) continue;
    const rect = scene.cardRect(node.id);
    if (!rect) continue;
    const ports = side === "in" ? portsOfNode(node).inputs : portsOfNode(node).outputs;
    const centerX =
      side === "in" ? rect.x - PORT_CENTER_GAP : rect.x + rect.width + PORT_CENTER_GAP;
    for (let index = 0; index < ports.length; index += 1) {
      const port = ports[index];
      if (!port || port.kind !== portKind) continue;
      const offset = portOffset(index, ports.length, rect.height);
      const centerY = rect.y + offset;
      // The same occlusion rule as portAt: a card covering the icon owns the
      // press, so a release never snaps to a hidden port.
      const covered = scene.nodeAt(centerX, centerY);
      if (covered !== null && covered !== node.id) continue;
      const dx = centerX - x;
      const dy = centerY - y;
      const distance2 = dx * dx + dy * dy;
      if (distance2 > limit || (best !== null && distance2 >= best.distance2)) continue;
      const hit: PortHit = {
        nodeId: node.id,
        side,
        portId: port.id,
        portKind: port.kind,
        offset,
        point: { x: centerX, y: centerY },
      };
      if (accept !== undefined && !accept(hit)) continue;
      best = { ...hit, distance2 };
    }
  }
  return best === null
    ? null
    : {
        nodeId: best.nodeId,
        side: best.side,
        portId: best.portId,
        portKind: best.portKind,
        offset: best.offset,
        point: best.point,
      };
}

/** The most edges an input port may receive; null for a missing port. */
export function capacityOf(scene: FlowScene, nodeId: string, portId: string): number | null {
  const node = scene.node(nodeId);
  if (node === null) return null;
  return portsOfNode(node).inputs.find((port) => port.id === portId)?.capacity ?? null;
}

/** How many edges already enter one input port. */
export function incomingEdgeCount(
  scene: FlowScene,
  nodeId: string,
  portId: string,
  exceptEdgeId?: string,
): number {
  let count = 0;
  for (const edge of scene.edges()) {
    if (edge.toId === nodeId && edge.toPort === portId && edge.id !== exceptEdgeId) count += 1;
  }
  return count;
}

/** Whether this exact port pair already has an edge. */
export function hasPortEdge(
  scene: FlowScene,
  fromId: string,
  fromPort: string,
  toId: string,
  toPort: string,
): boolean {
  for (const edge of scene.edges()) {
    if (
      edge.fromId === fromId &&
      edge.fromPort === fromPort &&
      edge.toId === toId &&
      edge.toPort === toPort
    ) {
      return true;
    }
  }
  return false;
}

/**
 * An edge's endpoint offsets: the ports' current centred layout when their
 * cards are in the scene, or the offsets stored on the edge (for a far card)
 * otherwise. A resize therefore keeps a visible connector on its port.
 */
export function edgePortOffsets(scene: FlowScene, edge: EdgeSummary): { from: number; to: number } {
  return {
    from: portOffsetAt(scene, edge.fromId, "out", edge.fromPort) ?? edge.fromOffset,
    to: portOffsetAt(scene, edge.toId, "in", edge.toPort) ?? edge.toOffset,
  };
}
