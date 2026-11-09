/** The drag from an output port to a target node. */
import type { CanvasCamera } from "./camera";
import type { Point } from "./connection";
import type { FlowScene } from "./scene";

export interface ConnectionTarget {
  readonly fromId: string;
  readonly toId: string;
}

export class ConnectionGesture {
  private current: { fromId: string; from: Point; to: Point } | null = null;
  /** A source reconnect: the fixed target input the preview points at. */
  private reversedFrom: Point | null = null;

  begin(scene: FlowScene, nodeId: string): void {
    const from = scene.portWorld(nodeId, "out");
    if (!from) return;
    this.current = { fromId: nodeId, from, to: from };
    this.reversedFrom = null;
    scene.setConnectionPreview(from, from);
  }

  /** Starts moving an edge's source end: the target input stays fixed. */
  beginSource(scene: FlowScene, target: Point): void {
    this.current = null;
    this.reversedFrom = target;
    scene.setConnectionPreview(target, target);
  }

  move(camera: CanvasCamera, scene: FlowScene, x: number, y: number): void {
    const world = camera.toWorld(x, y);
    if (this.reversedFrom) {
      scene.setConnectionPreview(world, this.reversedFrom);
      return;
    }
    if (!this.current) return;
    this.current.to = world;
    scene.setConnectionPreview(this.current.from, world);
  }

  /** Finishes the drag: the target under the pointer, excluding the source. */
  end(camera: CanvasCamera, scene: FlowScene, x: number, y: number): ConnectionTarget | null {
    const current = this.current;
    if (!current) {
      this.cancel(scene);
      return null;
    }
    const world = camera.toWorld(x, y);
    const target = scene.nodeAt(world.x, world.y);
    this.cancel(scene);
    if (!target || target === current.fromId) return null;
    return { fromId: current.fromId, toId: target };
  }

  /** Finishes moving an edge's source: the node under the pointer. */
  endSource(camera: CanvasCamera, scene: FlowScene, x: number, y: number): string | null {
    if (!this.reversedFrom) {
      this.cancel(scene);
      return null;
    }
    const world = camera.toWorld(x, y);
    const target = scene.nodeAt(world.x, world.y);
    this.cancel(scene);
    return target;
  }

  cancel(scene: FlowScene | null): void {
    this.current = null;
    this.reversedFrom = null;
    scene?.setConnectionPreview(null, null);
  }
}
