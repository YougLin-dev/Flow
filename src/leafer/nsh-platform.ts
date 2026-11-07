/**
 * Leafer on NSH.
 *
 * Leafer drives a Canvas 2D context of its own and reads pixels back for hit
 * testing. NSH's `Canvas` hands a recording context to `draw` and replays it
 * natively, with no DOM, no offscreen canvases and no pixel readback. This
 * module adapts Leafer's platform layer to that world:
 *
 * - the main canvas records every call Leafer makes; `draw` replays them onto
 *   the NSH context of the frame,
 * - hit canvases are recorded as paths in JS, so `isPointInPath`,
 *   `isPointInStroke` and the hit canvas's `getImageData` are answered from
 *   geometry instead of pixels,
 * - offscreen canvases (groups with opacity, blend modes, masks, temporary
 *   composite layers) are copied when Leafer draws them, and replayed as
 *   vectors into the destination rectangle,
 * - the canvas has no patterns: a pattern fill clips to the path and tiles
 *   the image itself,
 * - `Platform.requestRender` asks the app for a new frame instead of a
 *   browser animation frame; the view draws every frame in full,
 * - images load through NSH's `Image`; an asset's `@2x`/`@3x` name gives its
 *   density,
 * - Leafer culls what is outside the canvas itself, so large scenes stay
 *   cheap when the viewport moves.
 */
import {
  Image as NshImage,
  pixelRatio,
  type CanvasPaint,
  type CanvasRenderingContext2D,
} from "nsh";
import type { IPointerEvent, IPlatform } from "@leafer-ui/interface";
import { Creator, InteractionBase, Platform } from "@leafer-ui/miniapp";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

type ReplayContext = CanvasRenderingContext2D;
type GradientPaint = ReturnType<CanvasRenderingContext2D["createLinearGradient"]>;
type PathRule = "nonzero" | "evenodd";

