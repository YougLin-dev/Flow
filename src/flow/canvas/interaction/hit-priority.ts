/**
 * The canvas pointer's hit priority, shared by press and hover so the two
 * cannot disagree: a frame's group port, then a card's typed port, then the
 * frame itself, then a resize handle, then the card under the pointer.
 */
import type { BoxGeometry, Point } from "../../shared";
import type { ResizeHandle } from "../geometry/selection";
import type { CanvasCamera } from "../model/camera";
import type { GroupPort } from "../model/scene/group-ports";
import type { FlowScene } from "../model/scene/scene";
import { portAt, type PortHit } from "../model/scene/scene-ports";
import { frameContains, framePortAt } from "./frame-surface";
import { handleAtPoint } from "./resize-handles";

/** What the pointer hit, and the inputs both callers need afterwards. */
interface HitBase {
  /** The pointer in world points. */
  readonly world: Point;
  /** The topmost card under the pointer, titles excluded. */
  readonly card: string | null;
  /** Whether the pointer is inside the marquee frame, ports included. */
  readonly insideFrame: boolean;
}

export type CanvasHit =
  | (HitBase & { readonly kind: "framePort"; readonly port: GroupPort })
  | (HitBase & { readonly kind: "port"; readonly port: PortHit })
  | (HitBase & { readonly kind: "frame" })
  | (HitBase & { readonly kind: "handle"; readonly id: string; readonly side: ResizeHandle })
  | (HitBase & { readonly kind: "card"; readonly id: string })
  | (HitBase & { readonly kind: "empty" });

export interface CanvasHitInput {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly x: number;
  readonly y: number;
  /** Whether a marquee frame spans two or more selected cards. */
  readonly framed: boolean;
  /** The framed selection's world bounds, when framed. */
  readonly frameBounds: BoxGeometry | null;
}

/** Classifies a screen point once for both the press and the hover. */
export function canvasHit(input: CanvasHitInput): CanvasHit {
  const { scene, camera, x, y, framed, frameBounds } = input;
  const world = camera.toWorld(x, y);
  const card = scene.nodeAt(world.x, world.y);
  const insideFrame = framed && frameBounds !== null && frameContains(camera, frameBounds, x, y);
  const framePort =
    framed && frameBounds !== null ? framePortAt(scene, camera, frameBounds, x, y) : null;
  const port = portAt(scene, world.x, world.y);
  // A group port is a connector handle for the whole selection, but a card's
  // own port wins when the pointer is closer to it: the group's wide reach
  // overlaps the ports just inside and outside the frame.
  if (framePort !== null && (port === null || nearer(framePort.center, x, y, port.point))) {
    return { kind: "framePort", world, card, insideFrame, port: framePort };
  }
  if (port !== null) return { kind: "port", world, card, insideFrame, port };
  if (insideFrame) return { kind: "frame", world, card, insideFrame };
  const handle = handleAtPoint(scene, camera, scene.nodes(), x, y, card);
  if (handle !== null) {
    return { kind: "handle", world, card, insideFrame, id: handle.id, side: handle.side };
  }
  return card === null
    ? { kind: "empty", world, card, insideFrame }
    : { kind: "card", world, card, insideFrame, id: card };
}

/** Whether `center` is at least as close to the pointer as `other`. */
function nearer(center: Point, x: number, y: number, other: Point): boolean {
  return Math.hypot(center.x - x, center.y - y) <= Math.hypot(other.x - x, other.y - y);
}
