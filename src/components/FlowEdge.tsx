/**
 * One connector drawn as a single native-canvas cubic. The canvas strokes
 * the curve natively, so the line is smooth and stays sharp at every camera
 * scale; geometry is in world-space points.
 */
import { Canvas, type CanvasRenderingContext2D, colorScheme, token } from "nsh";
import {
  type BoxGeometry,
  connectionBounds,
  connectorControls,
  EDGE_PADDING,
  EDGE_THICKNESS,
  type Point,
} from "../flow/connection";

/** The dashes of a not-yet-connected preview, in world points. */
const DASH = [7, 5];

export interface FlowEdgeProps {
  readonly from: () => Point | null;
  readonly to: () => Point | null;
  readonly selected: () => boolean;
  /** A connection being pulled, before it is written: drawn dashed. */
  readonly dashed?: boolean;
  /** Above the cards, for the connection preview. */
  readonly zIndex?: number;
}

export function FlowEdge(props: FlowEdgeProps) {
  const box = (): BoxGeometry | null => {
    const from = props.from();
    const to = props.to();
    return from && to ? connectionBounds(from, to) : null;
  };
  const left = () => (box()?.x ?? 0) - EDGE_PADDING;
  const top = () => (box()?.y ?? 0) - EDGE_PADDING;
  const width = () => (box()?.width ?? 0) + EDGE_PADDING * 2;
  const height = () => (box()?.height ?? 0) + EDGE_PADDING * 2;

  const draw = (cx: CanvasRenderingContext2D): void => {
    const from = props.from();
    const to = props.to();
    if (!from || !to) return;
    const origin = { x: left(), y: top() };
    // Read the scheme so a theme switch redraws the connector's color.
    colorScheme();
    const { c1, c2 } = connectorControls(from, to);
    cx.strokeStyle = token(props.selected() ? "chart-1" : "muted-foreground");
    cx.lineWidth = EDGE_THICKNESS;
    cx.lineCap = "round";
    if (props.dashed === true) cx.setLineDash(DASH);
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
  };

  return (
    <Canvas
      style={{
        position: "absolute",
        left: left(),
        top: top(),
        width: width(),
        height: height(),
        zIndex: props.zIndex ?? 0,
        pointerEvents: "none",
      }}
      draw={draw}
    />
  );
}
