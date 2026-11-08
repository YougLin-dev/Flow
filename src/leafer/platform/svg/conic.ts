/**
 * SVG has no conic gradient. A canvas snapshot that conic-fills a shape is
 * drawn as narrow solid wedges clipped to it; with 90 wedges the color steps
 * are finer than the raster's pixels at ordinary sizes.
 */
import { TAU } from "../geometry";
import type { GradientRecord } from "../paint";
import { element, numberText, type SvgElement } from "./nodes";
import type { Rect } from "./defs";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The wedges of a conic gradient in its own (paint-time user) space. */
export function conicWedges(paint: GradientRecord, bounds: Rect): SvgElement[] {
  const start = paint.args[0] ?? 0;
  const cx = paint.args[1] ?? 0;
  const cy = paint.args[2] ?? 0;
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  const radius = Math.max(...corners.map((corner) => Math.hypot(corner.x - cx, corner.y - cy))) + 2;
  const wedges: SvgElement[] = [];
  const steps = 90;
  const step = TAU / steps;
  const overlap = step * 0.02;
  for (let i = 0; i < steps; i++) {
    const color = colorAt(paint, (i + 0.5) / steps);
    if (!color) continue;
    const a0 = start + i * step - overlap;
    const a1 = start + (i + 1) * step + overlap;
    const p0 = { x: cx + radius * Math.cos(a0), y: cy + radius * Math.sin(a0) };
    const p1 = { x: cx + radius * Math.cos(a1), y: cy + radius * Math.sin(a1) };
    wedges.push(
      element("path", {
        d: `M ${numberText(cx)} ${numberText(cy)} L ${numberText(p0.x)} ${numberText(p0.y)} L ${numberText(p1.x)} ${numberText(p1.y)} Z`,
        fill: color,
      }),
    );
  }
  return wedges;
}

/** The color a conic gradient shows at `t` (0..1). */
export function colorAt(paint: GradientRecord, t: number): string | null {
  const stops = paint.stops.toSorted((a, b) => a.offset - b.offset);
  if (!stops.length) return null;
  const wrapped = ((t % 1) + 1) % 1;
  let before = stops[0];
  let after = stops[stops.length - 1];
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].offset <= wrapped) before = stops[i];
    if (stops[i].offset >= wrapped) {
      after = stops[i];
      break;
    }
  }
  const span = after.offset - before.offset;
  if (span <= 0) return after.color;
  const mix = (wrapped - before.offset) / span;
  const a = parseColor(before.color);
  const b = parseColor(after.color);
  if (!a || !b) return (mix < 0.5 ? before : after).color;
  return `rgba(${Math.round(a.r + (b.r - a.r) * mix)}, ${Math.round(
    a.g + (b.g - a.g) * mix,
  )}, ${Math.round(a.b + (b.b - a.b) * mix)}, ${numberText(a.a + (b.a - a.a) * mix)})`;
}

/** A color as channels, or `null` for a syntax this module does not read. */
export function parseColor(color: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const r = digits[0];
      const g = digits[1];
      const b = digits[2];
      const a = digits.length === 4 ? digits[3] : "f";
      return {
        r: Number.parseInt(r + r, 16),
        g: Number.parseInt(g + g, 16),
        b: Number.parseInt(b + b, 16),
        a: Number.parseInt(a + a, 16) / 255,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1,
      };
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
    color,
  );
  if (!rgb) return null;
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}
