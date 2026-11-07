import { applyMatrix, clamp, matrixScale, type Matrix, type Point } from "./geometry";
import type { PathRecorder } from "./path";

/**
 * Point-in-path and point-in-stroke tests over flattened polylines.
 *
 * NSH's canvas has no pixel readback, so a hit canvas records geometry as it
 * draws and answers from that instead.
 */

/** Even-odd toggles on each crossing; nonzero sums the winding. */
export function contains(polys: Point[][], x: number, y: number, evenOdd: boolean): boolean {
  // Walk every subpath once, so holes and self-intersections behave like the
  // canvas'.
  let inside = false;
  let winding = 0;
  for (const points of polys) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j];
      const b = points[i];
      if (a.y > y !== b.y > y) {
        const xAt = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
        if (x < xAt) {
          inside = !inside;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? inside : winding !== 0;
}

export function inStroke(
  polys: Point[][],
  x: number,
  y: number,
  halfWidth: number,
  lineCap = "butt",
): boolean {
  const limit = halfWidth * halfWidth;
  for (const points of polys) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      let t = lengthSq ? ((x - a.x) * dx + (y - a.y) * dy) / lengthSq : 0;
      // A butt cap ends at the segment; a point beyond it is not stroked.
      if (lineCap === "butt" && (t < 0 || t > 1)) continue;
      t = clamp(t, 0, 1);
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      if ((x - px) * (x - px) + (y - py) * (y - py) <= limit) return true;
    }
  }
  return false;
}

interface HitShape {
  polys: Point[][];
  evenOdd: boolean;
  halfWidth: number;
  stroke: boolean;
  lineCap: string;
}

interface PixelData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The shapes a hit canvas has recorded, in drawing order. */
export class HitRegions {
  private shapes: HitShape[] = [];

  clear(): void {
    this.shapes = [];
  }

  fillPath(path: PathRecorder, ctm: Matrix, evenOdd: boolean): void {
    this.add(worldPolys(path, ctm), evenOdd, 0, false, "butt");
  }

  strokePath(path: PathRecorder, ctm: Matrix, lineWidth: number, lineCap = "butt"): void {
    this.add(worldPolys(path, ctm), false, (lineWidth / 2) * matrixScale(ctm), true, lineCap);
  }

  /** A local-space rectangle, filled or stroked. */
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    ctm: Matrix,
    stroke = false,
    lineWidth = 1,
    lineCap = "butt",
  ): void {
    const closed = stroke
      ? [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
          { x, y },
        ]
      : [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ];
    const halfWidth = stroke ? (lineWidth / 2) * matrixScale(ctm) : 0;
    this.add([closed.map((point) => applyMatrix(ctm, point))], false, halfWidth, stroke, lineCap);
  }

  /** A local-space polygon, filled. */
  polygon(points: Point[], ctm: Matrix): void {
    this.add([points.map((point) => applyMatrix(ctm, point))], false, 0, false, "butt");
  }

  getImageData(x: number, y: number, w: number, h: number): PixelData {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        if (this.hitAt(x + px + 0.5, y + py + 0.5)) {
          data[(py * width + px) * 4 + 3] = 255;
        }
      }
    }
    return { width, height, data };
  }

  private add(
    polys: Point[][],
    evenOdd: boolean,
    halfWidth: number,
    stroke: boolean,
    lineCap: string,
  ): void {
    this.shapes.push({ polys, evenOdd, halfWidth, stroke, lineCap });
  }

  private hitAt(x: number, y: number): boolean {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i];
      if (shape.stroke) {
        if (inStroke(shape.polys, x, y, shape.halfWidth, shape.lineCap)) return true;
      } else if (contains(shape.polys, x, y, shape.evenOdd)) {
        return true;
      }
    }
    return false;
  }
}

function worldPolys(path: PathRecorder, ctm: Matrix): Point[][] {
  return path.copy().map((sub) => sub.points.map((point) => applyMatrix(ctm, point)));
}
