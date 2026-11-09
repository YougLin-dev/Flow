import { expect, test } from "nsh/test";
import {
  connectionBounds,
  connectionPoints,
  connectorControls,
  cubicAt,
  distanceToConnection,
  portButtonPoint,
  portPoint,
  portZone,
} from "./connection";

test("ports meet a card's left and right edges at their middle", () => {
  const box = { x: 40, y: 60, width: 300, height: 220 };
  expect(portPoint(box, "in")).toEqual({ x: 40, y: 170 });
  expect(portPoint(box, "out")).toEqual({ x: 340, y: 170 });
});

test("plus buttons rest just outside the border", () => {
  const box = { x: 40, y: 60, width: 300, height: 220 };
  expect(portButtonPoint(box, "in")).toEqual({ x: 24, y: 170 });
  expect(portButtonPoint(box, "out")).toEqual({ x: 356, y: 170 });
});

test("a side zone follows the pointer just outside its border", () => {
  const box = { x: 40, y: 60, width: 300, height: 220 };
  expect(portZone(box, "out", 352, 150)).toEqual({ x: 352, y: 150 });
  expect(portZone(box, "in", 28, 190)).toEqual({ x: 28, y: 190 });
  // At the border the button stays clear of it instead of sitting on it.
  expect(portZone(box, "out", 341, 150)).toEqual({ x: 348, y: 150 });
  // Inside the card, past the reach, or past the side's middle are no zone.
  expect(portZone(box, "out", 330, 150)).toBeNull();
  expect(portZone(box, "out", 380, 150)).toBeNull();
  expect(portZone(box, "out", 352, 110)).toBeNull();
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

test("the control points bound the drawn cubic", () => {
  expect(connectorControls({ x: 0, y: 0 }, { x: 200, y: 200 })).toEqual({
    c1: { x: 130, y: 0 },
    c2: { x: 70, y: 200 },
  });
  expect(connectionBounds({ x: 0, y: 0 }, { x: 200, y: 200 })).toEqual({
    x: 0,
    y: 0,
    width: 200,
    height: 200,
  });
  // Short curves reach past their ports, and the box holds that reach.
  expect(connectionBounds({ x: 0, y: 0 }, { x: 40, y: 10 })).toEqual({
    x: -20,
    y: 0,
    width: 80,
    height: 10,
  });
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
