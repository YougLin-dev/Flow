/**
 * Which cards the canvas still paints. The scene keeps every selected card —
 * its connectors and the group frame need its rectangle — but a card wholly
 * outside the camera's view contributes nothing to the frame. At a high zoom
 * a box-selected board leaves most of its cards far outside the viewport, and
 * painting their scaled decorations and text is work for the clip to throw
 * away.
 */
import type { CameraBounds } from "./camera";
import { overlaps, type BoxGeometry } from "./connection";

/**
 * How far outside the viewport a card may still show pixels: the title row
 * sits above the body's rectangle, the plus buttons reach out to the sides
 * and the card shadow spreads below and to the right.
 */
export const CARD_CULL_MARGIN = 64;

/** Whether a card's body can put any pixel inside `view`. */
export function cardInView(
  rect: BoxGeometry,
  view: CameraBounds,
  margin: number = CARD_CULL_MARGIN,
): boolean {
  return overlaps(rect, view, margin);
}
