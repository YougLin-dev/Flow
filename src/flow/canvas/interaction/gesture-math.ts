/**
 * Pure math for `CanvasController`'s gesture modes: the click thresholds, the
 * overrides one drag step produces and the cards a marquee covers. The
 * controller keeps the gesture state; these helpers decide its values.
 */
import type { BoxGeometry } from "../../shared";
import type { CanvasCamera } from "../model/camera";
import { intersects, type ScreenRect } from "../geometry/selection";
import type { SceneReader } from "../model/scene/scene-types";

/** Screen points a drag or resize must travel before it is a gesture. */
export const DRAG_THRESHOLD = 2;
/** Screen points a marquee must span before it is a box, not a click. */
export const MARQUEE_MIN_SIZE = 1;

/** Whether a drag's screen distance has passed the click threshold. */
export function dragPastThreshold(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > DRAG_THRESHOLD;
}

/** Whether a resize's dominant axis has passed the click threshold. */
export function resizePastThreshold(startX: number, startY: number, x: number, y: number): boolean {
  return Math.abs(x - startX) > DRAG_THRESHOLD || Math.abs(y - startY) > DRAG_THRESHOLD;
}

/** The overrides one drag step produces from the press-time rects. */
export function draggedRects(
  base: ReadonlyMap<string, BoxGeometry>,
  dx: number,
  dy: number,
): Map<string, BoxGeometry> {
  const next = new Map<string, BoxGeometry>();
  for (const [id, rect] of base) {
    next.set(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
  }
  return next;
}

/** Whether a marquee box is a click rather than a box. */
export function marqueeIsClick(box: ScreenRect): boolean {
  return box.width < MARQUEE_MIN_SIZE && box.height < MARQUEE_MIN_SIZE;
}

/** A marquee's screen box in world coordinates. */
export function marqueeWorldRect(camera: CanvasCamera, box: ScreenRect): BoxGeometry {
  const topLeft = camera.toWorld(box.x, box.y);
  const bottomRight = camera.toWorld(box.x + box.width, box.y + box.height);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/** The ids a marquee selects: the additive base first, then scene order, once each. */
export function marqueeIds(
  scene: SceneReader,
  world: BoxGeometry,
  additive: boolean,
): readonly string[] {
  const selected = additive ? scene.selection() : [];
  const ids = [...selected];
  const included = new Set(selected);
  for (const node of scene.nodes()) {
    const rect = scene.cardRect(node.id);
    if (!rect || !intersects(rect, world) || included.has(node.id)) continue;
    ids.push(node.id);
    included.add(node.id);
  }
  return ids;
}
