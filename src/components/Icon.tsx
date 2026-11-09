/**
 * One icon from the Lucide set, drawn natively: its SVG geometry becomes a
 * single path on a small canvas, so the stroke takes a theme token and stays
 * sharp at every size. Icons are decorative; their button carries the label.
 */
import { Canvas, colorScheme, Path2D, token } from "nsh";
import { ICON_GRID, type IconNode, iconPath } from "../flow/icon-shape";

export interface IconProps {
  /** The icon's `IconNode` export, such as Lucide's `Plus`. */
  readonly icon: IconNode;
  /** The box size in points (18 by default). */
  readonly size?: number;
  /** The stroke width on the 24-unit grid (Lucide's 2 by default). */
  readonly strokeWidth?: number;
  /** The stroke color; read while drawing, so a theme switch redraws it. */
  readonly tint?: () => string;
}

export function Icon(props: IconProps) {
  const size = (): number => props.size ?? 18;

  return (
    <Canvas
      class="shrink-0"
      style={{ width: size(), height: size(), pointerEvents: "none" }}
      draw={(cx) => {
        // Read the scheme so a theme switch redraws with the new token.
        colorScheme();
        cx.scale(size() / ICON_GRID, size() / ICON_GRID);
        cx.strokeStyle = props.tint?.() ?? token("foreground");
        cx.lineWidth = props.strokeWidth ?? 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.stroke(new Path2D(iconPath(props.icon)));
      }}
    />
  );
}
