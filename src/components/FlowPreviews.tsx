/**
 * Every pulled connector preview in one native-canvas layer, drawn dashed.
 * A group drag pulls one line per selected card; keeping them in one canvas
 * follows the same rule as the committed connectors, so the cost stays one
 * view however large the selection is.
 */
import { type CanvasRenderingContext2D, colorScheme, computed } from "nsh";
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
import type { Point } from "../flow/shared";
import { ConnectorCanvas, connectorColor } from "./canvas";

export interface FlowPreviewsProps {
  readonly previews: () => readonly ConnectionPreview[];
  readonly zIndex: number;
}

export function FlowPreviews(props: FlowPreviewsProps) {
  // One union box per preview change serves the canvas' four style values
  // and its draw; rebuilding it per accessor made every pointer move walk
  // the preview list six times.
  const box = computed((): BoxGeometry | null => {
    let union: BoxGeometry | null = null;
    for (const preview of props.previews()) {
      const bounds = connectionBounds(preview.from, preview.to);
      union = union === null ? bounds : mergeBounds(union, bounds);
    }
    return union;
  });

  const draw = (cx: CanvasRenderingContext2D, origin: Point | null): void => {
    const previews = props.previews();
    if (previews.length === 0 || origin === null) return;
    // A theme switch repaints the previews in the new port colors.
    colorScheme();
    cx.lineWidth = EDGE_THICKNESS;
    cx.lineCap = "round";
    cx.setLineDash(EDGE_DASH);
    for (const { from, to, portKind } of previews) {
      cx.strokeStyle = connectorColor(portKind);
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

  return <ConnectorCanvas box={box} padding={EDGE_PADDING} zIndex={props.zIndex} draw={draw} />;
}
