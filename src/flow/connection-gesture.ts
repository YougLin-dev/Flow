/** The drag of one connector end; the other end stays on its port anchor. */
import type { CanvasCamera } from "./camera";
import type { Point } from "./connection";
import { canConnect } from "./node-kinds";
import type { FlowScene } from "./scene";

export interface ConnectionTarget {
  readonly fromId: string;
  readonly toId: string;
}

interface Drag {
  /** The end held at the fixed node's port. */
  readonly anchored: "from" | "to";
  readonly fixed: Point;
  readonly fixedNode: string;
}

export class ConnectionGesture {
  private drag: Drag | null = null;

  /**
   * Starts dragging one end of a connector. The other end stays at
   * `fixedNode`'s port: its output when `anchored` is "from", its input when
   * "to". The moving end follows the pointer until it enters a card that
   * accepts it, then snaps to that card's port.
   */
  begin(scene: FlowScene, fixedNode: string, anchored: "from" | "to"): void {
    const fixed = scene.portWorld(fixedNode, anchored === "from" ? "out" : "in");
    if (!fixed) return;
    this.drag = { anchored, fixed, fixedNode };
    scene.setConnectionPreview(fixed, fixed);
    scene.setConnectionTarget(null);
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
    if (drag.anchored === "from") scene.setConnectionPreview(drag.fixed, moving);
    else scene.setConnectionPreview(moving, drag.fixed);
  }

  /** Finishes the drag; returns the ids only when it landed on a valid card. */
  end(camera: CanvasCamera, scene: FlowScene, x: number, y: number): ConnectionTarget | null {
    const drag = this.drag;
    if (!drag) {
      this.cancel(scene);
      return null;
    }
    const world = camera.toWorld(x, y);
    const target = this.validTarget(scene, world);
    this.cancel(scene);
    if (target === null) return null;
    return drag.anchored === "from"
      ? { fromId: drag.fixedNode, toId: target }
      : { fromId: target, toId: drag.fixedNode };
  }

  cancel(scene: FlowScene | null): void {
    this.drag = null;
    scene?.setConnectionPreview(null, null);
    scene?.setConnectionTarget(null);
  }

  /**
   * The card under the pointer when connecting it to the fixed end is legal:
   * it is not the fixed card and the kinds accept each other's output. The
   * pointer has to be on the card; its plus buttons do not extend the card.
   */
  private validTarget(scene: FlowScene, world: Point): string | null {
    const drag = this.drag;
    if (!drag) return null;
    const node = scene.nodeAt(world.x, world.y);
    if (node === null || node === drag.fixedNode) return null;
    const fixedKind = scene.kindOf(drag.fixedNode);
    const movingKind = scene.kindOf(node);
    if (fixedKind === null || movingKind === null) return null;
    const ok =
      drag.anchored === "from"
        ? canConnect(fixedKind, movingKind)
        : canConnect(movingKind, fixedKind);
    return ok ? node : null;
  }
}
