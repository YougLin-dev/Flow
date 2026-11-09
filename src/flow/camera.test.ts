import { expect, test } from "nsh/test";
import {
  CanvasCamera,
  MAX_SCALE,
  MIN_SCALE,
  WHEEL_NOTCHES_PER_DOUBLING,
  wheelZoomFactor,
} from "./camera";

test("maps screen and world points both ways", () => {
  const camera = new CanvasCamera();
  camera.x = 30;
  camera.y = -10;
  camera.scale = 1.5;

  const world = camera.toWorld(180, 140);
  expect(world.x).toBe(100);
  expect(world.y).toBe(100);

  const screen = camera.toScreen(100, 100);
  expect(screen.x).toBe(180);
  expect(screen.y).toBe(140);
});

test("zooms around a screen point", () => {
  const camera = new CanvasCamera();
  camera.x = 20;
  camera.y = 10;
  camera.scale = 1;
  const before = camera.toWorld(150, 90);

  expect(camera.zoomAround(2, 150, 90)).toBe(true);
  expect(camera.scale).toBe(2);

  const after = camera.toWorld(150, 90);
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

test("clamps zoom and pans", () => {
  const camera = new CanvasCamera();
  expect(camera.zoomAround(1000, 0, 0)).toBe(true);
  expect(camera.scale).toBe(MAX_SCALE);
  expect(camera.zoomAround(1000, 0, 0)).toBe(false);
  expect(camera.zoomAround(0.00001, 0, 0)).toBe(true);
  expect(camera.scale).toBe(MIN_SCALE);

  camera.panBy(12, -4);
  expect(camera.x).toBe(12);
  expect(camera.y).toBe(-4);
});

test("fits and centers content", () => {
  const camera = new CanvasCamera();
  const scale = camera.fit(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 800, height: 600 },
    0,
    2,
  );

  expect(scale).toBe(2);
  expect(camera.scale).toBe(2);
  expect(camera.toScreen(200, 100)).toEqual({ x: 400, y: 300 });
});

test("keeps its view signal in step with its properties", () => {
  const camera = new CanvasCamera();
  camera.x = 5;
  expect(camera.view().x).toBe(5);
  camera.scale = 0.5;
  expect(camera.view()).toEqual({ x: 5, y: 0, scale: 0.5 });
});

test("turns wheel notches into a zoom factor", () => {
  expect(wheelZoomFactor(0)).toBe(1);
  expect(wheelZoomFactor(WHEEL_NOTCHES_PER_DOUBLING)).toBe(0.5);
  expect(wheelZoomFactor(-WHEEL_NOTCHES_PER_DOUBLING)).toBe(2);
  // A notch down zooms out, a notch up zooms in.
  expect(wheelZoomFactor(1)).toBeLessThan(1);
  expect(wheelZoomFactor(-1)).toBeGreaterThan(1);
});

test("ignores non-finite or non-positive camera values", () => {
  const camera = new CanvasCamera();
  camera.x = Number.NaN;
  camera.y = Number.POSITIVE_INFINITY;
  camera.scale = 0;
  expect(camera.view()).toEqual({ x: 0, y: 0, scale: 1 });

  camera.x = 10;
  camera.scale = -2;
  expect(camera.view()).toEqual({ x: 10, y: 0, scale: 1 });
});
