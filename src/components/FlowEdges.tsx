/**
 * All connectors in one native-canvas layer: each cubic is stroked natively,
 * so every line is smooth and stays sharp at every camera scale, and the
 * whole viewport costs one canvas rather than a view per sampled segment.
 */
import {
  Animated,
  type Accessor,
  type AnimatedNode,
  Canvas,
  type CanvasRenderingContext2D,
  cleanup,
  colorScheme,
  computed,
  createAnimatedValue,
  Easing,
  effect,
  reduceMotion,
  token,
} from "nsh";
import type { EdgeSummary } from "@flow/native";
import { type Point, connectorControls, EDGE_THICKNESS, splitConnector } from "../flow/connection";
import { connectorLayerBox } from "../flow/edge-layer";
import {
  cometRuns,
  cometShown,
  edgeFlows,
  FLOW_CYCLE_MS,
  FLOW_REST_ALPHA,
  FLOW_SEGMENTS,
  FLOW_STEPS,
  flowingEdgeCount,
  flowPass,
} from "../flow/edge-flow";
import type { FlowScene } from "../flow/scene";

/** A flowing connector's line: thicker than the rest, so the selected
 * cards' connectors stand out where its wave travels. */
const FLOW_THICKNESS = EDGE_THICKNESS + 1;

/** Above this many flowing connectors, card gestures, camera movement or a
 * following card/frame plus draws the resting highlight only: every input or
 * settle change re-records this canvas, and the comet's many short strokes
 * would dominate that record. Its native phase continues meanwhile. */
const GESTURE_FLOW_EDGES = 4;

/** A connector's resolved ports, shared by its baseline and comet strokes. */
interface DrawableEdge {
  readonly edge: EdgeSummary;
  readonly ports: { from: Point; to: Point };
}

export interface FlowEdgesProps {
  readonly scene: FlowScene;
  /** True while the camera moves/settles or a card/frame plus follows the pointer. */
  readonly paused: Accessor<boolean>;
}

export function FlowEdges(props: FlowEdgesProps) {
  const flowingCount = computed(() =>
    flowingEdgeCount(props.scene.edges(), new Set(props.scene.selection())),
  );
  // A native stepped phase keeps JS out of the animation. frameRate is a cap
  // on capable platforms, not a fixed timer rate; Windows may tick at display
  // rate, while canvas slots that do not change skip re-recording.
  const wave = createAnimatedValue(1);
  const loop = Animated.loop(
    Animated.timing(wave, {
      toValue: -1,
      duration: FLOW_CYCLE_MS,
      easing: Easing.steps(FLOW_STEPS),
      frameRate: 30,
    }),
    { resetBeforeIteration: true },
  );
  let running = false;
  const stopWave = (): void => {
    if (running) loop.stop();
    running = false;
    wave.set(1);
  };
  cleanup(stopWave);
  effect(() => {
    if (cometRuns(flowingCount(), reduceMotion())) {
      if (running) return;
      running = true;
      wave.set(1);
      void loop.start();
      return;
    }
    stopWave();
  });

  // One alpha timeline per piece, shared by every connector: every curve is
  // split into the same number of pieces, so the comet is one value driving
  // a handful of small pieces instead of a stroke of the whole curve. The
  // nodes are made once, so a redraw only draws with them.
  const alphas: readonly AnimatedNode[] = Array.from({ length: FLOW_SEGMENTS }, (_, index) =>
    wave.interpolate(flowPass(index)),
  );

  const box = connectorLayerBox(props.scene);
  const left = () => box()?.x ?? 0;
  const top = () => box()?.y ?? 0;
  const width = () => box()?.width ?? 0;
  const height = () => box()?.height ?? 0;

  const draw = (cx: CanvasRenderingContext2D): void => {
    const edges = props.scene.edges();
    const drawable: DrawableEdge[] = [];
    for (const edge of edges) {
      const ports = props.scene.edgePorts(edge);
      if (ports) drawable.push({ edge, ports });
    }
    if (drawable.length === 0) return;
    const current = box();
    if (current === null) return;
    const origin = { x: current.x, y: current.y };
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
    const paused = props.paused();
    cx.lineCap = "round";
    for (const { edge, ports } of drawable) {
      const { from, to } = ports;
      const { c1, c2 } = connectorControls(from, to);
      // A selected card's connectors rest brighter and thicker than the
      // rest, under their wave; a connector that is itself selected keeps
      // its accent.
      const flows = edgeFlows(edge, flowing);
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
    if (
      !cometShown({
        flowing: flowingCount(),
        reducedMotion: reduceMotion(),
        dragging: props.scene.overrides().size > 0,
        paused,
        limit: GESTURE_FLOW_EDGES,
      })
    )
      return;
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
    for (const { edge, ports } of drawable) {
      if (!edgeFlows(edge, flowing)) continue;
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
