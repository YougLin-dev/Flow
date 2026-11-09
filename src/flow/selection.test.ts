import { expect, test } from "nsh/test";
import { handleAt, intersects, normalizeRect, resizedRect, selectionHandles } from "./selection";

test("places eight handles around a screen rectangle", () => {
  const handles = selectionHandles({ x: 10, y: 20, width: 100, height: 60 });
  expect(handles.map((handle) => handle.side)).toEqual([
    "nw",
    "n",
    "ne",
    "e",
    "se",
    "s",
    "sw",
    "w",
  ]);
  expect(handles[0]).toEqual({ side: "nw", x: 10, y: 20 });
  expect(handles[3]).toEqual({ side: "e", x: 110, y: 50 });
  expect(handles[5]).toEqual({ side: "s", x: 60, y: 80 });
});

test("picks the handle within reach of a point", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  expect(handleAt(rect, 11, 21)).toBe("nw");
  expect(handleAt(rect, 60, 19)).toBe("n");
  expect(handleAt(rect, 110, 80, 2)).toBe("se");
  expect(handleAt(rect, 60, 50)).toBeNull();
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

test("resizes from the dragged edges and keeps the opposite one fixed", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  expect(resizedRect(start, "se", 40, 20)).toEqual({ x: 100, y: 100, width: 240, height: 120 });
  expect(resizedRect(start, "nw", 40, 30)).toEqual({ x: 140, y: 120, width: 160, height: 80 });
  expect(resizedRect(start, "e", 40, 0)).toEqual({ x: 100, y: 100, width: 240, height: 100 });
  expect(resizedRect(start, "s", 0, -10)).toEqual({ x: 100, y: 100, width: 200, height: 90 });
});

test("never resizes a card below its minimum", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  expect(resizedRect(start, "se", -1000, -1000)).toEqual({
    x: 100,
    y: 100,
    width: 120,
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
