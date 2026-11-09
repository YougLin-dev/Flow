/**
 * The drag of one connector end; the other end stays on its port anchor.
 * A group drag holds several fixed ends at once and moves the single end
 * under the pointer, so one gesture can connect a whole selection.
 */
import type { CanvasCamera } from "./camera";
import type { Point } from "./connection";
import { canConnect } from "./node-kinds";
import type { FlowScene } from "./scene";

/** The ids of one connector a gesture completed. */
export interface ConnectionPair {
  readonly fromId: string;
  readonly toId: string;
}

interface FixedPort {
  readonly nodeId: string;
  readonly point: Point;
  readonly kind: string;
}

interface Drag {
  /** The side held at every fixed node's port. */
  readonly anchored: "from" | "to";
  readonly fixed: readonly FixedPort[];
}

export class ConnectionGesture {
  private drag: Drag | null = null;

  /**
   * Starts dragging one end of one or more connectors. Every fixed end stays
   * at its node's port: outputs when `anchored` is "from", inputs when "to".
   * The moving end starts at `start` and follows the pointer until it enters
   * a card that accepts it, then snaps to that card's port.
   */
  begin(
    scene: FlowScene,
    fixedNodes: readonly string[],
    anchored: "from" | "to",
    start: Point,
  ): boolean {
    const side = anchored === "from" ? "out" : "in";
    const seen = new Set<string>();
    const fixed: FixedPort[] = [];
    for (const nodeId of fixedNodes) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const point = scene.portWorld(nodeId, side);
      const kind = scene.kindOf(nodeId);
      if (point && kind !== null) fixed.push({ nodeId, point, kind });
    }
    if (fixed.length === 0) return false;
    this.drag = { anchored, fixed };
    this.publish(scene, anchored, start);
    scene.setConnectionTarget(null);
    return true;
  }

  move(camera: CanvasCamera, scene: FlowScene, x: number, y: number): void {
    const drag = this.drag;
    if (!drag) return;
    const world = camera.toWorld(x, y);
    const target = this.validTarget(scene, world);
    scene.setConnectionTarget(target);
    let moving = world;
    if (target !== null) {
      const side = drag.anchored === "from" ? "in" : "out";
      moving = scene.portWorld(target, side) ?? world;
    }
    this.publish(scene, drag.anchored, moving);
  }

  /** Finishes the drag; returns the pairs only when it landed on a valid card. */
  end(
    camera: CanvasCamera,
    scene: FlowScene,
    x: number,
    y: number,
  ): readonly ConnectionPair[] | null {
    const drag = this.drag;
    if (!drag) {
      this.cancel(scene);
      return null;
    }
    const world = camera.toWorld(x, y);
    const target = this.validTarget(scene, world);
    this.cancel(scene);
    if (target === null) return null;
    return drag.fixed.map((anchor) =>
      drag.anchored === "from"
        ? { fromId: anchor.nodeId, toId: target }
        : { fromId: target, toId: anchor.nodeId },
    );
  }

  cancel(scene: FlowScene | null): void {
    this.drag = null;
    scene?.setConnectionPreviews(null);
    scene?.setConnectionTarget(null);
  }

  /** One dashed line per fixed end, meeting at the moving end. */
  private publish(scene: FlowScene, anchored: "from" | "to", moving: Point): void {
    const drag = this.drag;
    if (!drag) return;
    scene.setConnectionPreviews(
      drag.fixed.map((anchor) =>
        anchored === "from"
          ? { from: anchor.point, to: moving }
          : { from: moving, to: anchor.point },
      ),
    );
  }

  /**
   * The card under the pointer when connecting it to the fixed ends is legal:
   * it is none of the fixed cards and the kinds accept each other's output.
   * The pointer has to be on the card; its plus buttons do not extend the card.
   */
  private validTarget(scene: FlowScene, world: Point): string | null {
    const drag = this.drag;
    if (!drag) return null;
    const node = scene.nodeAt(world.x, world.y);
    if (node === null || drag.fixed.some((anchor) => anchor.nodeId === node)) return null;
    const movingKind = scene.kindOf(node);
    if (movingKind === null) return null;
    const ok = drag.fixed.every((anchor) =>
      drag.anchored === "from"
        ? canConnect(anchor.kind, movingKind)
        : canConnect(movingKind, anchor.kind),
    );
    return ok ? node : null;
  }
}
