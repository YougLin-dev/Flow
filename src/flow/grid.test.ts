import { expect, test } from "nsh/test";
import type { CanvasRenderingContext2D } from "nsh";
import { CanvasCamera } from "../leafer/camera";
import { NshCanvasSurface } from "../leafer/nsh-platform";
import { drawGrid } from "./grid";

/** The x of each dot the grid drew. */
function dotXs(context: NshCanvasSurface["context"]): number[] {
  const arcs = context.ops.filter((op) => op[0] === 1 && op[1] === "arc");
  return [...new Set(arcs.map((op) => Number(op[2])))].toSorted((a, b) => a - b);
}

/** The recording context answers the calls `drawGrid` makes. */
function recordingContext(context: NshCanvasSurface["context"]): CanvasRenderingContext2D {
  return context as unknown as CanvasRenderingContext2D;
}

test("keeps dots 36–72 points apart at any zoom", () => {
  for (const scale of [1, 3]) {
    const canvas = new NshCanvasSurface(300, 300, false);
    drawGrid(recordingContext(canvas.context), 300, 300, new CanvasCamera({ x: 0, y: 0, scale }));

    const xs = dotXs(canvas.context);
    expect(xs.length).toBeGreaterThan(1);
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      expect(gap).toBeGreaterThanOrEqual(36);
      expect(gap).toBeLessThanOrEqual(72);
    }
  }
});

test("only clears the background before the first fit", () => {
  const canvas = new NshCanvasSurface(100, 100, false);
  drawGrid(recordingContext(canvas.context), 100, 100, null);

  const calls = canvas.context.ops.filter((op) => op[0] === 1).map((op) => op[1]);
  expect(calls).toEqual(["fillRect"]);
});