interface RecordLike {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

const TAU = Math.PI * 2;

const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (!det) return identity();
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

function matrixScale(m: Matrix): number {
  return (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

interface SubPath {
  points: Point[];
  closed: boolean;
}

/** Collects path commands and flattens curves into polylines. */
class PathRecorder {
  subs: SubPath[] = [];
  current: SubPath | null = null;
  last: Point = { x: 0, y: 0 };
  start: Point = { x: 0, y: 0 };

  begin(): void {
    this.subs = [];
    this.current = null;
  }

  private ensure(x: number, y: number): SubPath {
    return this.current ?? this.moveTo(x, y);
  }

  moveTo(x: number, y: number): SubPath {
    const sub: SubPath = { points: [{ x, y }], closed: false };
    this.current = sub;
    this.subs.push(sub);
    this.last = { x, y };
    this.start = { x, y };
    return sub;
  }

  lineTo(x: number, y: number): void {
    this.ensure(this.last.x, this.last.y).points.push({ x, y });
    this.last = { x, y };
  }

  closePath(): void {
    const sub = this.current;
    if (!sub) return;
    sub.closed = true;
    const first = sub.points[0];
    sub.points.push({ x: first.x, y: first.y });
    this.current = null;
    this.last = { x: first.x, y: first.y };
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ensure(this.last.x, this.last.y);
    const p0 = this.last;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      this.lineTo(a * p0.x + b * cp1x + c * cp2x + d * x, a * p0.y + b * cp1y + c * cp2y + d * y);
    }
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ensure(this.last.x, this.last.y);
    const p0 = this.last;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      this.lineTo(
        mt * mt * p0.x + 2 * mt * t * cpx + t * t * x,
        mt * mt * p0.y + 2 * mt * t * cpy + t * t * y,
      );
    }
  }

  private arcPoints(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
  ): Point[] {
    let delta = end - start;
    if (!counterclockwise && delta < 0) delta += TAU;
    if (counterclockwise && delta > 0) delta -= TAU;
    if (!delta) return [];
    const steps = Math.max(6, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      const angle = start + (delta * i) / steps;
      const ex = rx * Math.cos(angle);
      const ey = ry * Math.sin(angle);
      points.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos });
    }
    return points;
  }

  private appendArc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
  ): void {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const ex = rx * Math.cos(start);
    const ey = ry * Math.sin(start);
    const first = { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos };
    if (this.current) this.lineTo(first.x, first.y);
    else this.moveTo(first.x, first.y);
    const points = this.arcPoints(cx, cy, rx, ry, rotation, start, end, counterclockwise);
    for (const p of points) this.lineTo(p.x, p.y);
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.appendArc(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.appendArc(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!this.current) {
      this.moveTo(x1, y1);
      return;
    }
    const p0 = this.last;
    const v0x = p0.x - x1;
    const v0y = p0.y - y1;
    const v1x = x2 - x1;
    const v1y = y2 - y1;
    const l0 = Math.hypot(v0x, v0y);
    const l1 = Math.hypot(v1x, v1y);
    if (!l0 || !l1 || radius === 0) {
      this.lineTo(x1, y1);
      return;
    }
    const u0 = { x: v0x / l0, y: v0y / l0 };
    const u1 = { x: v1x / l1, y: v1y / l1 };
    const angle = Math.acos(clamp(u0.x * u1.x + u0.y * u1.y, -1, 1));
    if (!angle) {
      this.lineTo(x1, y1);
      return;
    }
    const distance = Math.abs(radius) / Math.tan(angle / 2);
    const t1 = { x: x1 + u0.x * distance, y: y1 + u0.y * distance };
    const t2 = { x: x1 + u1.x * distance, y: y1 + u1.y * distance };
    this.lineTo(t1.x, t1.y);
    let bx = u0.x + u1.x;
    let by = u0.y + u1.y;
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;
    const centerDistance = Math.abs(radius) / Math.sin(angle / 2);
    const cx = x1 + bx * centerDistance;
    const cy = y1 + by * centerDistance;
    const a0 = Math.atan2(t1.y - cy, t1.x - cx);
    const a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const r = Math.abs(radius);
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
    for (let i = 1; i <= steps; i++) {
      const angle2 = a0 + (sweep * i) / steps;
      this.lineTo(cx + r * Math.cos(angle2), cy + r * Math.sin(angle2));
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void {
    const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
    let tl = max;
    let tr = max;
    let br = max;
    let bl = max;
    if (typeof radii === "number") {
      tl = tr = br = bl = clamp(radii, 0, max);
    } else if (radii && radii.length) {
      const r = radii.map((v) => clamp(v, 0, max));
      if (r.length === 1) tl = tr = br = bl = r[0];
      else if (r.length === 2) {
        tl = br = r[0];
        tr = bl = r[1];
      } else if (r.length === 3) {
        tl = r[0];
        tr = bl = r[1];
        br = r[2];
      } else {
        tl = r[0];
        tr = r[1];
        br = r[2];
        bl = r[3];
      }
    }
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    if (tr) this.appendArc(x + w - tr, y + tr, tr, tr, 0, -Math.PI / 2, 0, false);
    this.lineTo(x + w, y + h - br);
    if (br) this.appendArc(x + w - br, y + h - br, br, br, 0, 0, Math.PI / 2, false);
    this.lineTo(x + bl, y + h);
    if (bl) this.appendArc(x + bl, y + h - bl, bl, bl, 0, Math.PI / 2, Math.PI, false);
    this.lineTo(x, y + tl);
    if (tl) this.appendArc(x + tl, y + tl, tl, tl, 0, Math.PI, Math.PI * 1.5, false);
    this.closePath();
  }

  /** The path's subpaths, copied. */
  copy(): SubPath[] {
    return this.subs.map((sub) => ({
      points: sub.points.map((p) => ({ x: p.x, y: p.y })),
      closed: sub.closed,
    }));
  }
}

function contains(polys: Point[][], x: number, y: number, evenOdd: boolean): boolean {
  // Walk every subpath once: even-odd toggles on each crossing, nonzero sums
  // the winding, so holes and self-intersections behave like the canvas'.
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

function distanceToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq ? ((px - x1) * dx + (py - y1) * dy) / lengthSq : 0;
  t = clamp(t, 0, 1);
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return (px - x) * (px - x) + (py - y) * (py - y);
}

function inStroke(polys: Point[][], x: number, y: number, halfWidth: number): boolean {
  const limit = halfWidth * halfWidth;
  for (const points of polys) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (distanceToSegmentSq(x, y, a.x, a.y, b.x, b.y) <= limit) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gradients and patterns
// ---------------------------------------------------------------------------

interface GradientStop {
  offset: number;
  color: string;
}

class GradientRecord {
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

class PatternRecord {
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

function resolvePaint(ctx: ReplayContext, paint: unknown): CanvasPaint | null {
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

/** The pixels of an offscreen NSH canvas, copied when it is drawn. */
export interface CanvasSnapshot {
  width: number;
  height: number;
  ops: Op[];
}

/** A snapshot travelling through the operations as a drawable image. */
class SnapshotImage {
  readonly snapshot: CanvasSnapshot;

  constructor(snapshot: CanvasSnapshot) {
    this.snapshot = snapshot;
  }
}

interface Tile {
  kind: "url" | "snapshot";
  url?: string;
  snapshot?: CanvasSnapshot;
  width: number;
  height: number;
  opacity?: number;
}

/** A positive finite size, or `null` for anything else. */
function dimension(value: unknown): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function patternTile(pattern: PatternRecord): Tile | null {
  const image = pattern.image;
  if (image instanceof NshCanvasSurface) {
    return {
      kind: "snapshot",
      snapshot: image.snapshot(),
      width: image.width,
      height: image.height,
    };
  }
  const url = imageSource(image);
  if (!url) return null;
  const record = isRecord(image) ? image : {};
  const size = isRecord(record.size) ? record.size : {};
  const tile: Tile = {
    kind: "url",
    url,
    width: dimension(record.width) ?? dimension(size.width) ?? 1,
    height: dimension(record.height) ?? dimension(size.height) ?? 1,
  };
  if (typeof record.opacity === "number") tile.opacity = record.opacity;
  return tile;
}

/** Replays a snapshot (an offscreen canvas' drawing) into `args`' rectangle. */
function drawSnapshot(
  ctx: ReplayContext,
  snapshot: CanvasSnapshot,
  args: number[],
  width: number,
  height: number,
): void {
  let sx = 0;
  let sy = 0;
  let sw = snapshot.width;
  let sh = snapshot.height;
  let dx: number;
  let dy: number;
  let dw: number;
  let dh: number;
  if (args.length >= 8) {
    [sx, sy, sw, sh, dx, dy, dw, dh] = args;
  } else if (args.length >= 4) {
    [dx, dy, dw, dh] = args;
  } else if (args.length >= 2) {
    dx = args[0];
    dy = args[1];
    dw = snapshot.width;
    dh = snapshot.height;
  } else {
    return;
  }
  if (!sw || !sh || !dw || !dh) return;
  const kx = dw / sw;
  const ky = dh / sh;
  const matrix: Matrix = { a: kx, b: 0, c: 0, d: ky, e: dx - sx * kx, f: dy - sy * ky };
  ctx.save();
  try {
    ctx.beginPath();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    replayOps(
      ctx,
      snapshot.ops,
      { ctm: matrix, fillPattern: null, strokePattern: null },
      width,
      height,
    );
  } finally {
    try {
      ctx.beginPath();
    } catch {
      // ignore
    }
    ctx.restore();
  }
}

/**
 * Draws a pattern by clipping to the current path and tiling the image;
 * NSH's canvas has no native patterns.
 */
function fillWithPattern(
  ctx: ReplayContext,
  pattern: PatternRecord,
  ctm: Matrix,
  width: number,
  height: number,
  rule?: PathRule,
): void {
  const tile = patternTile(pattern);
  if (!tile) return;
  // The pattern-space rectangle that covers the canvas (the pattern's own
  // transform is applied on top of the current one when tiling).
  const combined = pattern.transform ? multiply(ctm, pattern.transform) : ctm;
  const inv = invert(combined);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ]) {
    const p = applyMatrix(inv, corner);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

  const repeat = pattern.repeat || "repeat";
  const repeatX = repeat !== "repeat-y" && repeat !== "no-repeat";
  const repeatY = repeat !== "repeat-x" && repeat !== "no-repeat";
  const tw = tile.width;
  const th = tile.height;
  const startX = repeatX ? Math.floor(minX / tw) * tw : 0;
  const startY = repeatY ? Math.floor(minY / th) * th : 0;
  const endX = repeatX ? maxX : startX + tw;
  const endY = repeatY ? maxY : startY + th;

  ctx.save();
  try {
    if (rule) ctx.clip(rule);
    else ctx.clip();
    if (typeof tile.opacity === "number" && tile.opacity >= 0 && tile.opacity < 1) {
      ctx.globalAlpha = (Number(ctx.globalAlpha) || 1) * tile.opacity;
    }
    if (pattern.transform) {
      const m = pattern.transform;
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    for (let x = startX; x < endX; x += tw) {
      for (let y = startY; y < endY; y += th) {
        if (tile.kind === "snapshot" && tile.snapshot) {
          drawSnapshot(ctx, tile.snapshot, [x, y, tw, th], width, height);
        } else if (tile.url) {
          ctx.drawImage(tile.url, x, y, tw, th);
        }
      }
    }
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// The recording 2D context
// ---------------------------------------------------------------------------

/** A recorded canvas call: `[0, property, value]` or `[1, method, ...args]`. */
type Op = [0 | 1, string, ...unknown[]];

interface SavedState {
  ctm: Matrix;
  props: Record<string, unknown>;
}

const STYLE_PROPS = [
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "lineCap",
  "lineJoin",
  "miterLimit",
  "lineDashOffset",
  "globalAlpha",
  "globalCompositeOperation",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "font",
  "fontVariantNumeric",
  "textAlign",
  "textBaseline",
  "filter",
  "imageSmoothingEnabled",
  "imageSmoothingQuality",
  "direction",
  "letterSpacing",
  "wordSpacing",
  "fontKerning",
  "fontStretch",
  "fontVariantCaps",
  "textRendering",
] as const;

const REPLAY_PROPS = new Set<string>([
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "lineCap",
  "lineJoin",
  "miterLimit",
  "lineDashOffset",
  "globalAlpha",
  "globalCompositeOperation",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "font",
  "fontVariantNumeric",
  "textAlign",
  "textBaseline",
]);

interface HitShape {
  polys: Point[][];
  evenOdd: boolean;
  halfWidth: number;
  stroke: boolean;
}

interface ReplayState {
  ctm: Matrix;
  fillPattern: PatternRecord | null;
  strokePattern: PatternRecord | null;
}

/** Reads a numeric argument, tolerating values recorded as strings. */
function numberArg(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function ruleArg(value: unknown): PathRule | undefined {
  return value === "nonzero" || value === "evenodd" ? value : undefined;
}

/**
 * Replays recorded operations onto an NSH context, carrying enough state to
 * emulate what NSH's canvas does not have: patterns, offscreen canvases.
 */
function replayOps(
  ctx: ReplayContext,
  ops: Op[],
  state: ReplayState,
  width: number,
  height: number,
): void {
  const states: ReplayState[] = [];
  for (const op of ops) {
    if (op[0] === 0) {
      const name = op[1];
      if (!REPLAY_PROPS.has(name)) continue;
      const value = op[2];

      // Only the two paint properties need translating. Numbers and booleans
      // (globalAlpha, lineWidth, shadowBlur, …) must reach NSH as they are;
      // running them through `resolvePaint` used to drop every one of them.
      if (name === "fillStyle" || name === "strokeStyle") {
        const pattern = value instanceof PatternRecord;
        if (name === "fillStyle") state.fillPattern = pattern ? value : null;
        else state.strokePattern = pattern ? value : null;
        if (pattern) continue;
        try {
          const resolved = resolvePaint(ctx, value);
          if (resolved !== null) Reflect.set(ctx, name, resolved);
        } catch {
          // A gradient NSH's canvas cannot build.
        }
        continue;
      }

      try {
        Reflect.set(ctx, name, value);
      } catch {
        // A value NSH's canvas does not take (an unknown join, a filter).
      }
      continue;
    }

    const name = op[1];
    const args = op.slice(2);
    try {
      switch (name) {
        case "save":
          ctx.save();
          states.push({
            ctm: { ...state.ctm },
            fillPattern: state.fillPattern,
            strokePattern: state.strokePattern,
          });
          break;
        case "restore": {
          const previous = states.pop();
          if (previous) {
            state.ctm = previous.ctm;
            state.fillPattern = previous.fillPattern;
            state.strokePattern = previous.strokePattern;
          }
          ctx.restore();
          break;
        }
        case "setTransform": {
          const [a, b, c, d, e, f] = args.map(numberArg);
          state.ctm = { a, b, c, d, e, f };
          ctx.setTransform(a, b, c, d, e, f);
          break;
        }
        case "resetTransform":
          state.ctm = identity();
          ctx.resetTransform();
          break;
        case "transform": {
          const [a, b, c, d, e, f] = args.map(numberArg);
          state.ctm = multiply(state.ctm, { a, b, c, d, e, f });
          ctx.transform(a, b, c, d, e, f);
          break;
        }
        case "translate": {
          const [x, y] = args.map(numberArg);
          state.ctm = multiply(state.ctm, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
          ctx.translate(x, y);
          break;
        }
        case "scale": {
          const [x, y] = args.map(numberArg);
          state.ctm = multiply(state.ctm, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
          ctx.scale(x, y);
          break;
        }
        case "rotate": {
          const angle = numberArg(args[0]);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          state.ctm = multiply(state.ctm, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
          ctx.rotate(angle);
          break;
        }
        case "fill": {
          const rule = ruleArg(args[0]);
          if (state.fillPattern) {
            fillWithPattern(ctx, state.fillPattern, state.ctm, width, height, rule);
          } else if (rule) ctx.fill(rule);
          else ctx.fill();
          break;
        }
        case "fillRect": {
          const [x, y, w, h] = args.map(numberArg);
          if (state.fillPattern) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            fillWithPattern(ctx, state.fillPattern, state.ctm, width, height);
            ctx.restore();
          } else ctx.fillRect(x, y, w, h);
          break;
        }
        case "stroke":
          if (!state.strokePattern) ctx.stroke();
          break;
        case "strokeRect": {
          if (!state.strokePattern) {
            const [x, y, w, h] = args.map(numberArg);
            ctx.strokeRect(x, y, w, h);
          }
          break;
        }
        case "fillText": {
          if (!state.fillPattern) {
            const [text, x, y, maxWidth] = [
              String(args[0]),
              numberArg(args[1]),
              numberArg(args[2]),
              args.length > 3 ? numberArg(args[3]) : undefined,
            ];
            ctx.fillText(text, x, y, maxWidth);
          }
          break;
        }
        case "strokeText": {
          if (!state.strokePattern) {
            const text = String(args[0]);
            ctx.strokeText(
              text,
              numberArg(args[1]),
              numberArg(args[2]),
              args.length > 3 ? numberArg(args[3]) : undefined,
            );
          }
          break;
        }
        case "clip": {
          const rule = ruleArg(args[0]);
          if (rule) ctx.clip(rule);
          else ctx.clip();
          break;
        }
        case "drawImage": {
          const image = args[0];
          if (image instanceof SnapshotImage) {
            drawSnapshot(ctx, image.snapshot, args.slice(1).map(numberArg), width, height);
          } else {
            const url = imageSource(image);
            if (url) ctx.drawImage(url, ...args.slice(1).map(numberArg));
          }
          break;
        }
        case "putImageData":
          break;
        default: {
          const fn: unknown = Reflect.get(ctx, name);
          if (typeof fn === "function") Reflect.apply(fn, ctx, args);
        }
      }
    } catch {
      // Skip a call NSH's canvas does not support.
    }
  }
}

/** A 2D context that records what is drawn, for replay onto NSH's context. */
export class NshRecordingContext {
  [key: string]: unknown;
  readonly canvas: NshCanvasSurface;
  readonly offscreen: boolean;
  /** A hit canvas keeps geometry for hit tests; a render canvas need not. */
  hitOnly = false;
  ops: Op[] = [];

  private ctm: Matrix = identity();
  private stack: SavedState[] = [];
  private path = new PathRecorder();
  private shapes: HitShape[] = [];
  private props: Record<string, unknown> = {};
  private nshCtx: ReplayContext | null = null;

  constructor(canvas: NshCanvasSurface, offscreen: boolean) {
    this.canvas = canvas;
    this.offscreen = offscreen;
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this.lineDashOffset = 0;
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.shadowColor = "rgba(0,0,0,0)";
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.font = "12px sans-serif";
    this.fontVariantNumeric = "normal";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
    this.filter = "none";
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "low";
    this.direction = "ltr";
    this.letterSpacing = "0px";
    this.wordSpacing = "0px";
    this.fontKerning = "auto";
    this.fontStretch = "normal";
    this.fontVariantCaps = "normal";
    this.textRendering = "auto";
    // The properties inherited above are recorded; a frame starts clean.
    this.ops = [];
  }

  // -- recording helpers ----------------------------------------------------

  /** The current value of a style property (for the accessors below). */
  readProp(name: string): unknown {
    return this.props[name];
  }

  /** Records a style property assignment. */
  writeProp(name: string, value: unknown): void {
    this.props[name] = value;
    this.ops.push([0, name, value]);
  }

  private call(name: string, ...args: unknown[]): void {
    this.ops.push([1, name, ...args]);
  }

  private recordShape(stroke: boolean): void {
    if (!this.hitOnly) return;
    const local = this.path.copy();
    const polys = local.map((sub) => sub.points.map((p) => applyMatrix(this.ctm, p)));
    const halfWidth = ((Number(this.props.lineWidth) || 1) / 2) * matrixScale(this.ctm);
    this.shapes.push({ polys, evenOdd: false, halfWidth, stroke });
  }

  // -- frame ---------------------------------------------------------------

  beginFrame(): void {
    this.ops = [];
    this.ctm = identity();
    this.stack = [];
    this.path.begin();
    this.shapes = [];
    this.restoreDefaults();
  }

  private restoreDefaults(): void {
    this.props = {};
    const defaults: Record<string, unknown> = {
      fillStyle: "#000000",
      strokeStyle: "#000000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      lineDashOffset: 0,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      shadowColor: "rgba(0,0,0,0)",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      font: "12px sans-serif",
      fontVariantNumeric: "normal",
      textAlign: "start",
      textBaseline: "alphabetic",
    };
    for (const key of Object.keys(defaults)) this.props[key] = defaults[key];
  }

  replay(ctx: ReplayContext): void {
    this.nshCtx = ctx;
    // NSH hands each frame a fresh recording, but leaving the transform and
    // dashes at their defaults keeps a reused context predictable too.
    try {
      ctx.resetTransform();
      ctx.setLineDash([]);
    } catch {
      // The context does not have them.
    }
    replayOps(
      ctx,
      this.ops,
      { ctm: identity(), fillPattern: null, strokePattern: null },
      this.canvas.width,
      this.canvas.height,
    );
  }

  // -- state ---------------------------------------------------------------

  save(): void {
    this.stack.push({
      ctm: { ...this.ctm },
      props: { ...this.props },
    });
    this.call("save");
  }

  restore(): void {
    const state = this.stack.pop();
    if (state) {
      this.ctm = state.ctm;
      this.props = state.props;
    }
    this.call("restore");
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctm = { a, b, c, d, e, f };
    this.call("setTransform", a, b, c, d, e, f);
  }

  resetTransform(): void {
    this.ctm = identity();
    this.call("resetTransform");
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctm = multiply(this.ctm, { a, b, c, d, e, f });
    this.call("transform", a, b, c, d, e, f);
  }

  translate(x: number, y: number): void {
    this.ctm = multiply(this.ctm, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    this.call("translate", x, y);
  }

  scale(x: number, y: number): void {
    this.ctm = multiply(this.ctm, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
    this.call("scale", x, y);
  }

  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.ctm = multiply(this.ctm, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    this.call("rotate", angle);
  }

  getTransform(): Matrix {
    return { ...this.ctm };
  }

  setLineDash(segments: number[]): void {
    this.call("setLineDash", segments);
  }

  getLineDash(): number[] {
    return [];
  }

  // -- path ----------------------------------------------------------------

  beginPath(): void {
    this.path.begin();
    this.call("beginPath");
  }

  moveTo(x: number, y: number): void {
    if (this.hitOnly) this.path.moveTo(x, y);
    this.call("moveTo", x, y);
  }

  lineTo(x: number, y: number): void {
    if (this.hitOnly) this.path.lineTo(x, y);
    this.call("lineTo", x, y);
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    if (this.hitOnly) this.path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    this.call("bezierCurveTo", cp1x, cp1y, cp2x, cp2y, x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (this.hitOnly) this.path.quadraticCurveTo(cpx, cpy, x, y);
    this.call("quadraticCurveTo", cpx, cpy, x, y);
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    if (this.hitOnly) this.path.arc(x, y, radius, startAngle, endAngle, Boolean(counterclockwise));
    this.call("arc", x, y, radius, startAngle, endAngle, Boolean(counterclockwise));
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (this.hitOnly) this.path.arcTo(x1, y1, x2, y2, radius);
    this.call("arcTo", x1, y1, x2, y2, radius);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void {
    if (this.hitOnly) {
      this.path.ellipse(
        x,
        y,
        radiusX,
        radiusY,
        rotation,
        startAngle,
        endAngle,
        Boolean(counterclockwise),
      );
    }
    this.call(
      "ellipse",
      x,
      y,
      radiusX,
      radiusY,
      rotation,
      startAngle,
      endAngle,
      Boolean(counterclockwise),
    );
  }

  rect(x: number, y: number, w: number, h: number): void {
    if (this.hitOnly) this.path.rect(x, y, w, h);
    this.call("rect", x, y, w, h);
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void {
    if (this.hitOnly) this.path.roundRect(x, y, w, h, radii);
    this.call("roundRect", x, y, w, h, radii ?? 0);
  }

  closePath(): void {
    if (this.hitOnly) this.path.closePath();
    this.call("closePath");
  }

  // -- paint ---------------------------------------------------------------

  private ruleOf(a: unknown): PathRule | undefined {
    return a === "nonzero" || a === "evenodd" ? a : undefined;
  }

  fill(pathOrRule?: unknown, rule?: unknown): void {
    const winding = this.ruleOf(pathOrRule) ?? this.ruleOf(rule);
    if (this.hitOnly) {
      const local = this.path.copy();
      const polys = local.map((sub) => sub.points.map((p) => applyMatrix(this.ctm, p)));
      this.shapes.push({
        polys,
        evenOdd: winding === "evenodd",
        halfWidth: 0,
        stroke: false,
      });
    }
    if (winding) this.call("fill", winding);
    else this.call("fill");
  }

  stroke(_path?: unknown): void {
    if (this.hitOnly) this.recordShape(true);
    this.call("stroke");
  }

  clip(pathOrRule?: unknown, rule?: unknown): void {
    const winding = this.ruleOf(pathOrRule) ?? this.ruleOf(rule);
    if (winding) this.call("clip", winding);
    else this.call("clip");
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.hitOnly) {
      const p = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ].map((point) => applyMatrix(this.ctm, point));
      this.shapes.push({ polys: [p], evenOdd: false, halfWidth: 0, stroke: false });
    }
    this.call("fillRect", x, y, w, h);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (this.hitOnly) {
      const p = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
        { x, y },
      ].map((point) => applyMatrix(this.ctm, point));
      this.shapes.push({
        polys: [p],
        evenOdd: false,
        halfWidth: ((Number(this.props.lineWidth) || 1) / 2) * matrixScale(this.ctm),
        stroke: true,
      });
    }
    this.call("strokeRect", x, y, w, h);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const { width, height } = this.canvas;
    const full = x <= 0 && y <= 0 && w >= width && h >= height;
    if (this.offscreen) {
      // Leafer recycles offscreen canvases: whatever was recorded before a
      // clear is no longer part of what the canvas shows.
      this.ops = [];
      this.path.begin();
      this.shapes = [];
      return;
    }
    // Leafer clears the whole canvas before every frame. NSH starts each
    // frame blank and this module draws the backdrop into it before the
    // replay, so that clear would erase the backdrop: skip it.
    if (full) return;
    this.call("clearRect", x, y, w, h);
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    if (this.hitOnly) {
      const metrics = this.measureText(text);
      const size = fontSizeOf(String(this.props.font));
      const p = [
        { x, y: y - size },
        { x: x + metrics.width, y: y - size },
        { x: x + metrics.width, y },
        { x, y },
      ].map((point) => applyMatrix(this.ctm, point));
      this.shapes.push({ polys: [p], evenOdd: false, halfWidth: 0, stroke: false });
    }
    this.call("fillText", text, x, y, ...(maxWidth === undefined ? [] : [maxWidth]));
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.call("strokeText", text, x, y, ...(maxWidth === undefined ? [] : [maxWidth]));
  }

  measureText(text: string): { width: number } {
    const ctx = this.nshCtx ?? measureContext;
    if (ctx) {
      try {
        return ctx.measureText(text);
      } catch {
        // fall through
      }
    }
    return { width: text.length * fontSizeOf(String(this.props.font)) * 0.6 };
  }

  drawImage(image: unknown, ...args: number[]): void {
    if (this.hitOnly) {
      // The hit canvas only needs to know where something opaque was drawn.
      const dest = args.length >= 4 ? args.slice(-4) : args;
      if (dest.length >= 4) {
        const [dx, dy, dw, dh] = dest;
        const p = [
          { x: dx, y: dy },
          { x: dx + dw, y: dy },
          { x: dx + dw, y: dy + dh },
          { x: dx, y: dy + dh },
        ].map((point) => applyMatrix(this.ctm, point));
        this.shapes.push({ polys: [p], evenOdd: false, halfWidth: 0, stroke: false });
      }
    }
    // An offscreen canvas Leafer renders through loses its drawing when it is
    // recycled; copy what it holds now and draw that as vectors later.
    const source = image instanceof NshCanvasSurface ? new SnapshotImage(image.snapshot()) : image;
    this.call("drawImage", source, ...args);
  }

  putImageData(_image: unknown, _dx: number, _dy: number): void {
    // NSH's canvas has no pixel access; compositing is replayed as vectors.
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientRecord {
    return new GradientRecord("linear", [x0, y0, x1, y1]);
  }

  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): GradientRecord {
    return new GradientRecord("radial", [x0, y0, r0, x1, y1, r1]);
  }

  createConicGradient(startAngle: number, x: number, y: number): GradientRecord {
    return new GradientRecord("conic", [startAngle, x, y]);
  }

  createPattern(image: unknown, repeat: string | null): PatternRecord {
    return new PatternRecord(image, repeat);
  }

  // -- hit testing ---------------------------------------------------------

  isPointInPath(x: number, y: number, rule?: unknown): boolean {
    const winding = this.ruleOf(rule);
    const local = applyMatrix(invert(this.ctm), { x, y });
    const polys = this.path.subs.map((sub) => sub.points);
    return contains(polys, local.x, local.y, winding === "evenodd");
  }

  isPointInStroke(x: number, y: number): boolean {
    const local = applyMatrix(invert(this.ctm), { x, y });
    const polys = this.path.subs.map((sub) => sub.points);
    return inStroke(polys, local.x, local.y, (Number(this.props.lineWidth) || 1) / 2);
  }

  getImageData(
    x: number,
    y: number,
    w: number,
    h: number,
  ): {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  } {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const cx = x + px + 0.5;
        const cy = y + py + 0.5;
        if (this.hitAt(cx, cy)) {
          const index = (py * width + px) * 4;
          data[index + 3] = 255;
        }
      }
    }
    return { width, height, data };
  }

  private hitAt(x: number, y: number): boolean {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i];
      if (shape.stroke) {
        if (inStroke(shape.polys, x, y, shape.halfWidth)) return true;
      } else if (contains(shape.polys, x, y, shape.evenOdd)) {
        return true;
      }
    }
    return false;
  }
}

// -- properties as accessors, recorded --------------------------------------

for (const name of STYLE_PROPS) {
  Object.defineProperty(NshRecordingContext.prototype, name, {
    get(this: NshRecordingContext) {
      return this.readProp(name);
    },
    set(this: NshRecordingContext, value: unknown) {
      this.writeProp(name, value);
    },
    configurable: true,
  });
}

function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)\s*px/.exec(font);
  return match ? Number(match[1]) : 12;
}

function imageSource(image: unknown): string | null {
  if (!image) return null;
  if (typeof image === "string") return image;
  if (isRecord(image)) {
    if (typeof image.url === "string") return image.url;
    if (typeof image.src === "string") return image.src;
  }
  return null;
}

/** The density an asset's file name names (`logo@2x.png` is 2), else 1. */
function assetScale(url: string): number {
  const match = /@(\d+(?:\.\d+)?)x\.[a-z0-9]+(?:[?#]|$)/i.exec(url);
  return match ? Number(match[1]) || 1 : 1;
}

// ---------------------------------------------------------------------------
// Canvas surfaces
// ---------------------------------------------------------------------------

/** The canvas element Leafer draws its scene into. */
export class NshCanvasSurface {
  width: number;
  height: number;
  readonly context: NshRecordingContext;
  readonly __nshCanvas = true;

  constructor(width: number, height: number, offscreen: boolean) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.context = new NshRecordingContext(this, offscreen);
  }

  getContext(_type?: string, _settings?: unknown): NshRecordingContext {
    return this.context;
  }

  /** What this offscreen canvas holds now, for replay as vectors. */
  snapshot(): CanvasSnapshot {
    return {
      width: Math.max(1, this.width),
      height: Math.max(1, this.height),
      ops: this.context.ops.slice(),
    };
  }

  toDataURL(): string {
    return "";
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    return requestAnimationFrame(callback);
  }
}

// ---------------------------------------------------------------------------
// NSH <-> Leafer plumbing
// ---------------------------------------------------------------------------

let measureContext: ReplayContext | null = null;
let drawRequester: (() => void) | null = null;

/** Called by the view when Leafer wants another frame. */
export function setDrawRequester(requester: (() => void) | null): void {
  drawRequester = requester;
}

/** The canvas the NSH component draws one frame into. */
export class LeaferHost {
  readonly view = new NshCanvasSurface(1, 1, false);
  private frameContext: ReplayContext | null = null;

  beginFrame(context: ReplayContext, width: number, height: number): void {
    this.frameContext = context;
    measureContext = context;
    this.view.width = Math.max(1, Math.round(width));
    this.view.height = Math.max(1, Math.round(height));
    this.view.context.beginFrame();
  }

  endFrame(): void {
    if (this.frameContext) this.view.context.replay(this.frameContext);
    this.frameContext = null;
  }
}

/** A pointer event in the shape Leafer's interaction expects. */
export interface PointerData extends IPointerEvent {
  button?: number;
}

export function pointerData(
  x: number,
  y: number,
  options?: {
    multiTouch?: boolean;
    pointerType?: "mouse" | "pen" | "touch";
    buttons?: number;
    button?: number;
    pressure?: number;
    altKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
  },
): PointerData {
  return {
    x,
    y,
    width: 1,
    height: 1,
    pointerType: options?.pointerType ?? "mouse",
    multiTouch: Boolean(options?.multiTouch),
    pressure: options?.pressure ?? 1,
    buttons: options?.buttons ?? 1,
    button: options?.button ?? 0,
    altKey: Boolean(options?.altKey),
    ctrlKey: Boolean(options?.ctrlKey),
    shiftKey: Boolean(options?.shiftKey),
    metaKey: Boolean(options?.metaKey),
    time: Date.now(),
  };
}

let installed = false;

/** Points Leafer's platform layer at NSH. Safe to call more than once. */
export function installNshPlatform(): void {
  if (installed) return;
  installed = true;

  const origin: NonNullable<IPlatform["origin"]> = {
    createCanvas(width: number, height: number) {
      return new NshCanvasSurface(width || 1, height || 1, true);
    },
    canvasToDataURL() {
      return "";
    },
    canvasToBolb() {
      return Promise.reject(new Error("Exporting images is not supported here."));
    },
    canvasSaveAs() {
      return Promise.reject(new Error("Saving images is not supported here."));
    },
    download() {
      return Promise.resolve();
    },
    loadImage(url: string): Promise<{ url: string; width: number; height: number }> {
      // `Image.getSize` counts pixels. An asset is named with its density
      // (`logo@2x.png`), or is 1x; a remote image follows the screen's ratio.
      const scale = url.startsWith("asset:") ? assetScale(url) : pixelRatio();
      return NshImage.getSize(url).then((size) => ({
        url,
        width: size.width / scale,
        height: size.height / scale,
      }));
    },
    loadContent(url: string, responseType?: string): Promise<unknown> {
      return fetch(url).then((response) => {
        if (responseType === "arrayBuffer") return response.arrayBuffer();
        if (responseType === "json") return response.json();
        return response.text();
      });
    },
    noRepeat: "no-repeat",
  };

  Platform.origin = origin;
  const platformCanvas = Creator.canvas?.();
  if (platformCanvas) Platform.canvas = platformCanvas;
  Platform.conicGradientSupport = true;
  // The miniapp canvas reaches for the host's window API when it resizes or
  // stops its auto layout; NSH resizes the view itself.
  Platform.miniapp = {
    select: () => ({}),
    getBounds: () => Promise.resolve({ x: 0, y: 0, width: 0, height: 0 }),
    getSizeView: () => Promise.resolve({ view: null, width: 0, height: 0 }),
    saveToAlbum: () => Promise.resolve(true),
    onWindowResize() {},
    offWindowResize() {},
  };
  Object.defineProperty(Platform, "devicePixelRatio", {
    get: () => 1,
    configurable: true,
  });
  Platform.requestRender = () => {
    if (drawRequester) drawRequester();
  };

  // A "resized canvas" is the same image under another size in points: the
  // pattern code only uses its size, and drawing scales the picture.
  Platform.image.resize = (
    view: unknown,
    width: number,
    height: number,
    xGap?: number,
    yGap?: number,
    _clip?: unknown,
    _smooth?: boolean,
    opacity?: number,
  ) => {
    if (!view) return view;
    const url = imageSource(view);
    if (!url) return view;
    return {
      url,
      width: Math.max(1, Math.floor(width + (xGap ?? 0))),
      height: Math.max(1, Math.floor(height + (yGap ?? 0))),
      opacity,
    };
  };

  // Interaction without DOM: the app feeds pointer events in.
  Creator.interaction = (target, canvas, selector, options) =>
    new InteractionBase(target, canvas, selector, options);

  // Hit canvases are the only ones that need the recorded geometry: mark
  // them so ordinary render canvases skip flattening paths for hit tests.
  const createHitCanvas = Creator.hitCanvas?.bind(Creator);
  Creator.hitCanvas = (options, manager) => {
    if (!createHitCanvas) throw new Error("Leafer's Creator has no hit canvas.");
    const canvas = createHitCanvas(options, manager);
    const surface: unknown = canvas.view;
    if (surface instanceof NshCanvasSurface) surface.context.hitOnly = true;
    return canvas;
  };
}
