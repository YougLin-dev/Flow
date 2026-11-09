/**
 * A connector on the native canvas, in sampled straight segments. Geometry
 * is in world-space points, so the line scales with the camera.
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

const THICKNESS = 1.5;
const STEPS = 16;

/** The connector's samples, in world coordinates. */
export function edgeSegments(from: Point | null, to: Point | null): Segment[] {
  if (!from || !to) return [];
  const points = connectionPoints(from, to, STEPS);
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
      length: Math.hypot(dx, dy),
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
              transform: [{ rotate: `${segment().angle}deg` }],
              transformOrigin: "0 50%",
              opacity: 0.9,
            }}
          />
        )}
      </Each>
      <If when={props.to()}>
        {(to) => (
          <View
            classList={{ absolute: true, [tone()]: true }}
            style={{
              position: "absolute",
              left: to().x - 11,
              top: to().y - 5.75,
              width: 12.6,
              height: THICKNESS,
              transform: [{ rotate: "22.62deg" }],
              transformOrigin: "0 50%",
              opacity: 0.9,
            }}
          />
        )}
      </If>
      <If when={props.to()}>
        {(to) => (
          <View
            classList={{ absolute: true, [tone()]: true }}
            style={{
              position: "absolute",
              left: to().x - 11,
              top: to().y + 4.25,
              width: 12.6,
              height: THICKNESS,
              transform: [{ rotate: "-22.62deg" }],
              transformOrigin: "0 50%",
              opacity: 0.9,
            }}
          />
        )}
      </If>
    </View>
  );
}
