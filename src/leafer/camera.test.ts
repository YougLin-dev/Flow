import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";

test("zooms around a screen point", () => {
  const camera = new CanvasCamera({ x: 10, y: 20, scale: 1 });
  const before = camera.toWorld(300, 200);

  expect(camera.zoomAround(1.5, 300, 200, 0.2, 4)).toBe(true);
  const after = camera.toWorld(300, 200);

  expect(Math.round(after.x * 1000)).toBe(Math.round(before.x * 1000));
  expect(Math.round(after.y * 1000)).toBe(Math.round(before.y * 1000));
  expect(Math.round(camera.scale * 100)).toBe(150);
});

test("fits and centers content", () => {
  const camera = new CanvasCamera({ x: 0, y: 0, scale: 1 });
  const scale = camera.fit({ x: 40, y: 40, width: 520, height: 272 }, { width: 400, height: 800 });
  expect(Math.round(scale * 100)).toBe(58);

  // The content's center lands in the middle of the viewport.
  const world = camera.toWorld(200, 400);
  expect(Math.round(world.x)).toBe(300);
  expect(Math.round(world.y)).toBe(176);
});

test("maps screen and world points both ways", () => {
  const camera = new CanvasCamera({ x: -120, y: 45, scale: 0.6 });
  const screen = camera.toScreen(500, -80);
  const world = camera.toWorld(screen.x, screen.y);
  expect(Math.round(world.x)).toBe(500);
  expect(Math.round(world.y)).toBe(-80);
});

test("clamps zoom and pans", () => {
  const camera = new CanvasCamera({ x: 0, y: 0, scale: 1 });

  expect(camera.zoomAround(10, 0, 0, 0.5, 2)).toBe(true);
  expect(camera.scale).toBe(2);
  expect(camera.zoomAround(10, 0, 0, 0.5, 2)).toBe(false);
  expect(camera.scale).toBe(2);

  camera.panBy(10, -5);
  expect(camera.x).toBe(10);
  expect(camera.y).toBe(-5);
});
