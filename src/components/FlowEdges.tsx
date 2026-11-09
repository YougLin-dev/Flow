/**
 * All connectors in one native-canvas layer: each cubic is stroked natively,
 * so every line is smooth and stays sharp at every camera scale, and the
 * whole viewport costs one canvas rather than a view per sampled segment.
 */
import { Canvas, type CanvasRenderingContext2D, colorScheme, token } from "nsh";
import type { EdgeSummary } from "@flow/native";
import {
  type BoxGeometry,
  connectionBounds,
  connectorControls,
  EDGE_PADDING,
  EDGE_THICKNESS,
  mergeBounds,
} from "../flow/connection";
import type { FlowScene } from "../flow/scene";

export interface FlowEdgesProps {
  readonly scene: FlowScene;
}

export function FlowEdges(props: FlowEdgesProps) {
  const box = (): BoxGeometry | null => {
    let union: BoxGeometry | null = null;
    for (const edge of props.scene.edges()) {
      const bounds = edgeBox(props.scene, edge);
      if (bounds !== null) union = union === null ? bounds : mergeBounds(union, bounds);
    }
    return union;
  };
  const left = () => (box()?.x ?? 0) - EDGE_PADDING;
  const top = () => (box()?.y ?? 0) - EDGE_PADDING;
  const width = () => (box()?.width ?? 0) + EDGE_PADDING * 2;
  const height = () => (box()?.height ?? 0) + EDGE_PADDING * 2;

  const draw = (cx: CanvasRenderingContext2D): void => {
    const edges = props.scene.edges();
    if (edges.length === 0) return;
    const origin = { x: left(), y: top() };
    // Read the scheme so a theme switch redraws every connector's color.
    colorScheme();
    const normal = token("muted-foreground");
    const accent = token("chart-1");
    const selected = props.scene.selectedEdge();
    cx.lineWidth = EDGE_THICKNESS;
    cx.lineCap = "round";
    for (const edge of edges) {
      const ports = props.scene.edgePorts(edge);
      if (!ports) continue;
      const { from, to } = ports;
      const { c1, c2 } = connectorControls(from, to);
      cx.strokeStyle = edge.id === selected ? accent : normal;
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
        pointerEvents: "none",
      }}
      draw={draw}
    />
  );
}

/** The world box one connector's cubic covers, or null when it has no ends. */
function edgeBox(scene: FlowScene, edge: EdgeSummary): BoxGeometry | null {
  const ports = scene.edgePorts(edge);
  return ports ? connectionBounds(ports.from, ports.to) : null;
}
