/** The painting state shapes, text and images share while serializing. */
import { applyMatrix, type Matrix } from "../geometry";
import type { CanvasSnapshot } from "../snapshot";
import type { PatternTile } from "../pattern";
import type { SvgDefs } from "./defs";
import type { SvgElement } from "./nodes";

export interface SvgBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SvgRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgPaintState {
  readonly defs: SvgDefs;
  readonly ctm: Matrix;
  readonly width: number;
  readonly height: number;
  readonly props: Record<string, unknown>;
  /** The current dash pattern, from `setLineDash`. */
  readonly dash: number[];
  /** The snapshot canvas' space through the current transform. */
  matrix(): Matrix;
  place(node: SvgElement, bounds: SvgBounds | null, grayscale?: boolean): void;
  /** A nested snapshot's elements, placed by `base`. */
  snapshotBody(snapshot: CanvasSnapshot, base: Matrix): SvgElement[];
  /** The image inside a pattern tile, placed by `matrix`. */
  tileContent(tile: PatternTile, matrix: Matrix): SvgElement | null;
}

export function rectOf(bounds: SvgBounds): SvgRect {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

export function boundsUnder(rect: SvgRect, matrix: Matrix): SvgBounds {
  const corners = [
    applyMatrix(matrix, { x: rect.x, y: rect.y }),
    applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y }),
    applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y + rect.height }),
    applyMatrix(matrix, { x: rect.x, y: rect.y + rect.height }),
  ];
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

export function stringProp(props: Record<string, unknown>, name: string, fallback: string): string {
  const value = props[name];
  return typeof value === "string" ? value : fallback;
}
