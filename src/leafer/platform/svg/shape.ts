/**
 * Drawing shapes and text into an SVG snapshot.
 *
 * A paint is a color, a gradient or a pattern. NSH can draw gradients itself,
 * but a pattern is expressed here: fills clip the shape and lay tiles at the
 * pattern's own size (a gap stays transparent), strokes and text use an SVG
 * pattern paint server. Canvas path points are stored in canvas space and
 * mapped back through the paint-time transform, so strokes, dashes and paint
 * servers keep the sizes Canvas gives them.
 */
import { applyMatrix, identity, invert, multiply, type Matrix } from "../geometry";
import { measureWithNsh } from "../measure";
import { GradientRecord, PatternRecord } from "../paint";
import { patternTile } from "../pattern";
import { numberArg, type PathRule } from "../values";
import { colorAt, conicWedges } from "./conic";
import { clipFor, gradientFor, patternFor } from "./defs";
import { element, matrixTransform, numberText } from "./nodes";
import { pathBounds, pathData, type PathCommand } from "./path";
import { baselineOf, parseFont, svgAnchorOf, textBounds } from "./text";
import { boundsUnder, rectOf, stringProp, type SvgBounds, type SvgPaintState } from "./types";

export function fillCommands(state: SvgPaintState, commands: PathCommand[], rule?: PathRule): void {
  if (!commands.length) return;
  const paint = state.props.fillStyle;
  if (paint instanceof PatternRecord) {
    fillWithPattern(state, paint, commands, rule);
    return;
  }
  if (paint instanceof GradientRecord && paint.kind === "conic") {
    fillWithConic(state, paint, commands, rule);
    return;
  }
  const value = paintValue(state, paint);
  if (!value) return;
  const inverse = invert(state.ctm);
  const transform = matrixTransform(state.matrix());
  if (!inverse || !transform) return;
  const attrs: Record<string, string> = {
    d: pathData(commands, inverse),
    transform,
    fill: value,
  };
  if (rule) attrs["fill-rule"] = rule;
  state.place(element("path", attrs), pathBounds(commands, identity()));
}

export function strokeCommands(state: SvgPaintState, commands: PathCommand[]): void {
  if (!commands.length) return;
  const width = Number(state.props.lineWidth);
  if (!Number.isFinite(width) || width <= 0) return;
  const paint = state.props.strokeStyle;
  const bounds = strokeBounds(state, commands, width);
  let value: string | null = null;
  let clip: string | null = null;
  if (paint instanceof PatternRecord && bounds) {
    const painted = patternPaint(state, paint, bounds);
    if (painted) {
      value = painted.paint;
      clip = painted.clip;
    }
  } else if (paint instanceof GradientRecord && paint.kind === "conic") {
    value = colorAt(paint, 0.5);
  } else {
    value = paintValue(state, paint);
  }
  if (!value) return;
  const inverse = invert(state.ctm);
  const transform = matrixTransform(state.matrix());
  if (!inverse || !transform) return;
  const attrs: Record<string, string> = {
    d: pathData(commands, inverse),
    transform,
    fill: "none",
    stroke: value,
    "stroke-width": numberText(width),
    "stroke-linecap": stringProp(state.props, "lineCap", "butt"),
    "stroke-linejoin": stringProp(state.props, "lineJoin", "miter"),
    "stroke-miterlimit": numberText(Number(state.props.miterLimit) || 10),
  };
  if (state.dash.length) {
    attrs["stroke-dasharray"] = state.dash.map(numberText).join(" ");
    attrs["stroke-dashoffset"] = numberText(Number(state.props.lineDashOffset) || 0);
  }
  if (clip) attrs["clip-path"] = clip;
  state.place(element("path", attrs), bounds);
}

function fillWithPattern(
  state: SvgPaintState,
  pattern: PatternRecord,
  commands: PathCommand[],
  rule?: PathRule,
): void {
  const tile = patternTile(pattern);
  const bounds = pathBounds(commands, identity());
  if (!tile || !bounds) return;
  const combined = pattern.transform ? multiply(state.matrix(), pattern.transform) : state.matrix();
  const inverse = invert(combined);
  if (!inverse) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of cornersOf(bounds, inverse)) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
  }
  if (!(maxX > minX) || !(maxY > minY)) return;
  const repeat = pattern.repeat || "repeat";
  const repeatX = repeat !== "repeat-y" && repeat !== "no-repeat";
  const repeatY = repeat !== "repeat-x" && repeat !== "no-repeat";
  const startX = repeatX ? Math.floor(minX / tile.width) * tile.width : 0;
  const startY = repeatY ? Math.floor(minY / tile.height) * tile.height : 0;
  const endX = repeatX ? maxX : startX + tile.width;
  const endY = repeatY ? maxY : startY + tile.height;
  const clip = clipFor(state.defs, commands, identity(), rule);
  const group = element("g", { "clip-path": clip });
  for (let x = startX; x < endX; x += tile.width) {
    for (let y = startY; y < endY; y += tile.height) {
      const tileMatrix = multiply(combined, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
      const content = state.tileContent(tile, tileMatrix);
      if (!content) continue;
      const opacity =
        tile.opacity !== undefined && tile.opacity < 1
          ? element("g", { opacity: numberText(tile.opacity) }, [content])
          : content;
      if (tile.kind === "snapshot") {
        // The snapshot's serialized elements already carry `tileMatrix`.
        group.children.push(opacity);
      } else {
        const transform = matrixTransform(tileMatrix);
        if (!transform) continue;
        group.children.push(element("g", { transform }, [opacity]));
      }
    }
  }
  state.place(group, bounds);
}

