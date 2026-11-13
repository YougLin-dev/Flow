/**
 * SVG icon geometry as one path, from the node data an icon set exports.
 * Lucide describes each icon as `[tag, attributes]` nodes on a 24-unit grid;
 * a native canvas draws them with one `Path2D`.
 */

export type IconAttrs = Readonly<Record<string, string | number | undefined>>;

/** An icon's SVG nodes, shaped like Lucide's `IconNode`. */
export type IconNode = readonly (readonly [tag: string, attrs: IconAttrs])[];

/** The grid icon data is drawn on (both Lucide's and the icon view's). */
export const ICON_GRID = 24;

/** One SVG path holding every shape of the icon, in its view box. */
export function iconPath(node: IconNode): string {
  const parts: string[] = [];
  for (const [tag, attrs] of node) {
    let path = shapePath(tag, attrs);
    if (path === null) continue;
    // Each SVG path starts at the origin, but joined into one Path2D a part
    // opening with a relative command (Lucide's X) would continue from the
    // previous part's end instead. Reset the current point first.
    if (parts.length > 0 && startsRelative(path)) path = `M 0 0 ${path}`;
    parts.push(path);
  }
  return parts.join(" ");
}

/** Whether path data opens with a relative command (its moveto included). */
function startsRelative(path: string): boolean {
  return /^[mzlhvcsqta]/.test(path.trim());
}

function shapePath(tag: string, attrs: IconAttrs): string | null {
  switch (tag) {
    case "path": {
      const d = attrs.d;
      return typeof d === "string" && d.trim() !== "" ? d : null;
    }
    case "circle": {
      const cx = number(attrs, "cx");
      const cy = number(attrs, "cy");
      const r = number(attrs, "r");
      if (cx === null || cy === null || r === null || r <= 0) return null;
      return ellipsePath(cx, cy, r, r);
    }
    case "ellipse": {
      const cx = number(attrs, "cx");
      const cy = number(attrs, "cy");
      const rx = number(attrs, "rx");
      const ry = number(attrs, "ry");
      if (cx === null || cy === null || rx === null || ry === null || rx <= 0 || ry <= 0) {
        return null;
      }
      return ellipsePath(cx, cy, rx, ry);
    }
    case "rect": {
      const x = number(attrs, "x");
      const y = number(attrs, "y");
      const width = number(attrs, "width");
      const height = number(attrs, "height");
      if (x === null || y === null || width === null || height === null) return null;
      if (width <= 0 || height <= 0) return null;
      return rectPath(x, y, width, height, number(attrs, "rx"), number(attrs, "ry"));
    }
    case "line": {
      const x1 = number(attrs, "x1");
      const y1 = number(attrs, "y1");
      const x2 = number(attrs, "x2");
      const y2 = number(attrs, "y2");
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return `M ${format(x1)} ${format(y1)} L ${format(x2)} ${format(y2)}`;
    }
    case "polyline":
    case "polygon": {
      const points = pointList(attrs.points);
      if (points === null) return null;
      const commands = points.map(
        (point, index) => `${index === 0 ? "M" : "L"} ${format(point.x)} ${format(point.y)}`,
      );
      if (tag === "polygon") commands.push("Z");
      return commands.join(" ");
    }
    default:
      return null;
  }
}

/** A full ellipse as two half-arcs from its left point. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const left = cx - rx;
  return [
    `M ${format(left)} ${format(cy)}`,
    `a ${format(rx)} ${format(ry)} 0 1 0 ${format(rx * 2)} 0`,
    `a ${format(rx)} ${format(ry)} 0 1 0 ${format(-rx * 2)} 0`,
    "Z",
  ].join(" ");
}

/**
 * A rect path; SVG lets one radius stand for both corners, and clamps each to
 * half its side. A zero radius keeps the corners square.
 */
function rectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  rxValue: number | null,
  ryValue: number | null,
): string {
  const rx = Math.min(Math.max(rxValue ?? ryValue ?? 0, 0), width / 2);
  const ry = Math.min(Math.max(ryValue ?? rxValue ?? 0, 0), height / 2);
  const right = x + width;
  const bottom = y + height;
  if (rx === 0 || ry === 0) {
    return `M ${format(x)} ${format(y)} H ${format(right)} V ${format(bottom)} H ${format(x)} Z`;
  }
  return [
    `M ${format(x + rx)} ${format(y)}`,
    `H ${format(right - rx)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(right)} ${format(y + ry)}`,
    `V ${format(bottom - ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(right - rx)} ${format(bottom)}`,
    `H ${format(x + rx)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(x)} ${format(bottom - ry)}`,
    `V ${format(y + ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(x + rx)} ${format(y)}`,
    "Z",
  ].join(" ");
}

function pointList(value: string | number | undefined): { x: number; y: number }[] | null {
  if (typeof value !== "string") return null;
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length < 4 || values.length % 2 !== 0) return null;
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    points.push({ x, y });
  }
  return points;
}

function number(attrs: IconAttrs, name: string): number | null {
  const value = attrs[name];
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** A number as compact path data, without float noise. */
function format(value: number): string {
  return `${Math.round(value * 1000) / 1000}`;
}
