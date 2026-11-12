/**
 * Pointer handling for connectors: selecting an edge, dragging a new one from
 * a card's typed port or a selection frame's group port, and moving either
 * end of the selected edge.
 */
import type { EdgeSummary } from "@flow/native";
import type { CanvasCamera } from "./camera";
import { type ConnectionPair, ConnectionGesture, type FixedPort } from "./connection-gesture";
import type { GroupPort } from "./group-ports";
import { isPortKind } from "./node-kinds";
import type { FlowScene } from "./scene";
import { portCenterWorld, portOffsetAt, type PortHit } from "./scene-ports";

export interface EdgeGestureHost {
  scene(): FlowScene | null;
  camera(): CanvasCamera | null;
  selectedEdge(): string | null;
  selectEdge(id: string | null): void;
  reconnectEdge(edgeId: string, pair: ConnectionPair): void;
  connectNodes(pairs: readonly ConnectionPair[]): void;
}

/** One edge drag at a time, consumed by the page before the canvas sees it. */
export class EdgeGestures {
  private readonly gesture = new ConnectionGesture();
  private reconnectEdgeId: string | null = null;

  constructor(private readonly host: EdgeGestureHost) {}

  /** Forgets a pending reconnect, such as when the selection changes. */
  reset(): void {
    this.reconnectEdgeId = null;
  }

  /** Consumes a press that starts an edge gesture; returns whether it did.
   * The caller resolves the port hit, so one press scans the ports once. */
  down(x: number, y: number, port: PortHit | null): boolean {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!scene || !camera) return false;
    const world = camera.toWorld(x, y);
    const selected = this.host.selectedEdge();

    if (port !== null) {
      // Dragging a selected edge's endpoint moves that end. The edge being
      // reconnected tells which port stays fixed.
      const edge = selected === null ? null : scene.edge(selected);
      if (edge !== null && edge !== undefined) {
        const out =
          port.side === "out" && edge.fromId === port.nodeId && edge.fromPort === port.portId;
        const into = port.side === "in" && edge.toId === port.nodeId && edge.toPort === port.portId;
        if (out || into) {
          const fixed = fixedEdgePort(scene, edge, out ? "in" : "out");
          const anchored = out ? "to" : "from";
          if (fixed !== null && this.gesture.begin(scene, [fixed], anchored, world, selected)) {
            this.reconnectEdgeId = selected;
            return true;
          }
        }
      }
      this.reset();
      this.host.selectEdge(null);
      this.gesture.begin(scene, [fixedFromHit(port)], port.side === "out" ? "from" : "to", world);
      return true;
    }

    if (scene.nodeAt(world.x, world.y)) {
      this.host.selectEdge(null);
      return false;
    }
    const edge = scene.edgeAt(world.x, world.y);
    if (edge) {
      this.host.selectEdge(edge);
      return true;
    }
    this.host.selectEdge(null);
    return false;
  }

  /**
   * Starts a group connection from a selection frame's typed group port.
   * Every member holds a fixed end; the pointer drags the single moving end
   * to one external port. The frame side decides the direction. No selected
   * card can be the target: the frame is one surface, and an edge between
   * two of its members is never what the group gesture means.
   */
  beginGroup(group: GroupPort): boolean {
    const scene = this.host.scene();
    if (!scene) return false;
    if (group.members.length === 0) return false;
    const fixed: FixedPort[] = group.members.map((member) => ({
      nodeId: member.nodeId,
      portId: member.portId,
      portKind: group.portKind,
      offset: member.offset,
      point: member.point,
    }));
    this.reset();
    this.host.selectEdge(null);
    return this.gesture.begin(
      scene,
      fixed,
      group.side === "out" ? "from" : "to",
      group.center,
      null,
      scene.selection(),
    );
  }

  move(x: number, y: number): void {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (scene && camera) this.gesture.move(camera, scene, x, y);
  }

  up(x: number, y: number): void {
    const reconnect = this.reconnectEdgeId;
    this.reset();
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!scene || !camera) return;
    const previous = reconnect === null ? null : scene.edge(reconnect);

    const pairs = this.gesture.end(camera, scene, x, y);
    const target = pairs?.[0];
    if (!target) return;
    if (!reconnect) {
      this.host.connectNodes(pairs);
      return;
    }
    // A press and release on the same port is not a reconnect; writing it
    // would rewrite the target's inputs and clear the redo stack.
    if (
      !previous ||
      (target.fromId === previous.fromId &&
        target.fromPort === previous.fromPort &&
        target.toId === previous.toId &&
        target.toPort === previous.toPort)
    ) {
      return;
    }
    this.host.reconnectEdge(reconnect, target);
  }

  cancel(): void {
    this.reset();
    this.gesture.cancel(this.host.scene());
  }
}

function fixedFromHit(port: PortHit): FixedPort {
  return {
    nodeId: port.nodeId,
    portId: port.portId,
    portKind: port.portKind,
    offset: port.offset,
    point: port.point,
  };
}

/** The edge's other end, the one that stays put while `side` moves. */
function fixedEdgePort(scene: FlowScene, edge: EdgeSummary, side: "in" | "out"): FixedPort | null {
  if (!isPortKind(edge.portKind)) return null;
  const nodeId = side === "in" ? edge.toId : edge.fromId;
  const portId = side === "in" ? edge.toPort : edge.fromPort;
  const offset =
    portOffsetAt(scene, nodeId, side, portId) ?? (side === "in" ? edge.toOffset : edge.fromOffset);
  const point = portCenterWorld(scene, nodeId, side, portId);
  if (point === null) return null;
  return { nodeId, portId, portKind: edge.portKind, offset, point };
}
