/** Connection geometry: port anchors, the cubic curve, and hit testing. */

export interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PortSide = "in" | "out";

/** The gap between a card's border and its port button's centre. */
export const PORT_GAP = 16;
/** The plus button's diameter, in world units. */
export const PORT_PLUS_SIZE = 16;
/** How far outside a border the pointer may sit in a side zone. */
export const PORT_ZONE_REACH = 28;
/** The vertical span of a side zone around the middle of a side. */
export const PORT_ZONE_HEIGHT = 48;

/** The world point where a connector meets the card's left or right edge. */
export function portPoint(node: BoxGeometry, side: PortSide): Point {
  return {
    x: side === "in" ? node.x : node.x + node.width,
    y: node.y + node.height / 2,
  };
}

/** The rest position of a side's plus button, just outside the border. */
export function portButtonPoint(node: BoxGeometry, side: PortSide): Point {
  const anchor = portPoint(node, side);
  return {
    x: side === "in" ? anchor.x - PORT_GAP : anchor.x + PORT_GAP,
    y: anchor.y,
  };
}

/**
 * The plus button's world position when the pointer is in a card's side
 * zone, or null outside it. The pointer must sit just outside the border,
 * near the middle of the side; the button then follows it in both axes.
 */
export function portZone(node: BoxGeometry, side: PortSide, x: number, y: number): Point | null {
  const centerY = node.y + node.height / 2;
  const half = Math.min(node.height / 2, PORT_ZONE_HEIGHT / 2);
  if (y < centerY - half || y > centerY + half) return null;
  const border = side === "in" ? node.x : node.x + node.width;
  const outward = side === "in" ? border - x : x - border;
  if (outward < 0 || outward > PORT_ZONE_REACH) return null;
  const distance = Math.max(PORT_PLUS_SIZE / 2, outward);
  return { x: side === "in" ? border - distance : border + distance, y };
}

/** The merged plus's followed position in a selection frame's side zone. */
export function framePortZone(
  bounds: BoxGeometry,
  side: PortSide,
  x: number,
  y: number,
  padding: number,
): Point | null {
  const frame = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
  return portZone(frame, side, x, y);
}

/** The connector's stroke width and hit distance, in world units. */
export const EDGE_THICKNESS = 2;
export const EDGE_HIT_DISTANCE = 8;
/** The room a connector canvas leaves around its cubic for the stroke. */
export const EDGE_PADDING = 4;
/** The dashes of a connector being pulled, before it is written. */
export const EDGE_DASH = [7, 5];

/** The control-point reach of the connector's cubic curve. */
function controlReach(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.max(60, Math.min(260, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15));
}

/** The cubic's control points: horizontal handles off each port. */
export function connectorControls(from: Point, to: Point): { c1: Point; c2: Point } {
  const reach = controlReach(from, to);
  return {
    c1: { x: from.x + reach, y: from.y },
    c2: { x: to.x - reach, y: to.y },
  };
}

/** The box holding the connector's whole cubic, from its control points. */
export function connectionBounds(from: Point, to: Point): BoxGeometry {
  const { c1, c2 } = connectorControls(from, to);
  const x = Math.min(from.x, c1.x, c2.x, to.x);
  const y = Math.min(from.y, c1.y, c2.y, to.y);
  return {
    x,
    y,
    width: Math.max(from.x, c1.x, c2.x, to.x) - x,
    height: Math.max(from.y, c1.y, c2.y, to.y) - y,
  };
}

/** The box holding both boxes. */
export function mergeBounds(a: BoxGeometry, b: BoxGeometry): BoxGeometry {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Sample points along the connector, from the output port to the input. */
export function connectionPoints(from: Point, to: Point, steps = 16): Point[] {
  const { c1, c2 } = connectorControls(from, to);
  const points: Point[] = [from];
  for (let index = 1; index <= steps; index += 1) {
    points.push(cubicAt(from, c1, c2, to, index / steps));
  }
  return points;
}

/** How far `point` is from the cubic connector, by sampled segments. */
export function distanceToConnection(from: Point, to: Point, point: Point): number {
  const { c1, c2 } = connectorControls(from, to);
  let best = Number.POSITIVE_INFINITY;
  let previous = from;
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const next = cubicAt(from, c1, c2, to, t);
    best = Math.min(best, distanceToSegment(point, previous, next));
    previous = next;
  }
  return best;
}

/** The cubic point at `t`, exposed for the preview's hit tests and tests. */
export function cubicAt(from: Point, c1: Point, c2: Point, to: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y,
  };
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
