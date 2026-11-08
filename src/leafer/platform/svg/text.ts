/**
 * Canvas text as SVG text: the font shorthand, the alignment keywords and an
 * approximate bounding box (for shadow and filter regions).
 */
import { applyMatrix, type Matrix, type Point } from "../geometry";

export interface ParsedFont {
  size: number;
  weight?: string;
  style?: string;
  families: string;
}

export interface TextBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CSS system fonts (and the platforms' UI aliases) no SVG font database has. */
const SYSTEM_FONTS = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "small-caption",
  "status-bar",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
]);

const WEIGHTS = new Set([
  "bold",
  "bolder",
  "lighter",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
]);

export function parseFont(font: string): ParsedFont {
  const match = /^(.*?)\s*([\d.]+)(px|pt|rem|em|%)\s*(?:\/\s*\S+\s*)?(.+)$/.exec(font);
  if (!match) return { size: 12, families: "sans-serif" };
  const [, prefix, sizeText, unit, families] = match;
  const value = Number(sizeText);
  const size =
    unit === "rem" || unit === "em" ? value * 16 : unit === "%" ? (value * 16) / 100 : value;
  const words = prefix.trim().split(/\s+/).filter(Boolean);
  const weight = words.find((word) => WEIGHTS.has(word.toLowerCase()));
  const style = words.find((word) => word === "italic" || word === "oblique");
  return {
    size: Number.isFinite(size) && size > 0 ? size : 12,
    ...(weight ? { weight } : {}),
    ...(style ? { style } : {}),
    families: svgFamilies(families),
  };
}

/** A font family list without the system aliases SVG cannot resolve. */
function svgFamilies(families: string): string {
  const kept = families
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family && !SYSTEM_FONTS.has(family.toLowerCase()));
  return kept.length ? kept.join(", ") : "sans-serif";
}

export function baselineOf(baseline: unknown): string {
  switch (baseline) {
    case "top":
      return "text-before-edge";
    case "middle":
      return "central";
    case "bottom":
      return "text-after-edge";
    case "hanging":
      return "hanging";
    case "ideographic":
      return "ideographic";
    default:
      return "alphabetic";
  }
}

/**
 * The physical side Canvas' `textAlign` anchors at (for the bounds): `start`
 * and `end` follow the direction, `left` and `right` do not.
 */
export function anchorOf(align: unknown, direction: unknown): string {
  if (align === "center") return "middle";
  if (align === "right") return "end";
  if (align === "left") return "start";
  if (align === "end") return direction === "rtl" ? "start" : "end";
  // start, and the default
  return direction === "rtl" ? "end" : "start";
}

/**
 * SVG's `text-anchor`, which is flow-relative: with `direction="rtl"` its
 * `start` is the right side. Canvas' `start` and `end` are flow-relative
 * too; only `left` and `right` are physical.
 */
export function svgAnchorOf(align: unknown, direction: unknown): string {
  const rtl = direction === "rtl";
  if (align === "center") return "middle";
  if (align === "left") return rtl ? "end" : "start";
  if (align === "right") return rtl ? "start" : "end";
  if (align === "end") return "end";
  // start, and the default
  return "start";
}

/** The text's box in user space, anchored at `x`, `y`. */
export function textBounds(
  text: string,
  x: number,
  y: number,
  font: ParsedFont,
  align: unknown,
  direction: unknown,
  width: number,
): TextBounds {
  const boxWidth = width > 0 ? width : text.length * font.size * 0.6;
  const anchor = anchorOf(align, direction);
  const left = anchor === "middle" ? x - boxWidth / 2 : anchor === "end" ? x - boxWidth : x;
  return { x: left, y: y - font.size, width: boxWidth, height: font.size * 1.25 };
}

/** The four corners of a user-space box through `matrix`. */
export function boxCorners(box: TextBounds, matrix: Matrix): Point[] {
  return [
    applyMatrix(matrix, { x: box.x, y: box.y }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y }),
    applyMatrix(matrix, { x: box.x + box.width, y: box.y + box.height }),
    applyMatrix(matrix, { x: box.x, y: box.y + box.height }),
  ];
}
