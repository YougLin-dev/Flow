/** The shared connector canvas's box, derived once for its styles and drawing. */
import { type Accessor, computed } from "nsh";
import { type BoxGeometry, connectionBounds, EDGE_PADDING, mergeBounds } from "./connection";
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
export function connectorLayerBounds(boxes: readonly (BoxGeometry | null)[]): BoxGeometry | null {
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

/** How far past the viewport the canvas keeps its world box, so a small
 * camera move or card drag does not resize the native surface. */
export const CONNECTOR_VIEW_MARGIN = 64;

/**
 * The part of the connector box the camera can show. A canvas over the whole
 * connector graph stays document-sized, and its native surface scales with
 * the camera: at 250% that is tens of millions of pixels to compose every
 * frame. Clipping it to the viewport (plus a margin) keeps the surface about
 * one window large at any zoom; connectors outside cannot be seen and the
 * drawing also clips their curves, so nothing visible is lost.
 */
export function trimConnectorBox(
  box: BoxGeometry | null,
  view: BoxGeometry | null,
): BoxGeometry | null {
  if (box === null) return null;
  if (view === null || view.width <= 0 || view.height <= 0) return box;
  const left = Math.max(box.x, view.x - CONNECTOR_VIEW_MARGIN);
  const top = Math.max(box.y, view.y - CONNECTOR_VIEW_MARGIN);
  const right = Math.min(box.x + box.width, view.x + view.width + CONNECTOR_VIEW_MARGIN);
  const bottom = Math.min(box.y + box.height, view.y + view.height + CONNECTOR_VIEW_MARGIN);
  if (right <= left || bottom <= top) return null;
  // The same 64-point step as the layer box: a pan inside a step does not
  // touch the canvas style or resize its native surface.
  return roundOut({ x: left, y: top, width: right - left, height: bottom - top });
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
