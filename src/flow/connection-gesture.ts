/**
 * The drag of one connector end; the other ends stay on their port anchors.
 * A group drag holds several fixed ends at once and moves the single end
 * under the pointer, so one gesture can connect a whole selection.
 */
import type { EdgeSummary } from "@flow/native";
import type { CanvasCamera } from "./camera";
import type { Point } from "./connection";
import type { PortKind } from "./node-kinds";
import type { FlowScene } from "./scene";
import { capacityOf, nearestPort, portAt, type PortHit } from "./scene-ports";

/** How far from a port's icon a release still snaps to it. */
const PORT_SNAP = 34;

/** The ids and ports of one connector a gesture completed. */
export interface ConnectionPair {
  readonly fromId: string;
  readonly fromPort: string;
  readonly toId: string;
  readonly toPort: string;
  readonly portKind: PortKind;
  readonly fromOffset: number;
  readonly toOffset: number;
}

/** One end a group gesture keeps at its port. */
export interface FixedPort {
  readonly nodeId: string;
  readonly portId: string;
  readonly portKind: PortKind;
  readonly offset: number;
  readonly point: Point;
}

/** The scene's edges as the lookups one gesture step needs. */
interface EdgeIndex {
  /** How many edges enter each `toId\0toPort`. */
  readonly incoming: ReadonlyMap<string, number>;
  /** Every `fromId\0fromPort\0toId\0toPort` that already exists. */
  readonly pairs: ReadonlySet<string>;
}

interface Drag {
  /** The side held at every fixed port. */
  readonly anchored: "from" | "to";
  readonly fixed: readonly FixedPort[];
  readonly portKind: PortKind;
  /** The edge being reconnected; it does not occupy a target slot itself. */
  readonly exceptEdgeId: string | null;
  /** Cards whose ports are never the moving end's target. */
  readonly exclude: ReadonlySet<string>;
  /** The edge index of the last step, reused while the scene is unchanged. */
  cache: { readonly edges: readonly EdgeSummary[]; readonly index: EdgeIndex } | null;
}

export class ConnectionGesture {
  private drag: Drag | null = null;

  /**
   * Starts dragging one end of one or more connectors. Every fixed end stays
   * at its port: outputs when `anchored` is "from", inputs when "to". The
   * moving end starts at `start` and follows the pointer until it enters a
   * compatible port, then snaps to that port.
   */
  begin(
    scene: FlowScene,
    fixed: readonly FixedPort[],
    anchored: "from" | "to",
    start: Point,
    exceptEdgeId: string | null = null,
    excludeIds?: readonly string[],
  ): boolean {
    const first = fixed[0];
    if (!first) return false;
    this.drag = {
      anchored,
      fixed,
      portKind: first.portKind,
      exceptEdgeId,
      exclude: new Set(excludeIds ?? fixed.map((anchor) => anchor.nodeId)),
      cache: null,
    };
    this.publish(scene, anchored, start);
    scene.setConnectionTarget(null);
    return true;
  }

  move(camera: CanvasCamera, scene: FlowScene, x: number, y: number): void {
    const drag = this.drag;
    if (!drag) return;
    const world = camera.toWorld(x, y);
    const target = this.validTarget(scene, world);
    scene.setConnectionTarget(target?.nodeId ?? null);
    this.publish(scene, drag.anchored, target?.point ?? world);
  }

  /** Finishes the drag; returns the pairs only when it landed on a valid port. */
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
        ? {
            fromId: anchor.nodeId,
            fromPort: anchor.portId,
            toId: target.nodeId,
            toPort: target.portId,
            portKind: drag.portKind,
            fromOffset: anchor.offset,
            toOffset: target.offset,
          }
        : {
            fromId: target.nodeId,
            fromPort: target.portId,
            toId: anchor.nodeId,
            toPort: anchor.portId,
            portKind: drag.portKind,
            fromOffset: target.offset,
            toOffset: anchor.offset,
          },
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
          ? { from: anchor.point, to: moving, portKind: drag.portKind }
          : { from: moving, to: anchor.point, portKind: drag.portKind },
      ),
    );
  }

  /**
   * The port under the pointer when joining it to the fixed ends is legal:
   * the opposite side, the same item type, a card none of the fixed ends
   * belong to, a pair that is not already connected, and an input with
   * capacity left. A port within the snap reach wins when the pointer itself
   * is between ports, so an invalid nearest never hides a joinable one.
   */
  private validTarget(scene: FlowScene, world: Point): PortHit | null {
    const drag = this.drag;
    if (!drag) return null;
    const side = drag.anchored === "from" ? "in" : "out";
    const index = this.edgeIndex(scene, drag);
    const canJoin = (hit: PortHit): boolean => this.canJoin(scene, drag, hit, index);
    const direct = portAt(scene, world.x, world.y, side, drag.portKind, drag.exclude);
    if (direct !== null && canJoin(direct)) return direct;
    return nearestPort(
      scene,
      side,
      drag.portKind,
      drag.exclude,
      world.x,
      world.y,
      PORT_SNAP,
      canJoin,
    );
  }

  /** The scene's edge lookups, rebuilt only when the edge list changes. */
  private edgeIndex(scene: FlowScene, drag: Drag): EdgeIndex {
    const edges = scene.edges();
    if (drag.cache !== null && drag.cache.edges === edges) return drag.cache.index;
    const incoming = new Map<string, number>();
    const pairs = new Set<string>();
    for (const edge of edges) {
      if (edge.id === drag.exceptEdgeId) continue;
      const to = `${edge.toId}\u0000${edge.toPort}`;
      incoming.set(to, (incoming.get(to) ?? 0) + 1);
      pairs.add(`${edge.fromId}\u0000${edge.fromPort}\u0000${to}`);
    }
    const index: EdgeIndex = { incoming, pairs };
    drag.cache = { edges, index };
    return index;
  }

  private canJoin(scene: FlowScene, drag: Drag, target: PortHit, index: EdgeIndex): boolean {
    if (drag.anchored === "from") {
      // The moving end is an input: it needs one slot per fixed end, and a
      // pair that already exists is never a valid target.
      const capacity = capacityOf(scene, target.nodeId, target.portId);
      if (capacity === null) return false;
      for (const anchor of drag.fixed) {
        if (index.pairs.has(pairKey(anchor.nodeId, anchor.portId, target.nodeId, target.portId))) {
          return false;
        }
      }
      const used = index.incoming.get(`${target.nodeId}\u0000${target.portId}`) ?? 0;
      return used + drag.fixed.length <= capacity;
    }
    // The moving end is an output; every fixed input must have a free slot,
    // and the gesture as a whole is rejected when one does not.
    for (const anchor of drag.fixed) {
      const capacity = capacityOf(scene, anchor.nodeId, anchor.portId);
      if (capacity === null) return false;
      if (index.pairs.has(pairKey(target.nodeId, target.portId, anchor.nodeId, anchor.portId))) {
        return false;
      }
      const used = index.incoming.get(`${anchor.nodeId}\u0000${anchor.portId}`) ?? 0;
      if (used >= capacity) return false;
    }
    return true;
  }
}

function pairKey(fromId: string, fromPort: string, toId: string, toPort: string): string {
  return `${fromId}\u0000${fromPort}\u0000${toId}\u0000${toPort}`;
}
