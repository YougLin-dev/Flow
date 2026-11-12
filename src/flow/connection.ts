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

/** A typed port's diameter and the gap from the card border to its centre. */
export const PORT_SIZE = 18;
export const PORT_CENTER_GAP = 14;
/** How far from a port's centre a press still grabs it. The reach covers the
 * gap to the card's border and a few points of the card, so moving from the
 * card onto its port never drops the hover that keeps the port shown. */
export const PORT_HIT_RADIUS = 24;
/** How far a lifted port follows the pointer from its anchor. */
export const PORT_FOLLOW_MAX = 22;

/** A port's vertical anchor from the card's top: the stack is spread evenly
 * over the card's side, like `justify-evenly`, whatever the card's height. */
export function portOffset(index: number, count: number, height: number): number {
  return (height * (index + 1)) / (count + 1);
}

/** The world point where a connector attaches: the centre of a typed port's
 * icon, just outside the card's edge. */
export function portCenter(node: BoxGeometry, side: PortSide, offset: number): Point {
  return {
    x: side === "in" ? node.x - PORT_CENTER_GAP : node.x + node.width + PORT_CENTER_GAP,
    y: node.y + offset,
  };
}

/** Whether a world point is on a typed port. */
export function portHit(
  node: BoxGeometry,
  side: PortSide,
  offset: number,
  x: number,
  y: number,
): boolean {
  const centerX = side === "in" ? node.x - PORT_CENTER_GAP : node.x + node.width + PORT_CENTER_GAP;
  const dx = x - centerX;
  const dy = y - (node.y + offset);
  return dx * dx + dy * dy <= PORT_HIT_RADIUS * PORT_HIT_RADIUS;
}

/** The resting connector's stroke width and hit distance, in world units. */
export const EDGE_THICKNESS = 1;
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

/** The box holding a cubic, from its control points. */
export function cubicBounds(from: Point, c1: Point, c2: Point, to: Point): BoxGeometry {
  const x = Math.min(from.x, c1.x, c2.x, to.x);
  const y = Math.min(from.y, c1.y, c2.y, to.y);
  return {
    x,
    y,
    width: Math.max(from.x, c1.x, c2.x, to.x) - x,
    height: Math.max(from.y, c1.y, c2.y, to.y) - y,
  };
}

/** The box holding the connector's whole cubic, from its control points. */
export function connectionBounds(from: Point, to: Point): BoxGeometry {
  const { c1, c2 } = connectorControls(from, to);
  return cubicBounds(from, c1, c2, to);
}

/** Whether `a` and `b` meet; `margin` grows `b` on every side. */
export function overlaps(a: BoxGeometry, b: BoxGeometry, margin = 0): boolean {
  return (
    a.x <= b.x + b.width + margin &&
    a.x + a.width >= b.x - margin &&
    a.y <= b.y + b.height + margin &&
    a.y + a.height >= b.y - margin
  );
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

/** The length of the connector's curve, by its sampled segments. */
export function connectionLength(from: Point, to: Point, steps = 24): number {
  const points = connectionPoints(from, to, steps);
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
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
