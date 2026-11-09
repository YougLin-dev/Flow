import { expect, test } from "nsh/test";
import { containsPoint, handleAt, intersects, normalizeRect, resizedRect } from "./selection";

test("hit-tests corners and whole edges of a screen rectangle", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  expect(handleAt(rect, 10, 20)).toBe("nw");
  expect(handleAt(rect, 105, 79)).toBe("se");
  // Anywhere along the top edge, not only its midpoint.
  expect(handleAt(rect, 30, 20)).toBe("n");
  expect(handleAt(rect, 90, 21)).toBe("n");
  expect(handleAt(rect, 60, 19)).toBe("n");
  expect(handleAt(rect, 9, 50)).toBe("w");
  expect(handleAt(rect, 110, 70)).toBe("e");
  expect(handleAt(rect, 40, 79)).toBe("s");
  // The interior and points beyond the reach are not resize zones.
  expect(handleAt(rect, 60, 50)).toBeNull();
  expect(handleAt(rect, 130, 50)).toBeNull();
  expect(handleAt(rect, 110, 80, 2)).toBe("se");
});

test("normalizes a rectangle dragged in any direction", () => {
  expect(normalizeRect(100, 50, 20, 10)).toEqual({ x: 20, y: 10, width: 80, height: 40 });
  expect(normalizeRect(20, 10, 100, 50)).toEqual({ x: 20, y: 10, width: 80, height: 40 });
});

test("treats touching edges as an intersection", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  expect(intersects(box, { x: 50, y: 20, width: 100, height: 50 })).toBe(true);
  expect(intersects(box, { x: 100, y: 50, width: 20, height: 20 })).toBe(true);
  expect(intersects(box, { x: 101, y: 0, width: 20, height: 20 })).toBe(false);
});

test("contains a point inside a rectangle, expanded by a margin", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  expect(containsPoint(rect, 10, 20)).toBe(true);
  expect(containsPoint(rect, 60, 50)).toBe(true);
  expect(containsPoint(rect, 9, 50)).toBe(false);
  // The margin widens the hit area without moving the rectangle.
  expect(containsPoint(rect, 9, 50, 6)).toBe(true);
  expect(containsPoint(rect, 3, 50, 6)).toBe(false);
});

test("resizes from the dragged edges and keeps the opposite one fixed", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  expect(resizedRect(start, "se", 40, 20)).toEqual({ x: 100, y: 100, width: 240, height: 120 });
  expect(resizedRect(start, "nw", 20, 10)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  expect(resizedRect(start, "e", 40, 0)).toEqual({ x: 100, y: 100, width: 240, height: 100 });
  expect(resizedRect(start, "s", 0, -10)).toEqual({ x: 100, y: 100, width: 200, height: 90 });
});

test("keeps a corner's aspect ratio and its opposite corner fixed", () => {
  const start = { x: 100, y: 100, width: 400, height: 200 };
  expect(resizedRect(start, "se", 50, 150)).toEqual({ x: 100, y: 100, width: 500, height: 250 });
  expect(resizedRect(start, "nw", 100, 50)).toEqual({ x: 200, y: 150, width: 300, height: 150 });
  expect(resizedRect(start, "ne", -100, 50)).toEqual({ x: 100, y: 150, width: 300, height: 150 });
  expect(resizedRect(start, "sw", -100, 50)).toEqual({ x: 0, y: 100, width: 500, height: 250 });
});

test("does not snap to the minimum when a corner passes one edge", () => {
  const start = { x: 100, y: 100, width: 400, height: 400 };
  // Just at the left edge, the pointer still half way down: half size.
  expect(resizedRect(start, "se", -400, 0)).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  // Past the top edge while still at the right edge: a smooth 37.5%, not the
  // minimum (30% of 400).
  expect(resizedRect(start, "se", 0, -500)).toEqual({ x: 100, y: 100, width: 150, height: 150 });
  // Past the left edge while still at the bottom edge: the same.
  expect(resizedRect(start, "se", -500, 0)).toEqual({ x: 100, y: 100, width: 150, height: 150 });
  // Past both edges: the minimum, 120 px.
  expect(resizedRect(start, "se", -500, -500)).toEqual({
    x: 100,
    y: 100,
    width: 120,
    height: 120,
  });
});

test("never resizes a card below its minimum", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  // The minimum scale keeps both edges above their minimums and the card's
  // aspect ratio, so a 2:1 card stops at 160×80 rather than 120×80.
  expect(resizedRect(start, "se", -1000, -1000)).toEqual({
    x: 100,
    y: 100,
    width: 160,
    height: 80,
  });
  // Pulling the left edge past the right one stops at the minimum width.
  expect(resizedRect(start, "w", 500, 0)).toEqual({
    x: 180,
    y: 100,
    width: 120,
    height: 100,
  });
});
