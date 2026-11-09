import { expect, test } from "nsh/test";
import { connectionPoints, cubicAt, distanceToConnection, portPoint } from "./connection";

test("ports anchor at the middle of a card's left and right edges", () => {
  const box = { x: 40, y: 60, width: 300, height: 220 };
  expect(portPoint(box, "in")).toEqual({ x: 40, y: 170 });
  expect(portPoint(box, "out")).toEqual({ x: 340, y: 170 });
});

test("samples the connector from the output port to the input", () => {
  const from = { x: 340, y: 170 };
  const to = { x: 520, y: 170 };
  const points = connectionPoints(from, to, 16);
  expect(points.length).toBe(17);
  expect(points[0]).toEqual(from);
  expect(points[16]).toEqual(to);
  expect(points.every((point) => Math.abs(point.y - 170) < 0.001)).toBe(true);
});

test("hit testing follows the cubic, not its straight chord", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 200 };
  const mid = cubicAt(from, { x: 100, y: 0 }, { x: 100, y: 200 }, to, 0.5);
  // The curve at t=0.5 is halfway between the two control points.
  expect(mid).toEqual({ x: 100, y: 100 });
  expect(distanceToConnection(from, to, mid)).toBeLessThan(0.001);
  expect(distanceToConnection(from, to, { x: 0, y: 200 })).toBeGreaterThan(20);
});
