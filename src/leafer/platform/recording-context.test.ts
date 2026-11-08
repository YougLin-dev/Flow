import { expect, test } from "nsh/test";
import { NshCanvasSurface } from "./surface";

test("an offscreen full clear inside a save starts a new drawing", () => {
  // Leafer clears a layer canvas before each full render with a clear that is
  // wrapped in save/restore and covers the canvas plus its stroke spread.
  // That is the layer starting over, not a drawing-time erase.
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.fillRect(0, 0, 10, 10);
  ctx.save();
  ctx.clearRect(0, 0, 102, 102);
  ctx.restore();

  expect(canvas.snapshot().ops.length).toBe(0);
});

test("an offscreen clear under a clip still erases", () => {
  // A path eraser clips first, so a full-canvas clearRect in that state only
  // clears inside the clip. It must stay a recorded erase.
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.fillRect(0, 0, 100, 100);
  ctx.save();
  ctx.beginPath();
  ctx.rect(10, 10, 20, 20);
  ctx.clip();
  ctx.clearRect(0, 0, 100, 100);
  ctx.restore();

  expect(canvas.snapshot().ops.some((op) => op[0] === 1 && op[1] === "clearRect")).toBe(true);
});
