import { expect, test } from "nsh/test";
import type { Rect } from "../../../flow/shared";
import { connectorLayerView } from "./connector-layer";

test("a missing box puts the canvas at the origin with no size", () => {
  const view = connectorLayerView(() => null, 8);
  expect([view.left(), view.top(), view.width(), view.height()]).toEqual([-8, -8, 16, 16]);
  expect(view.origin()).toBeNull();
});

test("the canvas takes the box's position and size, padded on every side", () => {
  const box: Rect = { x: 10, y: 20, width: 100, height: 50 };
  const view = connectorLayerView(() => box, 8);
  expect([view.left(), view.top(), view.width(), view.height()]).toEqual([2, 12, 116, 66]);
  expect(view.origin()).toEqual({ x: 2, y: 12 });
});

test("without padding the canvas origin is the box origin", () => {
  const box: Rect = { x: -30, y: 40, width: 10, height: 20 };
  const view = connectorLayerView(() => box);
  expect([view.left(), view.top(), view.width(), view.height()]).toEqual([-30, 40, 10, 20]);
  expect(view.origin()).toEqual({ x: -30, y: 40 });
});

test("the view follows the box accessor", () => {
  let box: Rect | null = { x: 0, y: 0, width: 10, height: 10 };
  const view = connectorLayerView(() => box);
  expect(view.width()).toBe(10);
  box = { x: 5, y: 6, width: 20, height: 30 };
  expect([view.left(), view.top(), view.width(), view.height()]).toEqual([5, 6, 20, 30]);
  expect(view.origin()).toEqual({ x: 5, y: 6 });
});
