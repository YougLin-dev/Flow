/**
 * Every pulled connector preview in one native-canvas layer, drawn dashed.
 * A group drag pulls one line per selected card; keeping them in one canvas
 * follows the same rule as the committed connectors, so the cost stays one
 * view however large the selection is.
 */
import { Canvas, type CanvasRenderingContext2D, colorScheme, token } from "nsh";
import {
  type BoxGeometry,
  connectionBounds,
  connectorControls,
  EDGE_DASH,
  EDGE_PADDING,
  EDGE_THICKNESS,
  mergeBounds,
} from "../flow/connection";
import type { ConnectionPreview } from "../flow/scene";

export interface FlowPreviewsProps {
  readonly previews: () => readonly ConnectionPreview[];
  readonly zIndex: number;
}

export function FlowPreviews(props: FlowPreviewsProps) {
  const box = (): BoxGeometry | null => {
    let union: BoxGeometry | null = null;
    for (const preview of props.previews()) {
      const bounds = connectionBounds(preview.from, preview.to);
      union = union === null ? bounds : mergeBounds(union, bounds);
    }
    return union;
  };
  const left = () => (box()?.x ?? 0) - EDGE_PADDING;
  const top = () => (box()?.y ?? 0) - EDGE_PADDING;
  const width = () => (box()?.width ?? 0) + EDGE_PADDING * 2;
  const height = () => (box()?.height ?? 0) + EDGE_PADDING * 2;

  const draw = (cx: CanvasRenderingContext2D): void => {
    const previews = props.previews();
    if (previews.length === 0) return;
    const origin = { x: left(), y: top() };
    // A theme switch repaints the preview in the new accent.
    colorScheme();
    cx.strokeStyle = token("chart-1");
    cx.lineWidth = EDGE_THICKNESS;
    cx.lineCap = "round";
    cx.setLineDash(EDGE_DASH);
    for (const { from, to } of previews) {
      const { c1, c2 } = connectorControls(from, to);
      cx.beginPath();
      cx.moveTo(from.x - origin.x, from.y - origin.y);
      cx.bezierCurveTo(
        c1.x - origin.x,
        c1.y - origin.y,
        c2.x - origin.x,
        c2.y - origin.y,
        to.x - origin.x,
        to.y - origin.y,
      );
      cx.stroke();
    }
  };

  return (
    <Canvas
      style={{
        position: "absolute",
        left: left(),
        top: top(),
        width: width(),
        height: height(),
        zIndex: props.zIndex,
        pointerEvents: "none",
      }}
      draw={draw}
    />
  );
}
