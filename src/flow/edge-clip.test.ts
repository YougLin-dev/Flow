import { expect, test } from "nsh/test";
import type { BoxGeometry, Point } from "./connection";
import { cubicInView, curveInsideView, visibleCurveRuns } from "./edge-clip";

const view: BoxGeometry = { x: 0, y: 0, width: 390, height: 844 };

function insideGrown(point: Point, margin: number): boolean {
  return (
    point.x >= view.x - margin - 0.001 &&
    point.x <= view.x + view.width + margin + 0.001 &&
    point.y >= view.y - margin - 0.001 &&
    point.y <= view.y + view.height + margin + 0.001
  );
}

test("only a curve whose control hull is inside is drawn natively", () => {
  expect(curveInsideView({ x: 40, y: 100 }, { x: 340, y: 500 }, view, 3)).toBe(true);
  expect(curveInsideView({ x: -5000, y: 400 }, { x: 5000, y: 500 }, view, 3)).toBe(false);
});

test("a curve wholly inside the view is one run from port to port", () => {
  const from = { x: 40, y: 100 };
  const to = { x: 340, y: 500 };
  const runs = visibleCurveRuns(from, to, view, 3);
  expect(runs.length).toBe(1);
  const run = runs[0];
  expect(run?.[0]).toEqual(from);
  expect(run?.[run.length - 1]).toEqual(to);
});

test("a curve crossing a narrow view is clipped to the view margin", () => {
  const from = { x: -5000, y: 400 };
  const to = { x: 5000, y: 500 };
  const runs = visibleCurveRuns(from, to, view, 3);
  expect(runs.length).toBe(1);
  for (const point of runs[0] ?? []) expect(insideGrown(point, 3)).toBe(true);
  expect(runs[0]?.[0]?.x).toBeLessThanOrEqual(0);
  expect(runs[0]?.[(runs[0]?.length ?? 1) - 1]?.x).toBeGreaterThanOrEqual(390);
});

test("a curve that leaves and re-enters the view keeps disjoint runs", () => {
  const small = { x: -50, y: -50, width: 100, height: 100 };
  const runs = visibleCurveRuns({ x: 20, y: -20 }, { x: -300, y: -300 }, small, 0);
  expect(runs.length).toBe(2);
  for (const run of runs) {
    for (const point of run) {
      expect(point.x).toBeGreaterThanOrEqual(small.x - 0.001);
      expect(point.x).toBeLessThanOrEqual(small.x + small.width + 0.001);
      expect(point.y).toBeGreaterThanOrEqual(small.y - 0.001);
      expect(point.y).toBeLessThanOrEqual(small.y + small.height + 0.001);
    }
  }
});

test("a curve wholly outside the view gives no runs", () => {
  expect(visibleCurveRuns({ x: -500, y: 5000 }, { x: 500, y: 5100 }, view, 3)).toEqual([]);
});

test("a cubic is in view only when its control hull meets the view", () => {
  expect(
    cubicInView({ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }, { x: 40, y: 10 }, view, 0),
  ).toBe(true);
  expect(
    cubicInView(
      { x: 1000, y: 1000 },
      { x: 1100, y: 1000 },
      { x: 1200, y: 1000 },
      { x: 1300, y: 1000 },
      view,
      0,
    ),
  ).toBe(false);
});

test("the samples follow the cubic, not the straight line between its ends", () => {
  const from = { x: -400, y: 100 };
  const to = { x: 800, y: 700 };
  const runs = visibleCurveRuns(from, to, view, 3);
  expect(runs.length).toBeGreaterThan(0);
  // The connector's handles are horizontal, so the curve enters the view
  // above the chord from `from` to `to`.
  const first = runs[0]?.[0];
  expect(first).toBeDefined();
  const chordY = from.y + ((first?.x ?? -400) - from.x) * ((to.y - from.y) / (to.x - from.x));
  expect((first?.y ?? 0) < chordY).toBe(true);
});
