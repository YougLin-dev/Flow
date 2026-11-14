import { expect, test } from "nsh/test";
import {
  connectionBounds,
  connectionLength,
  connectionPoints,
  connectorControls,
  cubicAt,
  distanceToConnection,
  followPoint,
  magnetEndPoint,
  magnetIconPoint,
  magnetStrength,
  PORT_CENTER_GAP,
  PORT_FOLLOW_MAX,
  PORT_HIT_RADIUS,
  PORT_MAGNET_RADIUS,
  portCenter,
  portHit,
  portOffset,
} from "./connection";

test("typed ports spread evenly over the card side, outside the border", () => {
  const box = { x: 40, y: 60, width: 300, height: 210 };
  expect(portOffset(0, 1, 210)).toBe(105);
  expect(portOffset(0, 2, 210)).toBe(70);
  expect(portOffset(1, 2, 210)).toBe(140);
  expect(portCenter(box, "out", portOffset(0, 1, 210))).toEqual({
    x: 340 + PORT_CENTER_GAP,
    y: 165,
  });
  expect(portCenter(box, "in", portOffset(0, 2, 210))).toEqual({
    x: 40 - PORT_CENTER_GAP,
    y: 130,
  });

  const center = portCenter(box, "out", portOffset(1, 2, 210));
  expect(portHit(box, "out", portOffset(1, 2, 210), center.x, center.y)).toBe(true);
  expect(
    portHit(box, "out", portOffset(1, 2, 210), center.x + PORT_HIT_RADIUS + 0.5, center.y),
  ).toBe(false);
});

test("a dragged end meets the port icon and the field fades out at its edge", () => {
  const anchor = { x: 300, y: 200 };
  // Inside the follow reach the icon sits under the pointer and the dragged
  // end is the pointer itself.
  expect(magnetIconPoint(anchor, { x: 310, y: 200 })).toEqual({ x: 310, y: 200 });
  expect(magnetEndPoint(anchor, { x: 310, y: 200 })).toEqual({ x: 310, y: 200 });

  // At the field's edge the icon is at rest and the end is the pointer: the
  // field has no visible boundary where the line would jump.
  const edge = { x: 300 + PORT_MAGNET_RADIUS, y: 200 };
  expect(magnetIconPoint(anchor, edge)).toEqual(anchor);
  expect(magnetEndPoint(anchor, edge)).toEqual(edge);
  expect(magnetStrength(PORT_FOLLOW_MAX)).toBe(1);
  expect(magnetStrength(PORT_MAGNET_RADIUS)).toBe(0);

  // Halfway through the field the icon leans out and the end settles between
  // the pointer and the icon, never past either.
  const pointer = { x: 300 + (PORT_FOLLOW_MAX + PORT_MAGNET_RADIUS) / 2, y: 200 };
  const icon = magnetIconPoint(anchor, pointer);
  const end = magnetEndPoint(anchor, pointer);
  expect(Math.abs(magnetStrength(pointer.x - anchor.x) - 0.5) < 0.001).toBe(true);
  expect(icon.x).toBeGreaterThan(anchor.x);
  expect(icon.x).toBeLessThanOrEqual(anchor.x + PORT_FOLLOW_MAX);
  expect(end.x).toBeLessThan(pointer.x);
  expect(end.x).toBeGreaterThanOrEqual(icon.x);
});

test("a following port never leaves its reach", () => {
  const center = { x: 100, y: 100 };
  expect(followPoint(center, { x: 110, y: 100 }, PORT_FOLLOW_MAX)).toEqual({ x: 110, y: 100 });

  const held = followPoint(center, { x: 160, y: 180 }, PORT_FOLLOW_MAX);
  const distance = Math.hypot(held.x - center.x, held.y - center.y);
  expect(distance > PORT_FOLLOW_MAX - 0.001 && distance < PORT_FOLLOW_MAX + 0.001).toBe(true);
});

test("measures a connector along its curve", () => {
  // Level ports give a straight line; a vertical pair bows out and back.
  expect(Math.abs(connectionLength({ x: 0, y: 0 }, { x: 100, y: 0 }) - 100) < 0.001).toBe(true);
  expect(connectionLength({ x: 0, y: 0 }, { x: 0, y: 200 })).toBeGreaterThan(200);
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
