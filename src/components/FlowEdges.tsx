/**
 * All connectors in one native-canvas layer: each cubic is stroked natively,
 * so every line is smooth and stays sharp at every camera scale, and the
 * whole viewport costs one canvas rather than a view per sampled segment.
 * A connector rests faint in its port type's color; the clicked one is
 * thicker and fully lit.
 */
import {
  type Accessor,
  Canvas,
  type CanvasRenderingContext2D,
  colorScheme,
  computed,
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
} from "../flow/connection";
import { cubicInsideView, visibleCubicRuns } from "../flow/edge-clip";
import { connectorLayerBox, sameBox, trimConnectorBox } from "../flow/edge-layer";
import { isPortKind } from "../flow/node-kinds";
import { portVisual } from "../flow/port-visuals";
import type { FlowScene } from "../flow/scene";

/** The selected connector's stroke: one point thicker than the rest, so a
 * lit line reads as bold. */
const SELECTED_THICKNESS = EDGE_THICKNESS + 1;
/** Resting connectors are dimmed to this share of their type's color, so a
 * clicked one stands out. */
const REST_ALPHA = 0.35;
/** A stroke's width, in world points; the cull and clip margins keep it. */
const STROKE_MARGIN = SELECTED_THICKNESS;

/** A connector's resolved geometry. */
interface DrawableEdge {
  readonly edge: EdgeSummary;
  readonly ports: { from: Point; to: Point };
  readonly controls: { c1: Point; c2: Point };
  /** Visible polyline runs; null when the whole cubic can be stroked. */
  readonly runs: readonly (readonly Point[])[] | null;
}

export interface FlowEdgesProps {
  readonly scene: FlowScene;
  /** The world rectangle the camera shows; null until it has a size. */
  readonly visible: Accessor<BoxGeometry | null>;
  /** The cards a marquee currently covers: their connectors light at once. */
  readonly previewed: Accessor<ReadonlySet<string>>;
}

export function FlowEdges(props: FlowEdgesProps) {
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
  // The selection as one set, reused by every draw until it changes; a drag
  // re-records the canvas on each move and must not rebuild this per frame.
  const selectedCards = computed(() => new Set(props.scene.selection()));
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
    // Read the scheme so a theme switch redraws every connector's color, and
    // the selection so selecting cards or clicking a connector relights it.
    // A marquee's covered cards count as selected while it sweeps.
    colorScheme();
    const selected = props.scene.selectedEdge();
    const touching = selectedCards();
    const previewing = props.previewed();
    cx.lineCap = "round";
    for (const { edge, ports, controls, runs } of drawable) {
      const { from, to } = ports;
      // A connector takes its port type's color: the clicked edge and every
      // connector touching a selected or marquee-covered card are thicker and
      // fully lit, the rest rest faint.
      const lit =
        edge.id === selected ||
        touching.has(edge.fromId) ||
        touching.has(edge.toId) ||
        previewing.has(edge.fromId) ||
        previewing.has(edge.toId);
      cx.strokeStyle = portColor(edge.portKind);
      cx.lineWidth = lit ? SELECTED_THICKNESS : EDGE_THICKNESS;
      cx.globalAlpha = lit ? 1 : REST_ALPHA;
      cx.beginPath();
      if (runs === null) traceCubic(from, controls.c1, controls.c2, to);
      else traceRuns(runs);
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

/** The stroke color of a connector from its port type. */
function portColor(kind: string): string {
  return token(portVisual(isPortKind(kind) ? kind : "text").token);
}
