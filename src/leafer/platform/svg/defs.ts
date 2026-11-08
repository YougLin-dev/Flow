/**
 * The definitions a rasterized snapshot needs: gradients, patterns, clips,
 * masks and filters.
 *
 * SVG ids are generated per document and every definition lives in its
 * `<defs>`. Geometries are given in the document's coordinates (the snapshot
 * placed by its parent), so a clip or mask applies to the elements that
 * reference it without inheriting their transforms.
 */
import type { Matrix } from "../geometry";
import { element, matrixTransform, numberText, type SvgElement } from "./nodes";
import type { GradientRecord } from "../paint";
import type { PatternTile } from "../pattern";
import type { PathCommand } from "./path";
import { pathData } from "./path";
import type { PathRule } from "../values";

export class SvgDefs {
  readonly nodes: SvgElement[] = [];
  private count = 0;

  id(prefix: string): string {
    const id = `${prefix}${this.count}`;
    this.count += 1;
    return id;
  }

  add(node: SvgElement): void {
    this.nodes.push(node);
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function gradientFor(defs: SvgDefs, paint: GradientRecord, matrix: Matrix): string | null {
  const transform = matrixTransform(matrix);
  if (!transform || !paint.stops.length) return null;
  const common: Record<string, string> = {
    gradientUnits: "userSpaceOnUse",
    gradientTransform: transform,
  };
  let node: SvgElement;
  if (paint.kind === "linear") {
    const [x0, y0, x1, y1] = paint.args;
    node = element("linearGradient", {
      ...common,
      x1: numberText(x0),
      y1: numberText(y0),
      x2: numberText(x1),
      y2: numberText(y1),
    });
  } else if (paint.kind === "radial") {
    const [x0, y0, r0, x1, y1, r1] = paint.args;
    node = element("radialGradient", {
      ...common,
      cx: numberText(x1),
      cy: numberText(y1),
      r: numberText(Math.max(0, r1)),
      fx: numberText(x0),
      fy: numberText(y0),
      fr: numberText(Math.max(0, r0)),
    });
  } else {
    // SVG has no conic gradient; the caller draws wedges for those.
    return null;
  }
  const stops = paint.stops.toSorted((a, b) => a.offset - b.offset);
  node.children = stops.map((stop) =>
    element("stop", {
      offset: numberText(Math.min(1, Math.max(0, stop.offset))),
      "stop-color": stop.color,
    }),
  );
  const id = defs.id("gradient");
  node.attrs.id = id;
  defs.add(node);
  return `url(#${id})`;
}

export function clipFor(
  defs: SvgDefs,
  commands: PathCommand[],
  matrix: Matrix,
  rule?: PathRule,
): string {
  const d = pathData(commands, matrix);
  const path = element("path", { d, ...(rule ? { "clip-rule": rule } : {}) });
  const id = defs.id("clip");
  defs.add(element("clipPath", { id, clipPathUnits: "userSpaceOnUse" }, [path]));
  return `url(#${id})`;
}

export function rectClipFor(defs: SvgDefs, rect: Rect): string {
  const id = defs.id("clip");
  defs.add(
    element("clipPath", { id, clipPathUnits: "userSpaceOnUse" }, [
      element("rect", {
        x: numberText(rect.x),
        y: numberText(rect.y),
        width: numberText(Math.max(0, rect.width)),
        height: numberText(Math.max(0, rect.height)),
      }),
    ]),
  );
  return `url(#${id})`;
}

export function maskFor(
  defs: SvgDefs,
  width: number,
  height: number,
  contents: SvgElement[],
  type: "alpha" | "luminance",
): string {
  const id = defs.id("mask");
  defs.add(
    element(
      "mask",
      {
        id,
        maskUnits: "userSpaceOnUse",
        x: "0",
        y: "0",
        width: numberText(width),
        height: numberText(height),
        "mask-type": type,
      },
      contents,
    ),
  );
  return `url(#${id})`;
}

/** A mask whose alpha is 1 minus its source's: Canvas' `destination-out`. */
/**
 * Leafer's grayscale mask: alpha becomes `0.299R + 0.587G + 0.114B` times the
 * pixel's own alpha (Rec.601, as `useGrayscaleAlpha` computes it). SVG's
 * luminance mask uses Rec.709, so the conversion is a filter instead.
 */
export function grayscaleMaskFor(
  defs: SvgDefs,
  width: number,
  height: number,
  contents: SvgElement[],
): string {
  const filter = defs.id("grayscale");
  defs.add(
    element(
      "filter",
      {
        id: filter,
        filterUnits: "userSpaceOnUse",
        x: "0",
        y: "0",
        width: numberText(width),
        height: numberText(height),
        "color-interpolation-filters": "sRGB",
      },
      [
        element("feColorMatrix", {
          type: "matrix",
          values: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.299 0.587 0.114 0 0",
        }),
        // The matrix ignores the source's alpha; `in` multiplies the
        // luminance by it, as Leafer does for a partly transparent pixel.
        element("feComposite", { in2: "SourceGraphic", operator: "in" }),
      ],
    ),
  );
  const id = defs.id("mask");
  defs.add(
    element(
      "mask",
      {
        id,
        maskUnits: "userSpaceOnUse",
        x: "0",
        y: "0",
        width: numberText(width),
        height: numberText(height),
        "mask-type": "alpha",
      },
      [element("g", { filter: `url(#${filter})` }, contents)],
    ),
  );
  return `url(#${id})`;
}

export function invertMaskFor(
  defs: SvgDefs,
  width: number,
  height: number,
  source: SvgElement[],
): string {
  const filter = invertFilter(defs, width, height);
  return maskFor(defs, width, height, [element("g", { filter }, source)], "alpha");
}

export function invertFilter(defs: SvgDefs, width: number, height: number): string {
  const id = defs.id("invert");
  defs.add(
    element(
      "filter",
      {
        id,
        filterUnits: "userSpaceOnUse",
        x: "0",
        y: "0",
        width: numberText(width),
        height: numberText(height),
        "color-interpolation-filters": "sRGB",
      },
      [
        element("feFlood", { "flood-color": "#fff" }),
        element("feComposite", { in2: "SourceGraphic", operator: "out" }),
      ],
    ),
  );
  return `url(#${id})`;
}

export function shadowFilterFor(
  defs: SvgDefs,
  color: string,
  blur: number,
  offsetX: number,
  offsetY: number,
  bounds: Rect,
): string | null {
  if (isTransparentColor(color)) return null;
  const deviation = Math.max(0, blur) / 2;
  const pad = deviation * 3 + 2;
  const x = bounds.x + Math.min(0, offsetX) - pad;
  const y = bounds.y + Math.min(0, offsetY) - pad;
  const width = bounds.width + Math.abs(offsetX) + pad * 2;
  const height = bounds.height + Math.abs(offsetY) + pad * 2;
  if (!(width > 0) || !(height > 0)) return null;
  const id = defs.id("shadow");
  defs.add(
    element(
      "filter",
      {
        id,
        filterUnits: "userSpaceOnUse",
        x: numberText(x),
        y: numberText(y),
        width: numberText(width),
        height: numberText(height),
        "color-interpolation-filters": "sRGB",
      },
      [
        element("feDropShadow", {
          dx: numberText(offsetX),
          dy: numberText(offsetY),
          stdDeviation: numberText(deviation),
          "flood-color": color,
        }),
      ],
    ),
  );
  return `url(#${id})`;
}

/**
 * A pattern for a stroke or text fill, whose shape cannot be clipped and
 * tiled by hand. `tileContent` draws the image or snapshot inside the tile.
 */
export function patternFor(
  defs: SvgDefs,
  tile: PatternTile,
  transform: Matrix,
  tileContent: (tile: PatternTile) => SvgElement | null,
  cover: { width: number; height: number } = { width: 0, height: 0 },
): string | null {
  if (!(tile.width > 0) || !(tile.height > 0)) return null;
  // A non-repeating axis shows its one tile only: grow the tile so its
  // content at the origin is not cut off. The rest of the tile stays empty,
  // as Canvas' gap does.
  const repeat = tile.repeat;
  const growX = repeat === "repeat-y" || repeat === "no-repeat";
  const growY = repeat === "repeat-x" || repeat === "no-repeat";
  const tiled = {
    ...tile,
    width: growX ? Math.max(tile.width, cover.width) : tile.width,
    height: growY ? Math.max(tile.height, cover.height) : tile.height,
  };
  const drawn = tileContent(tile);
  if (!drawn) return null;
  const content =
    typeof tile.opacity === "number" && tile.opacity >= 0 && tile.opacity < 1
      ? element("g", { opacity: numberText(tile.opacity) }, [drawn])
      : drawn;
  const matrix = matrixTransform(transform);
  if (!matrix) return null;
  const id = defs.id("pattern");
  defs.add(
    element(
      "pattern",
      {
        id,
        patternUnits: "userSpaceOnUse",
        width: numberText(tiled.width),
        height: numberText(tiled.height),
        patternTransform: matrix,
      },
      [content],
    ),
  );
  return `url(#${id})`;
}

export function isTransparentColor(color: string): boolean {
  if (color === "transparent") return true;
  const match = /^rgba\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*([\d.]+)\s*\)$/i.exec(
    color,
  );
  if (match) return Number(match[1]) === 0;
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(color);
  if (hex) return hex[1].length === 4 ? hex[1][3] === "0" : hex[1].slice(6) === "00";
  return false;
}
