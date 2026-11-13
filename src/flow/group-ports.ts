/**
 * The typed ports a multi-card selection frame exposes: one per distinct
 * input type on its left and one per distinct output type on its right. A
 * group port stands for every selected card's port of that type; dragging it
 * fans the connection out to all of them.
 */
import type { BoxGeometry, Point, PortSide } from "./connection";
import { PORT_CENTER_GAP, PORT_HIT_RADIUS, portOffset } from "./connection";
import { PORT_KINDS, type PortKind, portsOfNode } from "./node-kinds";
import type { FlowScene } from "./scene";
import { capacityOf, portCenterWorld, portOffsetAt } from "./scene-ports";

/** One selected port a group port stands for. */
export interface GroupPortMember {
  readonly nodeId: string;
  readonly portId: string;
  readonly offset: number;
  /** The member port's icon centre, where its connector attaches. */
  readonly point: Point;
}

export interface GroupPort {
  readonly side: PortSide;
  readonly portKind: PortKind;
  /** The icon centre, just outside the frame's side; a preview attaches here. */
  readonly center: Point;
  readonly members: readonly GroupPortMember[];
  /** Input groups start only when every member has a free slot. */
  readonly enabled: boolean;
  /** Input groups: the fewest free slots any member has left. */
  readonly remaining: number;
}

/** The group ports a selection frame exposes, centred on each side. */
export function groupPorts(scene: FlowScene, frame: BoxGeometry): GroupPort[] {
  const ids = scene.selection();
  // The scene caches this per edge list, so a frame drag's per-move rebuild
  // does not rescan every edge.
  const incoming = scene.incomingByPort();
  const groups: GroupPort[] = [];
  for (const side of ["in", "out"] as const) {
    const specs: {
      portKind: PortKind;
      members: GroupPortMember[];
      remaining: number;
    }[] = [];
    for (const portKind of PORT_KINDS) {
      const members: GroupPortMember[] = [];
      let remaining = Number.POSITIVE_INFINITY;
      for (const id of ids) {
        const node = scene.node(id);
        if (node === null) continue;
        const ports = side === "in" ? portsOfNode(node).inputs : portsOfNode(node).outputs;
        for (const port of ports) {
          if (port.kind !== portKind) continue;
          const offset = portOffsetAt(scene, id, side, port.id);
          const point = portCenterWorld(scene, id, side, port.id);
          if (offset === null || point === null) continue;
          members.push({ nodeId: id, portId: port.id, offset, point });
          if (side === "in") {
            const capacity = capacityOf(scene, id, port.id) ?? 0;
            remaining = Math.min(
              remaining,
              capacity - (incoming.get(`${id}\u0000${port.id}`) ?? 0),
            );
          }
        }
      }
      if (members.length > 0) specs.push({ portKind, members, remaining });
    }
    specs.forEach((spec, index) => {
      const y = frame.y + portOffset(index, specs.length, frame.height);
      groups.push({
        side,
        portKind: spec.portKind,
        center: {
          x: side === "in" ? frame.x - PORT_CENTER_GAP : frame.x + frame.width + PORT_CENTER_GAP,
          y,
        },
        members: spec.members,
        enabled: side === "out" || spec.remaining > 0,
        remaining: side === "in" ? Math.max(0, spec.remaining) : spec.members.length,
      });
    });
  }
  return groups;
}

/** The group port under a world point, if any; the nearest one wins when
 * two reaches overlap. */
export function groupPortAt(
  scene: FlowScene,
  frame: BoxGeometry,
  x: number,
  y: number,
): GroupPort | null {
  let best: { group: GroupPort; distance: number } | null = null;
  for (const group of groupPorts(scene, frame)) {
    const distance = Math.hypot(group.center.x - x, group.center.y - y);
    if (distance <= PORT_HIT_RADIUS && (best === null || distance < best.distance)) {
      best = { group, distance };
    }
  }
  return best?.group ?? null;
}
