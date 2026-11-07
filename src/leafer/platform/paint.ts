import type { CanvasPaint } from "nsh";
import type { GradientPaint, ReplayContext } from "./canvas";
import type { Matrix } from "./geometry";
import { isRecord } from "./values";

interface GradientStop {
  offset: number;
  color: string;
}

export class GradientRecord {
  readonly kind: "linear" | "radial" | "conic";
  readonly args: number[];
  readonly stops: GradientStop[] = [];

  constructor(kind: "linear" | "radial" | "conic", args: number[]) {
    this.kind = kind;
    this.args = args;
  }

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }
}

export class PatternRecord {
  readonly image: unknown;
  readonly repeat: string | null;
  transform: Matrix | null = null;

  constructor(image: unknown, repeat: string | null) {
    this.image = image;
    this.repeat = repeat;
  }

  /** Leafer sets the pattern's own transform through this (Canvas API). */
  setTransform(matrix: unknown): void {
    if (!isRecord(matrix)) return;
    const a = Number(matrix.a ?? 1);
    const b = Number(matrix.b ?? 0);
    const c = Number(matrix.c ?? 0);
    this.transform = {
      a,
      b,
      c,
      d: Number(matrix.d ?? a),
      e: Number(matrix.e ?? 0),
      f: Number(matrix.f ?? 0),
    };
  }
}

export function resolvePaint(ctx: ReplayContext, paint: unknown): CanvasPaint | null {
  if (paint instanceof GradientRecord) {
    let gradient: GradientPaint;
    if (paint.kind === "linear") {
      const [x0, y0, x1, y1] = paint.args;
      gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    } else if (paint.kind === "radial") {
      const [x0, y0, r0, x1, y1, r1] = paint.args;
      gradient = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
    } else {
      const [startAngle, x, y] = paint.args;
      gradient = ctx.createConicGradient(startAngle, x, y);
    }
    for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color);
    return gradient;
  }
  // NSH has no patterns; fills with one are emulated in `replayOps`.
  if (paint instanceof PatternRecord) return null;
  return typeof paint === "string" ? paint : null;
}
