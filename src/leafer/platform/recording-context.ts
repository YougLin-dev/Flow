import type { ReplayContext } from "./canvas";
import { applyMatrix, identity, invert, multiply, type Matrix } from "./geometry";
import { contains, HitRegions, inStroke } from "./hit-test";
import { measureWithNsh } from "./measure";
import type { Op } from "./op";
import { GradientRecord, PatternRecord } from "./paint";
import { PathRecorder } from "./path";
import { replayOps } from "./replay";
import { isSnapshotSource, SnapshotImage } from "./snapshot";
import { ruleArg } from "./values";

interface SavedState {
  ctm: Matrix;
  props: Record<string, unknown>;
}

interface RecordingCanvas {
  readonly width: number;
  readonly height: number;
}

/** Style properties a context records; each gets an accessor below. */
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

/** What a context starts with, and returns to at the start of every frame. */
const DEFAULT_STYLE: Record<string, unknown> = {
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
  filter: "none",
  imageSmoothingEnabled: true,
  imageSmoothingQuality: "low",
  direction: "ltr",
  letterSpacing: "0px",
  wordSpacing: "0px",
  fontKerning: "auto",
  fontStretch: "normal",
  fontVariantCaps: "normal",
  textRendering: "auto",
};

/** A 2D context that records what is drawn, for replay onto NSH's context. */
export class NshRecordingContext {
  [key: string]: unknown;
  readonly canvas: RecordingCanvas;
  readonly offscreen: boolean;
  /** A hit canvas keeps geometry for hit tests; a render canvas need not. */
  hitOnly = false;
  /** The canvas read its pixels back and wrote them back (a grayscale mask). */
  grayscale = false;
  ops: Op[] = [];

  private ctm: Matrix = identity();
  private stack: SavedState[] = [];
  private clipped = false;
  private clipStack: boolean[] = [];
  private path = new PathRecorder();
  private hits = new HitRegions();
  private props: Record<string, unknown> = { ...DEFAULT_STYLE };
  private readPixels = false;

  constructor(canvas: RecordingCanvas, offscreen: boolean) {
    this.canvas = canvas;
    this.offscreen = offscreen;
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

  // -- frame ----------------------------------------------------------------

  beginFrame(): void {
    this.ops = [];
    this.ctm = identity();
    this.stack = [];
    this.clipped = false;
    this.clipStack = [];
    this.path.begin();
    this.hits.clear();
    this.props = { ...DEFAULT_STYLE };
    this.readPixels = false;
    this.grayscale = false;
  }

  replay(ctx: ReplayContext): void {
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
      {
        ctm: identity(),
        fillPattern: null,
        strokePattern: null,
        alphaScale: 1,
        alpha: 1,
        composite: "source-over",
      },
      this.canvas.width,
      this.canvas.height,
    );
  }

  // -- state ----------------------------------------------------------------

  save(): void {
    this.stack.push({
      ctm: { ...this.ctm },
      props: { ...this.props },
    });
    this.clipStack.push(this.clipped);
    this.call("save");
  }

