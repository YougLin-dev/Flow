/**
 * A recorded snapshot as a self-contained SVG document.
 *
 * Leafer draws temporary canvases for masks, erasers, blend copies and
 * grayscale masks: their operations only make sense applied to the temporary
 * canvas, then composited as one picture. NSH's canvas has no offscreen
 * surface, so replaying those operations straight onto the destination leaks
 * the composite into everything already drawn. This serializer draws the
 * snapshot as a document instead: NSH rasterizes it through its image loader
 * and `drawImage` composites the result once, which is the isolation Canvas
 * specifies.
 *
 * The state machine here records the layer's transform, style and path and
 * hands each draw to `shape.ts` or `image.ts`. The Porter-Duff operations SVG
 * can express become masks: `destination-in` keeps what the layer drew where
 * the next drawing has alpha, `destination-out` keeps it where the next
 * drawing has none (through an alpha-inverting filter).
 */
import { identity, multiply, type Matrix } from "../geometry";
import type { PatternTile } from "../pattern";
import { balancedOps, type CanvasSnapshot } from "../snapshot";
import { numberArg, ruleArg, type PathRule } from "../values";
import {
  clipFor,
  grayscaleMaskFor,
  invertMaskFor,
  isTransparentColor,
  maskFor,
  shadowFilterFor,
  SvgDefs,
} from "./defs";
import { drawImage, tileContent } from "./image";
import { element, matrixTransform, numberText, serializeSvg, type SvgElement } from "./nodes";
import { PathCommands, pathData } from "./path";
import { drawText, fillCommands, strokeCommands } from "./shape";
import {
  boundsUnder,
  rectOf,
  stringProp,
  type SvgBounds,
  type SvgPaintState,
  type SvgRect,
} from "./types";

