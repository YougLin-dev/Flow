/**
 * The one world-rectangle to screen-rectangle projection shared by the two
 * hit-test paths: card resize handles and the multi-card selection frame.
 * Rendering shares its own `selectionFrame` geometry with the frame's hit
 * test; this helper owns the camera projection both hit tests need.
 */
import type { BoxGeometry } from "../../shared";
import type { ScreenRect } from "../geometry/selection";
import type { CanvasCamera } from "./camera";

/** A world rectangle's screen rectangle under the camera. */
export function screenRectOf(camera: CanvasCamera, rect: BoxGeometry): ScreenRect {
  const topLeft = camera.toScreen(rect.x, rect.y);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * camera.scale,
    height: rect.height * camera.scale,
  };
}
