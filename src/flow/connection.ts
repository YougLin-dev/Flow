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

/** The world point of a node's input (left) or output (right) port. */
export function portPoint(node: BoxGeometry, side: PortSide): Point {
  return {
    x: side === "in" ? node.x : node.x + node.width,
    y: node.y + node.height / 2,
  };
}

/** The port hit radius and connector hit distance, in world units. */
export const PORT_HIT_RADIUS = 12;
export const EDGE_HIT_DISTANCE = 8;

/** The control-point reach of the connector's cubic curve. */
function controlReach(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.max(60, Math.min(260, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15));
}

/** Sample points along the connector, from the output port to the input. */
export function connectionPoints(from: Point, to: Point, steps = 16): Point[] {
  const reach = controlReach(from, to);
  const c1 = { x: from.x + reach, y: from.y };
  const c2 = { x: to.x - reach, y: to.y };
  const points: Point[] = [from];
  for (let index = 1; index <= steps; index += 1) {
    points.push(cubicAt(from, c1, c2, to, index / steps));
  }
  return points;
}

/** How far `point` is from the cubic connector, by sampled segments. */
export function distanceToConnection(from: Point, to: Point, point: Point): number {
  const reach = controlReach(from, to);
  const c1 = { x: from.x + reach, y: from.y };
  const c2 = { x: to.x - reach, y: to.y };
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