const BLEND_MODES = new Set([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

const DEFAULT_PROPS: Record<string, unknown> = {
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
  textAlign: "start",
  textBaseline: "alphabetic",
  direction: "ltr",
  letterSpacing: "0px",
  wordSpacing: "0px",
  imageSmoothingEnabled: true,
};

interface SavedState {
  ctm: Matrix;
  props: Record<string, unknown>;
  container: SvgElement[];
  clips: ClipFrame[];
  dash: number[];
}

/** A clip path around a group, kept to clip a later clear the same way. */
interface ClipFrame {
  readonly group: SvgElement;
  readonly clip: string;
}

export class SnapshotSerializer implements SvgPaintState {
  readonly defs: SvgDefs;
  readonly root: SvgElement[] = [];
  ctm = identity();
  props: Record<string, unknown> = { ...DEFAULT_PROPS };
  dash: number[] = [];

  private container: SvgElement[] = this.root;
  private clips: ClipFrame[] = [];
  private saves: SavedState[] = [];
  private path = new PathCommands();

  constructor(
    readonly width: number,
    readonly height: number,
    defs?: SvgDefs,
  ) {
    this.defs = defs ?? new SvgDefs();
  }

  run(ops: CanvasSnapshot["ops"]): void {
    for (const op of ops) {
      if (op[0] === 0) {
        this.props[op[1]] = op[2];
        continue;
      }
      this.operation(op[1], op.slice(2));
    }
  }

  matrix(): Matrix {
    return this.ctm;
  }

  snapshotBody(snapshot: CanvasSnapshot, base: Matrix): SvgElement[] {
    const child = new SnapshotSerializer(
      Math.max(1, snapshot.width),
      Math.max(1, snapshot.height),
      this.defs,
    );
    child.run(balancedOps(snapshot.ops));
    const transform = matrixTransform(base);
    return transform ? [element("g", { transform }, child.root)] : child.root;
  }

  tileContent(tile: PatternTile, matrix: Matrix): SvgElement | null {
    return tileContent(this, tile, matrix);
  }

  /** Appends a drawing, or turns it into the mask of everything before it. */
  place(node: SvgElement, bounds: SvgBounds | null, grayscale = false): void {
    const composite = stringProp(this.props, "globalCompositeOperation", "source-over");
    if (composite === "destination-in" || composite === "destination-out") {
      const drawn = this.decorate(node, bounds, false);
      const mask =
        composite === "destination-out"
          ? invertMaskFor(this.defs, this.width, this.height, [drawn])
          : grayscale
            ? grayscaleMaskFor(this.defs, this.width, this.height, [drawn])
            : maskFor(this.defs, this.width, this.height, [drawn], "alpha");
      this.wrapPrior(mask);
      return;
    }
    if (composite === "copy") this.container.splice(0);
    if (composite === "destination-over") {
      this.container.splice(0, 0, this.decorate(node, bounds, false));
      return;
    }
    this.container.push(this.decorate(node, bounds, true));
  }

  private operation(name: string, args: unknown[]): void {
    switch (name) {
      case "save":
        this.saves.push({
          ctm: { ...this.ctm },
          props: { ...this.props },
          container: this.container,
          clips: [...this.clips],
          dash: this.dash,
        });
        break;
      case "restore": {
        const state = this.saves.pop();
        if (state) {
          this.ctm = state.ctm;
          this.props = state.props;
          this.container = state.container;
          this.clips = state.clips;
          this.dash = state.dash;
        }
        break;
      }
      case "setTransform":
        this.ctm = matrixOf(args) ?? this.ctm;
        break;
      case "resetTransform":
        this.ctm = identity();
        break;
      case "transform":
      case "translate":
      case "scale":
      case "rotate":
        this.changeTransform(name, args);
        break;
      case "setLineDash":
        this.dash = Array.isArray(args[0])
          ? args[0].map(numberArg).filter((value) => Number.isFinite(value))
          : [];
        break;
      case "beginPath":
        this.path.begin();
        break;
      case "moveTo":
        this.path.moveTo(numberArg(args[0]), numberArg(args[1]), this.ctm);
        break;
      case "lineTo":
        this.path.lineTo(numberArg(args[0]), numberArg(args[1]), this.ctm);
        break;
      case "bezierCurveTo":
        this.path.bezierCurveTo(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          numberArg(args[4]),
          numberArg(args[5]),
          this.ctm,
        );
        break;
      case "quadraticCurveTo":
        this.path.quadraticCurveTo(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          this.ctm,
        );
        break;
      case "arc":
        this.path.arc(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          numberArg(args[4]),
          Boolean(args[5]),
          this.ctm,
        );
        break;
      case "arcTo":
        this.path.arcTo(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          numberArg(args[4]),
          this.ctm,
        );
        break;
      case "ellipse":
        this.path.ellipse(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          numberArg(args[4]),
          numberArg(args[5]),
          numberArg(args[6]),
          Boolean(args[7]),
          this.ctm,
        );
        break;
      case "rect":
        this.path.rect(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          this.ctm,
        );
        break;
      case "roundRect":
        this.path.roundRect(
          numberArg(args[0]),
          numberArg(args[1]),
          numberArg(args[2]),
          numberArg(args[3]),
          radiiOf(args[4]),
          this.ctm,
        );
        break;
      case "closePath":
        this.path.closePath();
        break;
      case "fill":
        fillCommands(this, this.path.commands, ruleArg(args[0]));
        break;
      case "stroke":
        strokeCommands(this, this.path.commands);
        break;
      case "clip":
        this.clipCommands(this.path.commands, ruleArg(args[0]));
        break;
      case "fillRect":
      case "strokeRect": {
        const rect = normalizedRect(args);
        if (!rect) break;
        const shape = new PathCommands();
        shape.rect(rect.x, rect.y, rect.width, rect.height, this.ctm);
        if (name === "fillRect") fillCommands(this, shape.commands, undefined);
        else strokeCommands(this, shape.commands);
        break;
      }
      case "clearRect": {
        const rect = normalizedRect(args);
        if (rect) this.clearArea(rect.x, rect.y, rect.width, rect.height);
        break;
      }
      case "fillText":
        drawText(this, args, false);
        break;
      case "strokeText":
        drawText(this, args, true);
        break;
      case "drawImage":
        drawImage(this, args);
        break;
      default:
        break;
    }
  }

  private changeTransform(name: string, args: unknown[]): void {
    const values = args.map(numberArg);
    if (!values.every((value) => Number.isFinite(value))) return;
    let next: Matrix;
    if (name === "transform") {
      next = {
        a: values[0],
        b: values[1],
        c: values[2],
        d: values[3],
        e: values[4],
        f: values[5],
      };
    } else if (name === "translate") {
      next = { a: 1, b: 0, c: 0, d: 1, e: values[0], f: values[1] };
    } else if (name === "scale") {
      next = { a: values[0], b: 0, c: 0, d: values[1], e: 0, f: 0 };
    } else {
      const angle = values[0];
      next = {
        a: Math.cos(angle),
        b: Math.sin(angle),
        c: -Math.sin(angle),
        d: Math.cos(angle),
        e: 0,
        f: 0,
      };
    }
    this.ctm = multiply(this.ctm, next);
  }

  private clipCommands(commands: PathCommands["commands"], rule?: PathRule): void {
    const clip = clipFor(this.defs, commands, identity(), rule);
    const group = element("g", { "clip-path": clip });
    this.container.push(group);
    this.clips.push({ group, clip });
    this.container = group.children;
  }

  private clearArea(x: number, y: number, w: number, h: number): void {
    // The rectangle is in user space; the canvas' size is in snapshot space.
    const bounds = boundsUnder({ x, y, width: w, height: h }, this.ctm);
    if (
      this.ctm.b === 0 &&
      this.ctm.c === 0 &&
      bounds.minX <= 0 &&
      bounds.minY <= 0 &&
      bounds.maxX >= this.width &&
      bounds.maxY >= this.height
    ) {
      this.clearPrior();
      return;
    }
    // A clear erases what the layer drew before it, not what it draws after:
    // mask the content already in every open container. The cleared rectangle
    // is clipped by every open clip; a clip belongs to the layer's
    // destination, not to the mask, so each level repeats the whole chain.
    const shape = new PathCommands();
    shape.rect(x, y, w, h, this.ctm);
    let cleared: SvgElement = element("path", {
      d: pathData(shape.commands, identity()),
      fill: "#000",
    });
    for (const clip of this.clips) {
      cleared = element("g", { "clip-path": clip.clip }, [cleared]);
    }
    const mask = maskFor(
      this.defs,
      this.width,
      this.height,
      [
        element("rect", {
          x: "0",
          y: "0",
          width: numberText(this.width),
          height: numberText(this.height),
          fill: "#fff",
        }),
        cleared,
      ],
      "luminance",
    );
    for (const { container, before } of this.levels()) {
      this.wrapBefore(container, before, mask);
    }
  }

  /**
   * The containers on the way from the root to the current one, each with the
   * clipped group that must stay outside its wrapper: a clear masks the
   * content before that group, so later drawing inside it is not erased.
   */
  private levels(): { container: SvgElement[]; before: SvgElement | null }[] {
    const levels: { container: SvgElement[]; before: SvgElement | null }[] = [];
    let container = this.root;
    for (const clip of this.clips) {
      levels.push({ container, before: clip.group });
      container = clip.group.children;
    }
    levels.push({ container: this.container, before: null });
    return levels;
  }

  private wrapBefore(container: SvgElement[], before: SvgElement | null, mask: string): void {
    const end = before ? container.indexOf(before) : container.length;
    if (end <= 0) return;
    const prior = container.splice(0, end);
    container.splice(0, 0, element("g", { mask }, prior));
  }

  /** A clear that covers the layer erases all content drawn before it. */
  private clearPrior(): void {
    for (const { container, before } of this.levels()) {
      const end = before ? container.indexOf(before) : container.length;
      if (end > 0) container.splice(0, end);
    }
  }

  /**
   * Adds the state's opacity, blend and shadow. A shadow's region and offsets
   * are in the canvas' space, as Canvas keeps them, so they go on an
   * untransformed wrapper around `node`: on the node itself the filter would
   * be resolved in the node's transformed user space and move and scale with
   * it.
   */
  private decorate(node: SvgElement, bounds: SvgBounds | null, blend: boolean): SvgElement {
    const alpha = Number(this.props.globalAlpha);
    const opacity = Number.isFinite(alpha) && alpha >= 0 && alpha < 1 ? numberText(alpha) : null;
    const composite = stringProp(this.props, "globalCompositeOperation", "source-over");
    const style = blend && BLEND_MODES.has(composite) ? `mix-blend-mode:${composite}` : null;
    const filter =
      bounds && this.castsShadow()
        ? shadowFilterFor(
            this.defs,
            stringProp(this.props, "shadowColor", "rgba(0,0,0,0)"),
            Number(this.props.shadowBlur) || 0,
            Number(this.props.shadowOffsetX) || 0,
            Number(this.props.shadowOffsetY) || 0,
            rectOf(bounds),
          )
        : null;
    if (!filter) {
      if (opacity) node.attrs.opacity = opacity;
      if (style) node.attrs.style = style;
      return node;
    }
    const wrapper = element("g", { filter });
    if (opacity) wrapper.attrs.opacity = opacity;
    if (style) wrapper.attrs.style = style;
    wrapper.children.push(node);
    return wrapper;
  }

  private castsShadow(): boolean {
    // A shadow with no blur and no offset is still visible behind a
    // translucent fill, so only a fully transparent colour means no shadow.
    return !isTransparentColor(stringProp(this.props, "shadowColor", "rgba(0,0,0,0)"));
  }

  private wrapPrior(mask: string): void {
    const prior = this.container.splice(0);
    this.container.push(element("g", { mask }, prior));
  }
}

function matrixOf(args: unknown[]): Matrix | null {
  const values = args.map(numberArg);
  if (values.length < 6 || !values.every((value) => Number.isFinite(value))) return null;
  return { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
}

function radiiOf(value: unknown): number | number[] | undefined {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(numberArg).filter((n) => Number.isFinite(n));
  return undefined;
}

function normalizedRect(args: unknown[]): SvgRect | null {
  let [x, y, width, height] = args.map(numberArg);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  if (!width || !height) return null;
  return { x, y, width, height };
}

/**
 * A snapshot as an SVG document, shown at its own size or at the `crop`
 * rectangle of it (a `drawImage` source rectangle). The intrinsic size is in
 * points, so a canvas draws the document into an explicit rectangle rather
 * than relying on its raster's pixel size.
 */
export function snapshotSvg(snapshot: CanvasSnapshot, crop?: SvgRect): string {
  const serializer = new SnapshotSerializer(
    Math.max(1, snapshot.width),
    Math.max(1, snapshot.height),
  );
  serializer.run(balancedOps(snapshot.ops));
  // A source rectangle may be narrower than a point: its viewBox is exact,
  // while the intrinsic size stays positive for the SVG document.
  const width = crop ? crop.width : Math.max(1, snapshot.width);
  const height = crop ? crop.height : Math.max(1, snapshot.height);
  const viewBox = crop
    ? `${numberText(crop.x)} ${numberText(crop.y)} ${numberText(width)} ${numberText(height)}`
    : `0 0 ${numberText(width)} ${numberText(height)}`;
  const children: SvgElement[] = [];
  if (serializer.defs.nodes.length) children.push(element("defs", {}, serializer.defs.nodes));
  children.push(...serializer.root);
  return serializeSvg(
    element(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: numberText(width),
        height: numberText(height),
        viewBox,
      },
      children,
    ),
  );
}

/** A snapshot as a `data:` URL an NSH canvas can draw. */
export function snapshotSvgUrl(snapshot: CanvasSnapshot, crop?: SvgRect): string {
  const bytes = new TextEncoder().encode(snapshotSvg(snapshot, crop));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
