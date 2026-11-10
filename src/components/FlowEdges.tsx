/**
 * All connectors in one native-canvas layer: each cubic is stroked natively,
 * so every line is smooth and stays sharp at every camera scale, and the
 * whole viewport costs one canvas rather than a view per sampled segment.
 */
import {
  type AnimatedNode,
  Canvas,
  type CanvasRenderingContext2D,
  cleanup,
  colorScheme,
  createAnimatedValue,
  effect,
  token,
} from "nsh";
import type { EdgeSummary } from "@flow/native";
import {
  type BoxGeometry,
  connectionBounds,
  connectorControls,
  EDGE_PADDING,
  EDGE_THICKNESS,
  mergeBounds,
  splitConnector,
} from "../flow/connection";
import {
  edgeFlows,
  FLOW_REST_ALPHA,
  FLOW_SEGMENTS,
  FLOW_STEP_MS,
  flowPass,
  flowWave,
} from "../flow/edge-flow";
import type { FlowScene } from "../flow/scene";

/** A flowing connector's line: thicker than the rest, so the selected
 * cards' connectors stand out where its wave travels. */
const FLOW_THICKNESS = EDGE_THICKNESS + 1;

/** Above this many flowing connectors, a gesture that moves or resizes
 * cards draws the resting highlight only: every pointer move re-records
 * this canvas, and the comet's many short strokes would dominate that
 * record. The comet comes back when the gesture ends. */
const GESTURE_FLOW_EDGES = 4;

/** How coarse the canvas box is, in world points: fine enough that rounding
 * it outward never shows, coarse enough that moving a card does not resize
 * the canvas surface every pointer move. */
const BOX_STEP = 64;

/** `box` rounded outward to whole `BOX_STEP`s, never clipping what it holds. */
function roundOut(box: BoxGeometry): BoxGeometry {
  const x = Math.floor(box.x / BOX_STEP) * BOX_STEP;
  const y = Math.floor(box.y / BOX_STEP) * BOX_STEP;
  const right = Math.ceil((box.x + box.width) / BOX_STEP) * BOX_STEP;
  const bottom = Math.ceil((box.y + box.height) / BOX_STEP) * BOX_STEP;
  return { x, y, width: right - x, height: bottom - y };
}

export interface FlowEdgesProps {
  readonly scene: FlowScene;
}

export function FlowEdges(props: FlowEdgesProps) {
  // The wave's position, shared by every flowing connector: 1 (nothing lit),
  // 0 (the whole connector lit) and -1 (the tail left through the target).
  // A timer steps it (about 30 times a second) and the canvas reads it as an
  // animated number (`lineDashOffset`), so a step only updates the drawing's
  // values — no JS draw runs — and the canvas repaints on the steps instead
  // of on every display frame; between steps no frame is needed.
  const wave = createAnimatedValue(1);
  let step: number | null = null;
  let began = 0;
  const stopWave = (): void => {
    if (step === null) return;
    clearInterval(step);
    step = null;
  };
  cleanup(stopWave);
  effect(() => {
    if (props.scene.selection().length > 0) {
      if (step !== null) return;
      began = Date.now();
      step = setInterval(() => {
        wave.set(flowWave(Date.now() - began));
      }, FLOW_STEP_MS);
      return;
    }
    // Nothing flows: stop the wave and park it where nothing is lit.
    stopWave();
    wave.set(1);
  });

  // One alpha timeline per piece, shared by every connector: every curve is
  // split into the same number of pieces, so the comet is one value driving
  // a handful of small pieces instead of a stroke of the whole curve. The
  // nodes are made once, so a redraw only draws with them.
  const alphas: readonly AnimatedNode[] = Array.from({ length: FLOW_SEGMENTS }, (_, index) =>
    wave.interpolate(flowPass(index)),
  );

  /** The world box the canvas covers: the connectors' union with their
   * padding, rounded outward to whole steps, so a dragged card redraws the
   * connectors without resizing the canvas surface on every pointer move. */
  const box = (): BoxGeometry | null => {
    let union: BoxGeometry | null = null;
    for (const edge of props.scene.edges()) {
      const bounds = edgeBox(props.scene, edge);
      if (bounds !== null) union = union === null ? bounds : mergeBounds(union, bounds);
    }
    if (union === null) return null;
    return roundOut({
      x: union.x - EDGE_PADDING,
      y: union.y - EDGE_PADDING,
      width: union.width + EDGE_PADDING * 2,
      height: union.height + EDGE_PADDING * 2,
    });
  };
  const left = () => box()?.x ?? 0;
  const top = () => box()?.y ?? 0;
  const width = () => box()?.width ?? 0;
  const height = () => box()?.height ?? 0;

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
    let flowingEdges = 0;
    for (const edge of edges) {
      const ports = props.scene.edgePorts(edge);
      if (!ports) continue;
      const { from, to } = ports;
      const { c1, c2 } = connectorControls(from, to);
      // A selected card's connectors rest brighter and thicker than the
      // rest, under their wave; a connector that is itself selected keeps
      // its accent.
      const flows = edgeFlows(edge, flowing);
      if (flows) flowingEdges += 1;
      const highlighted = edge.id !== selected && flows;
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
    // A gesture that moves or resizes cards re-records this canvas on every
    // pointer move; with many flowing connectors the comet's strokes would
    // dominate that record, so it yields to the resting highlight until the
    // gesture ends.
    if (props.scene.overrides().size > 0 && flowingEdges > GESTURE_FLOW_EDGES) return;
    // A comet of light travels each selected card's connectors from their
    // source and leaves through their target: the curve is drawn as short
    // pieces, each lit by its own animated alpha, so the light has a
    // gradient trail behind its head. A step only changes the trail's
    // pieces, so the canvas repaints the trail, not the whole curve. Every
    // connector is stroked source to target, so the light flows into a
    // selected target and out of a selected source.
    cx.save();
    cx.strokeStyle = flowColor;
    cx.lineCap = "butt";
    cx.lineWidth = FLOW_THICKNESS;
    for (const edge of edges) {
      if (!edgeFlows(edge, flowing)) continue;
      const ports = props.scene.edgePorts(edge);
      if (!ports) continue;
      const pieces = splitConnector(ports.from, ports.to, FLOW_SEGMENTS);
      for (let i = 0; i < pieces.length; i += 1) {
        const piece = pieces[i];
        cx.globalAlpha = alphas[i];
        cx.beginPath();
        cx.moveTo(piece.from.x - origin.x, piece.from.y - origin.y);
        cx.bezierCurveTo(
          piece.c1.x - origin.x,
          piece.c1.y - origin.y,
          piece.c2.x - origin.x,
          piece.c2.y - origin.y,
          piece.to.x - origin.x,
          piece.to.y - origin.y,
        );
        cx.stroke();
      }
    }
    // The cap and the alpha go back to the base lines'.
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
