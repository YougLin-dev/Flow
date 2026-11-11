/**
 * Visible pieces of a connector's cubic. A connector's endpoints may lie far
 * outside the viewport while its curve crosses it; Direct2D then tessellates
 * and strokes the whole curve even though almost all of it is clipped. At a
 * high zoom, where a few long connectors cross the screen, that dominates the
 * frame. Sampling the curve and clipping each sample segment to the viewport
 * leaves only what can be seen, so the stroked geometry has about the length
 * of the screen at any zoom.
 */
import {
  type BoxGeometry,
  type Point,
  connectorControls,
  cubicAt,
  cubicBounds,
  overlaps,
} from "./connection";

/** The fewest samples an edge gets, so a short curve is still smooth. */
const MIN_STEPS = 12;
/** The most samples one edge gets, bounding the per-frame JS work. */
const MAX_STEPS = 256;
/** One sample per this fraction of the viewport's width. */
const SAMPLES_PER_VIEW = 48;
/** How close two points must be to count as the same run end. */
const JOIN_EPSILON = 0.01;

/** The cubic's control polygon length: an upper bound on its own length. */
function controlLength(from: Point, c1: Point, c2: Point, to: Point): number {
  return (
    Math.hypot(c1.x - from.x, c1.y - from.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(to.x - c2.x, to.y - c2.y)
  );
}

/** Liang–Barsky: the part of segment `a`–`b` inside `rect`, if any. */
function clipSegment(a: Point, b: Point, rect: BoxGeometry): [Point, Point] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y];
  let enter = 0;
  let leave = 1;
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > leave) return null;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return null;
      if (t < leave) leave = t;
    }
  }
  return [
    { x: a.x + dx * enter, y: a.y + dy * enter },
    { x: a.x + dx * leave, y: a.y + dy * leave },
  ];
}

function grow(box: BoxGeometry, margin: number): BoxGeometry {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

/** Whether any of the cubic can show inside `view` (grown by `margin`). */
export function cubicInView(
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
  view: BoxGeometry,
  margin: number,
): boolean {
  return overlaps(cubicBounds(from, c1, c2, to), view, margin);
}

/**
 * Whether the whole cubic stays inside `view` (grown by `margin`), in which
 * case it can be stroked natively without sampling: its control-point hull
 * contains the curve.
 */
export function cubicInsideView(
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
  view: BoxGeometry,
  margin: number,
): boolean {
  const rect = grow(view, margin);
  const box = cubicBounds(from, c1, c2, to);
  return (
    box.x >= rect.x &&
    box.y >= rect.y &&
    box.x + box.width <= rect.x + rect.width &&
    box.y + box.height <= rect.y + rect.height
  );
}

/**
 * The cubic as world-space polylines, each a contiguous part inside `view`
 * (grown by `margin` to keep a stroke's caps). A curve that never enters the
 * view gives no runs.
 */
export function visibleCubicRuns(
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
  view: BoxGeometry,
  margin: number,
): readonly (readonly Point[])[] {
  const rect = grow(view, margin);
  const length = controlLength(from, c1, c2, to);
  const steps = Math.min(
    MAX_STEPS,
    Math.max(MIN_STEPS, Math.ceil((length / Math.max(rect.width, 1)) * SAMPLES_PER_VIEW)),
  );
  const runs: Point[][] = [];
  let run: Point[] | null = null;
  let previous = from;
  for (let i = 1; i <= steps; i += 1) {
    const point = cubicAt(from, c1, c2, to, i / steps);
    const clipped = clipSegment(previous, point, rect);
    if (clipped === null) {
      run = null;
    } else {
      const [start, end] = clipped;
      if (
        run === null ||
        Math.hypot(start.x - run[run.length - 1].x, start.y - run[run.length - 1].y) > JOIN_EPSILON
      ) {
        run = [start];
        runs.push(run);
      }
      run.push(end);
    }
    previous = point;
  }
  return runs;
}

/** [`visibleCubicRuns`](visibleCubicRuns) for a connector from its ports. */
export function visibleCurveRuns(
  from: Point,
  to: Point,
  view: BoxGeometry,
  margin: number,
): readonly (readonly Point[])[] {
  const { c1, c2 } = connectorControls(from, to);
  return visibleCubicRuns(from, c1, c2, to, view, margin);
}

/** [`cubicInsideView`](cubicInsideView) for a connector from its ports. */
export function curveInsideView(
  from: Point,
  to: Point,
  view: BoxGeometry,
  margin: number,
): boolean {
  const { c1, c2 } = connectorControls(from, to);
  return cubicInsideView(from, c1, c2, to, view, margin);
}