  restore(): void {
    const state = this.stack.pop();
    if (state) {
      this.ctm = state.ctm;
      this.props = state.props;
    }
    const clipped = this.clipStack.pop();
    if (clipped !== undefined) this.clipped = clipped;
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

  // -- paint ----------------------------------------------------------------

  fill(pathOrRule?: unknown, rule?: unknown): void {
    const winding = ruleArg(pathOrRule) ?? ruleArg(rule);
    if (this.hitOnly) this.hits.fillPath(this.path, this.ctm, winding === "evenodd");
    if (winding) this.call("fill", winding);
    else this.call("fill");
  }

  stroke(_path?: unknown): void {
    if (this.hitOnly) {
      this.hits.strokePath(
        this.path,
        this.ctm,
        Number(this.props.lineWidth) || 1,
        String(this.props.lineCap),
      );
    }
    this.call("stroke");
  }

  clip(pathOrRule?: unknown, rule?: unknown): void {
    const winding = ruleArg(pathOrRule) ?? ruleArg(rule);
    this.clipped = true;
    if (winding) this.call("clip", winding);
    else this.call("clip");
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.hitOnly) this.hits.rect(x, y, w, h, this.ctm);
    this.call("fillRect", x, y, w, h);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (this.hitOnly) {
      this.hits.rect(
        x,
        y,
        w,
        h,
        this.ctm,
        true,
        Number(this.props.lineWidth) || 1,
        String(this.props.lineCap),
      );
    }
    this.call("strokeRect", x, y, w, h);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const { width, height } = this.canvas;
    const full = x <= 0 && y <= 0 && w >= width && h >= height;
    if (this.offscreen) {
      if (full && !this.clipped) {
        // Leafer clears a layer canvas before a frame (wrapped in a
        // save/restore) and recycles a canvas at rest by clearing the area it
        // used. Either way the layer starts over; the save stack's own clip is
        // what tells an eraser's clear from a fresh layer.
        this.ops = [];
        this.path.begin();
        this.hits.clear();
        this.readPixels = false;
        this.grayscale = false;
        return;
      }
      // A clear while drawing (a path eraser's clip then clearRect) erases
      // the layer's earlier content: record it, and the snapshot is drawn as
      // one image whose earlier content the serializer masks away.
      this.call("clearRect", x, y, w, h);
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
      this.hits.polygon(
        [
          { x, y: y - size },
          { x: x + metrics.width, y: y - size },
          { x: x + metrics.width, y },
          { x, y },
        ],
        this.ctm,
      );
    }
    this.call("fillText", text, x, y, ...(maxWidth === undefined ? [] : [maxWidth]));
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.call("strokeText", text, x, y, ...(maxWidth === undefined ? [] : [maxWidth]));
  }

  measureText(text: string): { width: number } {
    const font = String(this.props.font);
    const measured = measureWithNsh(text, font);
    if (measured) return measured;
    return { width: text.length * fontSizeOf(font) * 0.6 };
  }

  drawImage(image: unknown, ...args: number[]): void {
    if (this.hitOnly) {
      // The hit canvas only needs to know where something opaque was drawn.
      const dest = args.length >= 4 ? args.slice(-4) : args;
      if (dest.length >= 4) {
        const [dx, dy, dw, dh] = dest;
        this.hits.rect(dx, dy, dw, dh, this.ctm);
      }
    }
    // An offscreen canvas Leafer renders through loses its drawing when it is
    // recycled; copy what it holds now and draw that as vectors later.
    const source = isSnapshotSource(image) ? new SnapshotImage(image.snapshot()) : image;
    this.call("drawImage", source, ...args);
  }

  putImageData(_image: unknown, _dx: number, _dy: number): void {
    // NSH's canvas has no pixel access; compositing is replayed as vectors.
    // A render canvas that read its pixels back and writes them back is
    // Leafer's grayscale mask: replay its drawing through a luminance mask.
    if (!this.hitOnly && this.readPixels) {
      this.grayscale = true;
      this.readPixels = false;
    }
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
    // A canvas pattern must survive Leafer recycling the canvas it was made
    // from, so the tile is copied at creation, as drawImage copies one.
    const source = isSnapshotSource(image) ? new SnapshotImage(image.snapshot()) : image;
    return new PatternRecord(source, repeat);
  }

  // -- hit testing ---------------------------------------------------------

  isPointInPath(x: number, y: number, rule?: unknown): boolean {
    const winding = ruleArg(rule);
    const inv = invert(this.ctm);
    if (!inv) return false;
    const local = applyMatrix(inv, { x, y });
    const polys = this.path.subs.map((sub) => sub.points);
    return contains(polys, local.x, local.y, winding === "evenodd");
  }

  isPointInStroke(x: number, y: number): boolean {
    const inv = invert(this.ctm);
    if (!inv) return false;
    const local = applyMatrix(inv, { x, y });
    const polys = this.path.subs.map((sub) => sub.points);
    return inStroke(
      polys,
      local.x,
      local.y,
      (Number(this.props.lineWidth) || 1) / 2,
      String(this.props.lineCap),
    );
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
    // A render canvas has no pixels to read: note the read, and answer from
    // the (empty) hit geometry. Leafer's grayscale-mask pass reads, converts
    // color to alpha and writes back; `putImageData` turns that into the
    // luminance-mask flag a snapshot carries.
    if (!this.hitOnly) this.readPixels = true;
    return this.hits.getImageData(x, y, w, h);
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
