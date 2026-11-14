/**
 * The shared rectangle geometry: containment, overlap and union, with the
 * exact edge semantics the canvas hit tests depend on.
 */
import { expect, test } from "nsh/test";
import { containsPoint, mergeBounds, overlaps } from "./geometry";

test("contains a point inside a rectangle, expanded by a margin", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  expect(containsPoint(rect, 10, 20)).toBe(true);
  expect(containsPoint(rect, 60, 50)).toBe(true);
  expect(containsPoint(rect, 9, 50)).toBe(false);
  // The margin widens the hit area without moving the rectangle.
  expect(containsPoint(rect, 9, 50, 6)).toBe(true);
  expect(containsPoint(rect, 3, 50, 6)).toBe(false);
});

test("treats touching edges as an overlap and grows the second box by the margin", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  expect(overlaps(box, { x: 50, y: 20, width: 100, height: 50 })).toBe(true);
  expect(overlaps(box, { x: 100, y: 50, width: 20, height: 20 })).toBe(true);
  expect(overlaps(box, { x: 101, y: 0, width: 20, height: 20 })).toBe(false);
  // A margin grows the second box on every side before the test.
  expect(overlaps(box, { x: 101, y: 0, width: 20, height: 20 }, 1)).toBe(true);
});

test("unions two boxes into the box that holds both", () => {
  expect(
    mergeBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 10 }),
  ).toEqual({ x: 0, y: -5, width: 15, height: 15 });
});
