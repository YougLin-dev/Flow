/** The shared connector canvas's box, derived once for its styles and drawing. */
import { type Accessor, computed } from "nsh";
import {
  type BoxGeometry,
  connectionBounds,
  EDGE_PADDING,
  mergeBounds,
} from "./connection";
import type { FlowScene } from "./scene";

/** How coarse the canvas box is, in world points: fine enough that rounding
 * it outward never shows, coarse enough that moving a card does not resize
 * the canvas surface every pointer move. */
const BOX_STEP = 64;

/** Compares the rounded rectangle, not its short-lived object identity. */
export function sameBox(a: BoxGeometry | null, b: BoxGeometry | null): boolean {
  if (a === b) return true;
  return (
    a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** `box` rounded outward to whole `BOX_STEP`s, never clipping what it holds. */
function roundOut(box: BoxGeometry): BoxGeometry {
  const x = Math.floor(box.x / BOX_STEP) * BOX_STEP;
  const y = Math.floor(box.y / BOX_STEP) * BOX_STEP;
  const right = Math.ceil((box.x + box.width) / BOX_STEP) * BOX_STEP;
  const bottom = Math.ceil((box.y + box.height) / BOX_STEP) * BOX_STEP;
  return { x, y, width: right - x, height: bottom - y };
}

/** The union of the usable connector boxes, padded and rounded outward. */
export function connectorLayerBounds(
  boxes: readonly (BoxGeometry | null)[],
): BoxGeometry | null {
  let union: BoxGeometry | null = null;
  for (const bounds of boxes) {
    if (bounds !== null) union = union === null ? bounds : mergeBounds(union, bounds);
  }
  if (union === null) return null;
  return roundOut({
    x: union.x - EDGE_PADDING,
    y: union.y - EDGE_PADDING,
    width: union.width + EDGE_PADDING * 2,
    height: union.height + EDGE_PADDING * 2,
  });
}

/** The connector canvas's world box, or null with no usable connectors. */
export function connectorLayerBox(scene: FlowScene): Accessor<BoxGeometry | null> {
  // One computation serves all four style bindings and the drawing origin;
  // rounded-box equality keeps an in-box move from resizing the canvas.
  return computed(
    () => {
      const boxes: (BoxGeometry | null)[] = [];
      for (const edge of scene.edges()) {
        const ports = scene.edgePorts(edge);
        boxes.push(ports === null ? null : connectionBounds(ports.from, ports.to));
      }
      return connectorLayerBounds(boxes);
    },
    { equals: sameBox },
  );
}
