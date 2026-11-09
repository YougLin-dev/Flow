/**
 * Pointer handling for connectors: selecting an edge, dragging a new one from
 * an output port, and moving either end of the selected edge.
 */
import type { CanvasCamera } from "./camera";
import { ConnectionGesture } from "./connection-gesture";
import type { FlowScene } from "./scene";

export interface EdgeGestureHost {
  scene(): FlowScene | null;
  camera(): CanvasCamera | null;
  selectedEdge(): string | null;
  selectEdge(id: string | null): void;
  reconnectEdge(edgeId: string, fromId: string, toId: string): void;
  connectNodes(fromId: string, toId: string): void;
  changed(): void;
}

/** One edge drag at a time, consumed by the page before the canvas sees it. */
export class EdgeGestures {
  private readonly gesture = new ConnectionGesture();
  private reconnectEdgeId: string | null = null;
  private reconnectSide: "from" | "to" = "to";

  constructor(private readonly host: EdgeGestureHost) {}

  /** Forgets a pending reconnect, such as when the selection changes. */
  reset(): void {
    this.reconnectEdgeId = null;
    this.reconnectSide = "to";
  }

  /** Consumes a press that starts an edge gesture; returns whether it did. */
  down(x: number, y: number): boolean {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!scene || !camera) return false;
    const world = camera.toWorld(x, y);
    const port = scene.portAt(world.x, world.y);
    const selected = this.host.selectedEdge();

    if (port?.side === "out") {
      // Dragging a selected edge's source port moves that end. Selecting the
      // edge is how the user says which edge to reconnect; a fresh drag from
      // an unselected output port still makes a new connection.
      const endpoints = selected === null ? null : scene.edgeEndpoints(selected);
      if (selected !== null && endpoints?.fromId === port.nodeId) {
        const fixed = scene.portWorld(endpoints.toId, "in");
        if (fixed) {
          this.reconnectEdgeId = selected;
          this.reconnectSide = "from";
          this.gesture.beginSource(scene, fixed);
          this.host.changed();
          return true;
        }
      }
      this.reset();
      this.gesture.begin(scene, port.nodeId);
      this.host.changed();
      return true;
    }

    if (port?.side === "in" && selected !== null) {
      const endpoints = scene.edgeEndpoints(selected);
      if (endpoints?.toId === port.nodeId) {
        this.reconnectEdgeId = selected;
        this.reconnectSide = "to";
        this.gesture.begin(scene, endpoints.fromId);
        this.host.changed();
        return true;
      }
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

  move(x: number, y: number): void {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (scene && camera) this.gesture.move(camera, scene, x, y);
  }

  up(x: number, y: number): void {
    const reconnect = this.reconnectEdgeId;
    const side = this.reconnectSide;
    this.reset();
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!scene || !camera) return;
    const previous = reconnect === null ? null : scene.edgeEndpoints(reconnect);

    if (reconnect && side === "from") {
      const fromId = this.gesture.endSource(camera, scene, x, y);
      if (previous && fromId && fromId !== previous.fromId) {
        this.host.reconnectEdge(reconnect, fromId, previous.toId);
      }
      return;
    }

    const target = this.gesture.end(camera, scene, x, y);
    if (!target) return;
    if (!reconnect) {
      this.host.connectNodes(target.fromId, target.toId);
      return;
    }
    // A press and release on the same endpoint is not a reconnect; writing
    // it would rewrite the target's inputs and clear the redo stack.
    if (!previous) return;
    if (target.fromId === previous.fromId && target.toId === previous.toId) return;
    this.host.reconnectEdge(reconnect, target.fromId, target.toId);
  }

  cancel(): void {
    this.reset();
    this.gesture.cancel(this.host.scene());
  }
}
