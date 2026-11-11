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
import {
  type BoxGeometry,
  type Point,
  connectorControls,
  cubicBounds,
  EDGE_THICKNESS,
  overlaps,
  splitConnector,
} from "../flow/connection";
import { cubicInView, cubicInsideView, visibleCubicRuns } from "../flow/edge-clip";
import { connectorLayerBox, sameBox, trimConnectorBox } from "../flow/edge-layer";
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

/** A stroke's width, in world points; the cull and clip margins keep it. */
const STROKE_MARGIN = FLOW_THICKNESS;

/** A connector's resolved geometry, shared by its baseline and comet strokes. */
interface DrawableEdge {
  readonly edge: EdgeSummary;
  readonly ports: { from: Point; to: Point };
  readonly controls: { c1: Point; c2: Point };
  /** Visible polyline runs; null when the whole cubic can be stroked. */
  readonly runs: readonly (readonly Point[])[] | null;
}

export interface FlowEdgesProps {
  readonly scene: FlowScene;
  /** True while the camera moves/settles or a card/frame plus follows the pointer. */
  readonly paused: Accessor<boolean>;
  /** The world rectangle the camera shows; null until it has a size. */
  readonly visible: Accessor<BoxGeometry | null>;
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

  // One memo per scene change serves the canvas box and both clipping paths;
  // creating it per camera tick would walk every connector for nothing.
  const layer = connectorLayerBox(props.scene);
  const measured = computed(() => props.visible() !== null);
  // Clipping is needed only while part of the connector layer leaves the
  // view. Inside the content the value stays null, so panning and zooming
  // there do not re-record the whole canvas.
  const clipView = computed(
    () => {
      const view = props.visible();
      const box = layer();
      if (view === null || box === null) return null;
      const inside =
        box.x >= view.x &&
        box.y >= view.y &&
        box.x + box.width <= view.x + view.width &&
        box.y + box.height <= view.y + view.height;
      return inside ? null : view;
    },
    { equals: sameBox },
  );
  const box = computed(() => trimConnectorBox(layer(), clipView()), { equals: sameBox });
  const left = () => box()?.x ?? 0;
  const top = () => box()?.y ?? 0;
  const width = () => box()?.width ?? 0;
  const height = () => box()?.height ?? 0;

  const draw = (cx: CanvasRenderingContext2D): void => {
    // Nothing can be clipped correctly before layout; the first measured
    // frame records, rather than a document-sized canvas recording now.
    if (!measured()) return;
    const view = clipView();
    const edges = props.scene.edges();
    const drawable: DrawableEdge[] = [];
    for (const edge of edges) {
      const ports = props.scene.edgePorts(edge);
      if (ports === null) continue;
      const controls = connectorControls(ports.from, ports.to);
      if (
        view === null ||
        cubicInsideView(ports.from, controls.c1, controls.c2, ports.to, view, STROKE_MARGIN)
      ) {
        drawable.push({ edge, ports, controls, runs: null });
        continue;
      }
      // A connector whose whole cubic is off screen is not stroked; one that
      // crosses it is stroked only where it can be seen.
      const bounds = cubicBounds(ports.from, controls.c1, controls.c2, ports.to);
      if (!overlaps(bounds, view, STROKE_MARGIN)) continue;
      const runs = visibleCubicRuns(
        ports.from,
        controls.c1,
        controls.c2,
        ports.to,
        view,
        STROKE_MARGIN,
      );
      if (runs.length === 0) continue;
      drawable.push({ edge, ports, controls, runs });
    }
    if (drawable.length === 0) return;
    const current = box();
    if (current === null) return;
    const origin = { x: current.x, y: current.y };
    const traceCubic = (from: Point, c1: Point, c2: Point, to: Point): void => {
      cx.moveTo(from.x - origin.x, from.y - origin.y);
      cx.bezierCurveTo(
        c1.x - origin.x,
        c1.y - origin.y,
        c2.x - origin.x,
        c2.y - origin.y,
        to.x - origin.x,
        to.y - origin.y,
      );
    };
    const traceRuns = (runs: readonly (readonly Point[])[]): void => {
      for (const run of runs) {
        const first = run[0];
        if (first === undefined) continue;
        cx.moveTo(first.x - origin.x, first.y - origin.y);
        for (let i = 1; i < run.length; i += 1) {
          const point = run[i];
          if (point !== undefined) cx.lineTo(point.x - origin.x, point.y - origin.y);
        }
      }
    };
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
    for (const { edge, ports, controls, runs } of drawable) {
      const { from, to } = ports;
      // A selected card's connectors rest brighter and thicker than the
      // rest, under their wave; a connector that is itself selected keeps
      // its accent.
      const flows = edgeFlows(edge, flowing);
      const highlighted = edge.id !== selected && flows;
      cx.strokeStyle = edge.id === selected ? accent : normal;
      cx.lineWidth = EDGE_THICKNESS;
      cx.globalAlpha = 1;
      cx.beginPath();
      if (runs === null) traceCubic(from, controls.c1, controls.c2, to);
      else traceRuns(runs);
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
        let runs: readonly (readonly Point[])[] | null = null;
        if (view !== null) {
          // A piece wholly outside cannot show; one that crosses the view
          // is stroked only where it can be seen, like the baseline.
          if (!cubicInView(piece.from, piece.c1, piece.c2, piece.to, view, STROKE_MARGIN)) continue;
          if (!cubicInsideView(piece.from, piece.c1, piece.c2, piece.to, view, STROKE_MARGIN)) {
            runs = visibleCubicRuns(piece.from, piece.c1, piece.c2, piece.to, view, STROKE_MARGIN);
            if (runs.length === 0) continue;
          }
        }
        cx.globalAlpha = alphas[i];
        cx.beginPath();
        if (runs === null) traceCubic(piece.from, piece.c1, piece.c2, piece.to);
        else traceRuns(runs);
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
