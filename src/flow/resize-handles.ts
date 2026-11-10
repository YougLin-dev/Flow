/** Screen-space geometry and hit testing for a card's invisible resize handles. */
import type { NodeSummary } from "@flow/native";
import type { CanvasCamera } from "./camera";
import type { CanvasCursor } from "./canvas-controller";
import type { FlowScene } from "./scene";
import { handleAt, type ResizeHandle, type ScreenRect } from "./selection";

/** The screen rectangle of a card, or null when it is not in the scene. */
export function screenRect(scene: FlowScene, camera: CanvasCamera, id: string): ScreenRect | null {
  const rect = scene.cardRect(id);
  if (!rect) return null;
  const topLeft = camera.toScreen(rect.x, rect.y);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * camera.scale,
    height: rect.height * camera.scale,
  };
}

/**
 * The card whose resize handle is under a screen point, topmost first.
 * Handles work on every visible card, not only the selected one, so a card
 * can be resized with one press. A card under the point owns the decision:
 * another card's handle never reaches through it.
 */
export function handleAtPoint(
  scene: FlowScene,
  camera: CanvasCamera,
  nodes: readonly NodeSummary[],
  x: number,
  y: number,
): { id: string; side: ResizeHandle } | null {
  const world = camera.toWorld(x, y);
  const under = scene.nodeAt(world.x, world.y);
  if (under !== null) {
    const rect = screenRect(scene, camera, under);
    const side = rect ? handleAt(rect, x, y) : null;
    return side === null ? null : { id: under, side };
  }
  // Outside every card: a handle reaches past its card's border, so look
  // for the topmost one within reach.
  let hit: { id: string; side: ResizeHandle; z: number } | null = null;
  for (const node of nodes) {
    const rect = screenRect(scene, camera, node.id);
    if (!rect) continue;
    const side = handleAt(rect, x, y);
    const depth = scene.cardDepth(node.id);
    if (side !== null && (hit === null || depth >= hit.z)) {
      hit = { id: node.id, side, z: depth };
    }
  }
  return hit === null ? null : { id: hit.id, side: hit.side };
}

/** The resize cursor matching a handle's axis or diagonal. */
export function cursorForHandle(handle: ResizeHandle): CanvasCursor {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      throw new Error(`Unexpected resize handle "${String(handle)}".`);
  }
}
