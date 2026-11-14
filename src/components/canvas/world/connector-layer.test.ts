import type { CanvasRenderingContext2D } from "nsh";
import { expect, test } from "nsh/test";
import type { Rect } from "../../../flow/shared";
import { connectorLayerView, traceCubic } from "./connector-layer";

test("a missing box puts the canvas at the origin with no size", () => {
  const plain = connectorLayerView(() => null);
  expect([plain.left(), plain.top(), plain.width(), plain.height()]).toEqual([0, 0, 0, 0]);
  expect(plain.origin()).toBeNull();

  const padded = connectorLayerView(() => null, 8);
  expect([padded.left(), padded.top(), padded.width(), padded.height()]).toEqual([-8, -8, 16, 16]);
  expect(padded.origin()).toBeNull();
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

test("a connector cubic traces in canvas coordinates", () => {
  const calls: number[][] = [];
  const cx = {
    moveTo: (...args: number[]) => calls.push(args),
    bezierCurveTo: (...args: number[]) => calls.push(args),
  } as unknown as CanvasRenderingContext2D;

  traceCubic(
    cx,
    { x: 10, y: 20 },
    { x: 10, y: 20 },
    { x: 15, y: 20 },
    { x: 25, y: 30 },
    { x: 30, y: 40 },
  );

  expect(calls).toEqual([
    [0, 0],
    [5, 0, 15, 10, 20, 20],
  ]);
});

test("the view follows the box accessor", () => {
  let box: Rect | null = { x: 0, y: 0, width: 10, height: 10 };
  const view = connectorLayerView(() => box);
  expect(view.width()).toBe(10);
  box = { x: 5, y: 6, width: 20, height: 30 };
  expect([view.left(), view.top(), view.width(), view.height()]).toEqual([5, 6, 20, 30]);
  expect(view.origin()).toEqual({ x: 5, y: 6 });
});
