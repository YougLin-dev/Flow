import { token, type CanvasRenderingContext2D } from "nsh";
import type { CanvasCamera } from "../leafer/camera";

/**
 * The infinite canvas' dot grid: dots sit at world coordinates, so they pan
 * and zoom with the scene. The spacing doubles or halves to keep the dots
 * between 36 and 72 screen points apart at any zoom.
 */
export function drawGrid(
  cx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: CanvasCamera | null,
): void {
  cx.fillStyle = token("background");
  cx.fillRect(0, 0, width, height);
  if (!camera) return;

  const scale = Math.abs(camera.scale) || 1;
  let step = 32;
  while (step * scale < 36) step *= 2;
  while (step * scale > 72) step /= 2;
  const gap = step * scale;
  if (!(gap > 0.5) || !Number.isFinite(gap)) return;
  const offsetX = ((camera.x % gap) + gap) % gap;
  const offsetY = ((camera.y % gap) + gap) % gap;

  cx.beginPath();
  for (let x = offsetX; x < width; x += gap) {
    for (let y = offsetY; y < height; y += gap) {
      cx.moveTo(x + 1, y);
      cx.arc(x, y, 1, 0, Math.PI * 2);
    }
  }
  cx.fillStyle = token("grid-dot");
  cx.fill();
}
