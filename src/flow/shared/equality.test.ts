import { expect, test } from "nsh/test";
import { sameBounds, sameBox, samePoint, sameRect, sameRectWithin } from "./equality";

const RECT = { x: 1, y: 2, width: 3, height: 4 };

test("an unchanged nullable rectangle compares equal by value", () => {
  expect(sameBounds(null, null)).toBe(true);
  expect(sameBounds(RECT, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameBounds(null, RECT)).toBe(false);
  expect(sameBounds(RECT, null)).toBe(false);
  expect(sameBounds(RECT, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
});

test("a connector box compares by value, never by identity", () => {
  expect(sameBox(null, null)).toBe(true);
  expect(sameBox(RECT, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameBox(null, RECT)).toBe(false);
  expect(sameBox(RECT, { x: 1.0001, y: 2, width: 3, height: 4 })).toBe(false);
});

test("an exact rectangle comparison rejects any drift", () => {
  expect(sameRect(RECT, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameRect(RECT, { x: 1.01, y: 2, width: 3, height: 4 })).toBe(false);
  expect(sameRect(RECT, { x: 1, y: 2, width: 3, height: 3.99 })).toBe(false);
});

test("a tolerant rectangle comparison absorbs sub-epsilon drift", () => {
  expect(sameRectWithin(RECT, { x: 1.005, y: 1.995, width: 3, height: 4 })).toBe(true);
  expect(sameRectWithin(RECT, { x: 1.009, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameRectWithin(RECT, { x: 1.02, y: 2, width: 3, height: 4 })).toBe(false);
  expect(sameRectWithin(RECT, { x: 1.2, y: 2, width: 3, height: 4 }, 0.25)).toBe(true);
  expect(sameRectWithin(RECT, { x: 1.2, y: 2, width: 3, height: 4 }, 0.1)).toBe(false);
});

test("a nullable point compares by value", () => {
  expect(samePoint(null, null)).toBe(true);
  expect(samePoint({ x: 5, y: 6 }, { x: 5, y: 6 })).toBe(true);
  expect(samePoint(null, { x: 5, y: 6 })).toBe(false);
  expect(samePoint({ x: 5, y: 6 }, null)).toBe(false);
  expect(samePoint({ x: 5, y: 6 }, { x: 5, y: 7 })).toBe(false);
});
