/**
 * Pointer handling for connectors: selecting an edge, dragging a new one from
 * a card's plus button, and moving either end of the selected edge.
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

  constructor(private readonly host: EdgeGestureHost) {}

  /** Forgets a pending reconnect, such as when the selection changes. */
  reset(): void {
    this.reconnectEdgeId = null;
  }

  /** Consumes a press that starts an edge gesture; returns whether it did. */
  down(x: number, y: number): boolean {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (!scene || !camera) return false;
    const world = camera.toWorld(x, y);
    const zone = scene.portZoneAt(world.x, world.y);
    const selected = this.host.selectedEdge();

    if (zone !== null) {
      // Dragging a selected edge's port moves that end. Selecting the edge is
      // how the user says which edge to reconnect; a drag from any other plus
      // starts a new connection: the right side forward, the left reverse.
      if (selected !== null) {
        const endpoints = scene.edgeEndpoints(selected);
        if (zone.side === "out" && endpoints?.fromId === zone.nodeId) {
          this.reconnectEdgeId = selected;
          this.gesture.begin(scene, endpoints.toId, "to");
          this.host.changed();
          return true;
        }
        if (zone.side === "in" && endpoints?.toId === zone.nodeId) {
          this.reconnectEdgeId = selected;
          this.gesture.begin(scene, endpoints.fromId, "from");
          this.host.changed();
          return true;
        }
      }
      this.reset();
      this.gesture.begin(scene, zone.nodeId, zone.side === "out" ? "from" : "to");
      this.host.changed();
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
    const previous = reconnect === null ? null : scene.edgeEndpoints(reconnect);

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
