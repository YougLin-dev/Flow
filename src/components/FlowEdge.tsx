/**
 * A connector on the native canvas, drawn as densely sampled, overlapping
 * straight segments with rounded caps. Geometry is in world-space points, so
 * the line scales with the camera.
 */
import { View } from "nsh";
import { connectionPoints, type Point } from "../flow/connection";

export interface FlowEdgeProps {
  readonly from: () => Point | null;
  readonly to: () => Point | null;
  readonly selected: () => boolean;
  /** Above the cards, for the connection preview. */
  readonly zIndex?: number;
}

interface Segment {
  readonly x: number;
  readonly y: number;
  readonly length: number;
  readonly angle: number;
}

const THICKNESS = 2;
/** World points one segment spans; shorter segments read as a smooth curve. */
const STEP_LENGTH = 10;
const MIN_STEPS = 16;
const MAX_STEPS = 64;
/** Each segment reaches past its joint, so antialiased ends cannot leave gaps. */
const OVERLAP = 0.75;

/** The connector's samples, in world coordinates. */
export function edgeSegments(from: Point | null, to: Point | null): Segment[] {
  if (!from || !to) return [];
  const rough = connectionPoints(from, to, MIN_STEPS);
  let length = 0;
  for (let index = 0; index + 1 < rough.length; index += 1) {
    const a = rough[index];
    const b = rough[index + 1];
    if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const steps = Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.ceil(length / STEP_LENGTH)));
  const points = connectionPoints(from, to, steps);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    segments.push({
      x: a.x,
      y: a.y - THICKNESS / 2,
      length: Math.hypot(dx, dy) + OVERLAP,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return segments;
}

export function FlowEdge(props: FlowEdgeProps) {
  const tone = () => (props.selected() ? "bg-chart-1" : "bg-muted-foreground");
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: props.zIndex ?? 0,
      }}
    >
      <Each of={edgeSegments(props.from(), props.to())} key="index">
        {(segment) => (
          <View
            classList={{ absolute: true, [tone()]: true }}
            style={{
              position: "absolute",
              left: segment().x,
              top: segment().y,
              width: segment().length,
              height: THICKNESS,
              borderRadius: THICKNESS / 2,
              transform: [{ rotate: `${segment().angle}deg` }],
              transformOrigin: "0 50%",
            }}
          />
        )}
      </Each>
    </View>
  );
}
