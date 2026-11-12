/**
 * The multi-card selection frame as one drag surface: its padded world
 * rectangle, its screen rectangle and its group-port hit zone. The controller
 * and the frame's port views share these functions, so hit testing and
 * rendering cannot drift apart.
 */
import type { CanvasCamera } from "./camera";
import type { BoxGeometry } from "./connection";
import { PORT_CENTER_GAP, PORT_HIT_RADIUS, PORT_SIZE } from "./connection";
import type { GroupPort } from "./group-ports";
import { groupPortAt } from "./group-ports";
import type { FlowScene } from "./scene";
import { containsPoint, type ScreenRect } from "./selection";

/** How far a card's port icon reaches outside its border. */
const PORT_EXTENT = PORT_CENTER_GAP + PORT_SIZE / 2;
/** Clearance the frame leaves beyond the outermost port icon, in screen points. */
const PORT_CLEARANCE = 8;

/**
 * The frame's padding, in screen points: enough to clear the cards' resting
 * port icons, with a gap that stays one screen size while the ports scale
 * with the camera.
 */
export function framePadding(scale: number): number {
  return PORT_EXTENT * scale + PORT_CLEARANCE;
}

/** The padded world rectangle the frame draws around `bounds`. */
export function selectionFrame(bounds: BoxGeometry, scale: number): BoxGeometry {
  const padding = framePadding(scale) / scale;
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

/** A world rectangle's screen rectangle under the camera. */
export function frameScreenRect(camera: CanvasCamera, bounds: BoxGeometry): ScreenRect {
  const topLeft = camera.toScreen(bounds.x, bounds.y);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bounds.width * camera.scale,
    height: bounds.height * camera.scale,
  };
}

/** Whether a screen point is inside the frame a marquee left around `bounds`. */
export function frameContains(
  camera: CanvasCamera,
  bounds: BoxGeometry,
  x: number,
  y: number,
): boolean {
  return containsPoint(frameScreenRect(camera, bounds), x, y, framePadding(camera.scale));
}

/** The group port under a screen point, on the frame's sides. The screen
 * gate keeps a pointer inside the frame from scanning its member ports. */
export function framePortAt(
  scene: FlowScene,
  camera: CanvasCamera,
  bounds: BoxGeometry,
  x: number,
  y: number,
): GroupPort | null {
  const world = camera.toWorld(x, y);
  const frame = selectionFrame(bounds, camera.scale);
  // Group ports sit on the frame's sides, 14 world points outside it; the
  // gate measures from where they actually are, or the outer half of each
  // hit radius would never be reachable.
  const inner = frame.x - PORT_CENTER_GAP;
  const outer = frame.x + frame.width + PORT_CENTER_GAP;
  if (Math.min(Math.abs(world.x - inner), Math.abs(world.x - outer)) > PORT_HIT_RADIUS) return null;
  return groupPortAt(scene, frame, world.x, world.y);
}