function fillWithConic(
  state: SvgPaintState,
  paint: GradientRecord,
  commands: PathCommand[],
  rule?: PathRule,
): void {
  const bounds = pathBounds(commands, identity());
  if (!bounds) return;
  // The gradient lives in the paint-time user space (Leafer turns and scales
  // the context for an angular paint), so its wedges are made there and the
  // whole fan carries the current transform.
  const inverse = invert(state.matrix());
  const transform = matrixTransform(state.matrix());
  if (!inverse || !transform) return;
  const userBounds = boundsUnder(
    {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    },
    inverse,
  );
  const clip = clipFor(state.defs, commands, identity(), rule);
  const group = element("g", { "clip-path": clip }, [
    element("g", { transform }, conicWedges(paint, rectOf(userBounds))),
  ]);
  state.place(group, bounds);
}

export function drawText(state: SvgPaintState, args: unknown[], stroke: boolean): void {
  const text = String(args[0]);
  const x = numberArg(args[1]);
  const y = numberArg(args[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const transform = matrixTransform(state.matrix());
  if (!transform) return;
  const fontText = stringProp(state.props, "font", "12px sans-serif");
  const font = parseFont(fontText);
  const attrs: Record<string, string> = {
    transform,
    x: numberText(x),
    y: numberText(y),
    "font-family": font.families,
    "font-size": numberText(font.size),
    // `text-anchor` is flow-relative, as Canvas' start and end are.
    "text-anchor": svgAnchorOf(state.props.textAlign, state.props.direction),
    "dominant-baseline": baselineOf(state.props.textBaseline),
    // Canvas advances through every space; SVG collapses runs by default.
    "xml:space": "preserve",
  };
  if (state.props.direction === "rtl") attrs.direction = "rtl";
  if (font.weight) attrs["font-weight"] = font.weight;
  if (font.style) attrs["font-style"] = font.style;
  const letter = stringProp(state.props, "letterSpacing", "0px");
  if (letter && letter !== "0px" && letter !== "normal") attrs["letter-spacing"] = letter;
  const word = stringProp(state.props, "wordSpacing", "0px");
  if (word && word !== "0px" && word !== "normal") attrs["word-spacing"] = word;

  const natural = measureWithNsh(text, fontText)?.width ?? text.length * font.size * 0.6;
  const maxWidth = args.length > 3 ? numberArg(args[3]) : undefined;
  const condensed =
    maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth > 0 && natural > maxWidth;
  if (condensed) {
    attrs.textLength = numberText(maxWidth);
    attrs.lengthAdjust = "spacingAndGlyphs";
  }
  const shown = condensed ? maxWidth : natural;
  const bounds = textBounds(text, x, y, font, state.props.textAlign, state.props.direction, shown);
  const span = boundsUnder(bounds, state.matrix());

  const paint = stroke ? state.props.strokeStyle : state.props.fillStyle;
  let value: string | null = null;
  let clip: string | null = null;
  if (paint instanceof PatternRecord) {
    const painted = patternPaint(state, paint, span);
    if (painted) {
      value = painted.paint;
      clip = painted.clip;
    }
  } else if (paint instanceof GradientRecord && paint.kind === "conic") {
    value = colorAt(paint, 0.5);
  } else {
    value = paintValue(state, paint);
  }
  if (!value) return;
  attrs[stroke ? "stroke" : "fill"] = value;
  if (clip) attrs["clip-path"] = clip;
  if (stroke) {
    const width = Number(state.props.lineWidth);
    if (!Number.isFinite(width) || width <= 0) return;
    // SVG fills text black by default; Canvas strokes it only.
    attrs.fill = "none";
    attrs["stroke-width"] = numberText(width);
    attrs["stroke-linecap"] = stringProp(state.props, "lineCap", "butt");
    attrs["stroke-linejoin"] = stringProp(state.props, "lineJoin", "miter");
    attrs["stroke-miterlimit"] = numberText(Number(state.props.miterLimit) || 10);
    if (state.dash.length) {
      attrs["stroke-dasharray"] = state.dash.map(numberText).join(" ");
      attrs["stroke-dashoffset"] = numberText(Number(state.props.lineDashOffset) || 0);
    }
  }

  const node = element("text", attrs);
  node.text = text;
  state.place(node, span);
}

/** The paint server a paint names, or `null` if it has none (a conic). */
export function paintValue(state: SvgPaintState, paint: unknown): string | null {
  if (typeof paint === "string") return paint;
  if (paint instanceof GradientRecord) return gradientFor(state.defs, paint, identity());
  return null;
}

/**
 * A pattern as an SVG paint server (for strokes and text), and the clip that
 * keeps a non-repeating axis to its one tile: an SVG pattern always repeats,
 * so the element is clipped to the origin cell instead. The clip is in the
 * element's own user space, where its transform maps it with the geometry.
 */
export function patternPaint(
  state: SvgPaintState,
  pattern: PatternRecord,
  bounds: SvgBounds,
): { paint: string; clip: string | null } | null {
  const tile = patternTile(pattern);
  if (!tile) return null;
  const combined = pattern.transform ? multiply(state.matrix(), pattern.transform) : state.matrix();
  const inverse = invert(combined);
  if (!inverse) return null;
  // How far the drawing reaches from the tile's origin, in pattern space:
  // a repeat mode that does not repeat an axis must cover it in one tile.
  const corners = cornersOf(bounds, inverse);
  const cover = {
    width: Math.max(0, ...corners.map((corner) => corner.x)),
    height: Math.max(0, ...corners.map((corner) => corner.y)),
  };
  const paint = patternFor(
    state.defs,
    tile,
    pattern.transform ?? identity(),
    (current) => state.tileContent(current, identity()),
    cover,
  );
  if (!paint) return null;

  const repeat = tile.repeat || "repeat";
  const repeatX = repeat !== "repeat-y" && repeat !== "no-repeat";
  const repeatY = repeat !== "repeat-x" && repeat !== "no-repeat";
  let clip: string | null = null;
  if (!repeatX || !repeatY) {
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const cell = {
      minX: repeatX ? Math.min(...xs) : 0,
      maxX: repeatX ? Math.max(...xs) : tile.width,
      minY: repeatY ? Math.min(...ys) : 0,
      maxY: repeatY ? Math.max(...ys) : tile.height,
    };
    const local = invert(pattern.transform ?? identity());
    if (local) {
      const point = (x: number, y: number): { x: number; y: number } =>
        applyMatrix(local, { x, y });
      const commands: PathCommand[] = [
        { kind: "M", points: [point(cell.minX, cell.minY)] },
        { kind: "L", points: [point(cell.maxX, cell.minY)] },
        { kind: "L", points: [point(cell.maxX, cell.maxY)] },
        { kind: "L", points: [point(cell.minX, cell.maxY)] },
        { kind: "Z", points: [] },
      ];
      clip = clipFor(state.defs, commands, identity());
    }
  }
  return { paint, clip };
}

/** A stroke's extent: its path's bounds grown by the join and cap tips. */
function strokeBounds(
  state: SvgPaintState,
  commands: PathCommand[],
  width: number,
): SvgBounds | null {
  // The commands are baked in canvas space, while the stroke width, joins and
  // caps are measured in the paint-time user space: grow the path's bounds
  // there, then map them back, so a scaled CTM also scales the pad.
  const inverse = invert(state.matrix());
  if (!inverse) return null;
  const bounds = pathBounds(commands, inverse);
  if (!bounds) return null;
  const half = width / 2;
  const join = stringProp(state.props, "lineJoin", "miter");
  const cap = stringProp(state.props, "lineCap", "butt");
  // A miter tip reaches up to miterLimit / 2 widths from the vertex; a
  // square cap's corner is half a width along the path and across it.
  const miter = join === "miter" ? Math.max(1, Number(state.props.miterLimit) || 10) : 1;
  const pad = half * Math.max(miter, cap === "square" ? Math.SQRT2 : 1);
  return boundsUnder(
    {
      x: bounds.minX - pad,
      y: bounds.minY - pad,
      width: bounds.maxX - bounds.minX + pad * 2,
      height: bounds.maxY - bounds.minY + pad * 2,
    },
    state.matrix(),
  );
}

function cornersOf(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  matrix: Matrix,
): { x: number; y: number }[] {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ].map((point) => ({
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }));
}
