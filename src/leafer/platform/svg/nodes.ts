/**
 * A tiny SVG document tree for snapshots that must be rasterized.
 *
 * Only what the serializer needs: elements with attributes and children, text
 * content, and XML escaping. Coordinates are written as finite numbers with a
 * bounded precision, so a generated document stays compact and deterministic.
 */
import type { Matrix } from "../geometry";

export interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  children: SvgElement[];
  text?: string;
}

export function element(
  tag: string,
  attrs: Record<string, string> = {},
  children: SvgElement[] = [],
): SvgElement {
  return { tag, attrs, children };
}

/** `matrix(a b c d e f)`, or `null` for a non-finite matrix. */
export function matrixTransform(m: Matrix): string | null {
  const values = [m.a, m.b, m.c, m.d, m.e, m.f];
  if (!values.every((value) => Number.isFinite(value))) return null;
  return `matrix(${values.map(numberText).join(" ")})`;
}

/** A number as SVG text: finite, at most three decimals, no `-0`. */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function escapeXml(value: string): string {
  return xmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** `value` with characters XML 1.0 cannot hold replaced by U+FFFD. */
function xmlText(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const valid =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    safe += valid ? character : "�";
  }
  return safe;
}

export function serializeSvg(root: SvgElement): string {
  const out: string[] = [];
  write(root, out);
  return out.join("");
}

function write(node: SvgElement, out: string[]): void {
  out.push("<", node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    out.push(" ", name, '="', escapeXml(value), '"');
  }
  if (node.text === undefined && node.children.length === 0) {
    out.push("/>");
    return;
  }
  out.push(">");
  if (node.text !== undefined) out.push(escapeXml(node.text));
  for (const child of node.children) write(child, out);
  out.push("</", node.tag, ">");
}
