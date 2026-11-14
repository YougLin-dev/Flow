/** The in-place text editor's anchor: the card body's screen box at the
 * camera's scale, so the editor lays out at world type and scales like the
 * card. */
import type { BoxGeometry } from "../../../shared";
import type { CanvasCamera } from "../camera";
import { CARD_BODY_INSET } from "./card-layout";

export interface InlineBodyBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/**
 * The in-place text editor's anchor: the card body's screen origin, its world
 * size and the camera's scale. The editor lays its text out at world type and
 * the view transform scales it, so its font, wrapping and box are identical
 * to the card's own text at every zoom (scaling a font size instead rounds at
 * fractional zooms and narrows the text column).
 */
export function inlineBodyBox(rect: BoxGeometry, camera: CanvasCamera): InlineBodyBox {
  const origin = camera.toScreen(rect.x + CARD_BODY_INSET, rect.y + CARD_BODY_INSET);
  return {
    left: origin.x,
    top: origin.y,
    width: Math.max(1, rect.width - CARD_BODY_INSET * 2),
    height: Math.max(1, rect.height - CARD_BODY_INSET * 2),
    scale: camera.scale,
  };
}
