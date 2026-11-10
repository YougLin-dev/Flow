/**
 * All connectors in one native-canvas layer: each cubic is stroked natively,
 * so every line is smooth and stays sharp at every camera scale, and the
 * whole viewport costs one canvas rather than a view per sampled segment.
 */
import {
  Animated,
  Canvas,
  type CanvasRenderingContext2D,
  cleanup,
  colorScheme,
  type CompositeAnimation,
  createAnimatedValue,
  effect,
  Easing,
  Path2D,
  token,
} from "nsh";
import type { EdgeSummary } from "@flow/native";
import {
  type BoxGeometry,
  connectionBounds,
  connectionLength,
  connectorControls,
  EDGE_PADDING,
  EDGE_THICKNESS,
  mergeBounds,
} from "../flow/connection";
import {
  edgeFlows,
  FLOW_CYCLE_MS,
  FLOW_OVERSHOOT,
  FLOW_REST_ALPHA,
  flowLayers,
} from "../flow/edge-flow";
import type { FlowScene } from "../flow/scene";

/** A flowing connector's line: thicker than the rest, so the selected
 * cards' connectors stand out where its wave travels. */
const FLOW_THICKNESS = EDGE_THICKNESS + 1;

export interface FlowEdgesProps {
  readonly scene: FlowScene;
}

export function FlowEdges(props: FlowEdgesProps) {
  // The wave's position, shared by every flowing connector: 1 (nothing lit),
  // 0 (the whole connector lit) and -1 (the tail left through the target).
  // The canvas reads it as an animated number (`lineDashOffset`), so the
  // light travels natively and no JS runs per frame.
  const wave = createAnimatedValue(1);
  let flowAnimation: CompositeAnimation | null = null;
  cleanup(() => flowAnimation?.stop());
  effect(() => {
    if (props.scene.selection().length > 0) {
      if (flowAnimation !== null) return;
      flowAnimation = Animated.keyframes(wave, {
        keyframes: [1, 0, -1],
        duration: FLOW_CYCLE_MS,
        iterations: "infinite",
        easing: Easing.linear,
      });
      // The endless loop never settles; its promise carries nothing here.
      void flowAnimation.start();
      return;
    }
    // Nothing flows: stop the wave and park it where nothing is lit.
    flowAnimation?.stop();
    flowAnimation = null;
    wave.set(1);
  });

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
    // The wave stays in the connector's own family: a brighter shade of the
    // line rather than the selection's accent.
    const flowColor = token("flow");
    const selected = props.scene.selectedEdge();
    // Read the selection so a change redraws the flowing connectors.
    const flowing = new Set(props.scene.selection());
    cx.lineCap = "round";
    cx.setLineDash([]);
    for (const edge of edges) {
      const ports = props.scene.edgePorts(edge);
      if (!ports) continue;
      const { from, to } = ports;
      const { c1, c2 } = connectorControls(from, to);
      // A selected card's connectors rest brighter and thicker than the
      // rest, under their wave; a connector that is itself selected keeps
      // its accent.
      const highlighted = edge.id !== selected && edgeFlows(edge, flowing);
      cx.strokeStyle = edge.id === selected ? accent : normal;
      cx.lineWidth = EDGE_THICKNESS;
      cx.globalAlpha = 1;
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
      if (highlighted) {
        cx.strokeStyle = flowColor;
        cx.lineWidth = FLOW_THICKNESS;
        cx.globalAlpha = FLOW_REST_ALPHA;
        cx.stroke();
      }
    }
    if (flowing.size === 0) return;
    // A wave of light fills each selected card's connectors from their
    // source and leaves through their target. The wave is a stack of lit
    // spans that all end at its head, each fading into the next, so the
    // light has a gradient trail behind its head instead of one glowing
    // color. The head slides as the animated offset moves the dashes; every
    // connector is stroked source to target, so the wave flows into a
    // selected target and out of a selected source.
    cx.save();
    cx.strokeStyle = flowColor;
    cx.lineCap = "round";
    cx.lineWidth = FLOW_THICKNESS;
    for (const edge of edges) {
      if (!edgeFlows(edge, flowing)) continue;
      const ports = props.scene.edgePorts(edge);
      if (!ports) continue;
      const { from, to } = ports;
      const { c1, c2 } = connectorControls(from, to);
      const path = new Path2D();
      path.moveTo(from.x - origin.x, from.y - origin.y);
      path.bezierCurveTo(
        c1.x - origin.x,
        c1.y - origin.y,
        c2.x - origin.x,
        c2.y - origin.y,
        to.x - origin.x,
        to.y - origin.y,
      );
      const fill = connectionLength(from, to) + FLOW_OVERSHOOT;
      const head = Animated.multiply(wave, fill);
      for (const layer of flowLayers(fill)) {
        cx.setLineDash([layer.lit, layer.gap]);
        cx.lineDashOffset = layer.shift === 0 ? head : Animated.add(head, layer.shift);
        cx.globalAlpha = layer.alpha;
        if (layer.head) {
          cx.shadowColor = flowColor;
          cx.shadowBlur = 5;
        }
        cx.stroke(path);
        if (layer.head) cx.shadowBlur = 0;
      }
    }
    // The dash, the glow and the alpha go back to the base lines'.
    cx.restore();
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
