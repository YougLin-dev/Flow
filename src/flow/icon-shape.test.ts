import { expect, test } from "nsh/test";
import { iconPath } from "./icon-shape";

test("keeps SVG path data and joins an icon's paths", () => {
  expect(iconPath([["path", { d: "M5 12h14" }]])).toBe("M5 12h14");
  expect(
    iconPath([
      ["path", { d: "M5 12h14" }],
      ["path", { d: "M12 5v14" }],
    ]),
  ).toBe("M5 12h14 M12 5v14");
});

test("draws circles and ellipses as two half arcs", () => {
  expect(iconPath([["circle", { cx: 12, cy: 12, r: 1 }]])).toBe(
    "M 11 12 a 1 1 0 1 0 2 0 a 1 1 0 1 0 -2 0 Z",
  );
  expect(iconPath([["ellipse", { cx: 12, cy: 5, rx: 9, ry: 3 }]])).toBe(
    "M 3 5 a 9 3 0 1 0 18 0 a 9 3 0 1 0 -18 0 Z",
  );
});

test("turns lines, polylines and polygons into paths", () => {
  expect(iconPath([["line", { x1: 3, y1: 4, x2: 21, y2: 4 }]])).toBe("M 3 4 L 21 4");
  expect(iconPath([["polyline", { points: "22 12 16 12 14 15" }]])).toBe("M 22 12 L 16 12 L 14 15");
  expect(iconPath([["polyline", { points: "15,9 18,9 18,11" }]])).toBe("M 15 9 L 18 9 L 18 11");
  expect(iconPath([["polygon", { points: "12 2 19 21 5 21" }]])).toBe("M 12 2 L 19 21 L 5 21 Z");
});

test("rounds a rect from rx or ry, clamping to half its sides", () => {
  expect(iconPath([["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }]])).toBe(
    "M 5 5 H 19 A 2 2 0 0 1 21 7 V 17 A 2 2 0 0 1 19 19 H 5 A 2 2 0 0 1 3 17 V 7 A 2 2 0 0 1 5 5 Z",
  );
  expect(iconPath([["rect", { x: 15, y: 4, width: 4, height: 6, ry: 2 }]])).toBe(
    "M 17 4 H 17 A 2 2 0 0 1 19 6 V 8 A 2 2 0 0 1 17 10 H 17 A 2 2 0 0 1 15 8 V 6 A 2 2 0 0 1 17 4 Z",
  );
  expect(iconPath([["rect", { x: 3, y: 5, width: 18, height: 14 }]])).toBe("M 3 5 H 21 V 19 H 3 Z");
});

test("skips shapes and values a path cannot take", () => {
  expect(
    iconPath([
      ["path", { d: "" }],
      ["bogus", { d: "M0 0" }],
      ["rect", { x: 0, y: 0, width: 0, height: 4 }],
      ["circle", { cx: "x", cy: 0, r: 2 }],
      ["polyline", { points: "1 2 3" }],
    ]),
  ).toBe("");
});
