import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import {
  connectionBounds,
  distanceToConnection,
  EDGE_HIT_DISTANCE,
  type Point,
} from "./connection";
import { FlowScene } from "./scene";

function node(id: string, x: number, y: number, overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: id,
    x,
    y,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
    ...overrides,
  };
}

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return { id, fromId, toId, fromPort: null, toPort: null, kind: "flow", dataJson: "{}" };
}

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

function anchored(id: string, fromId: string, toId: string, from: Point, to: Point): EdgeSummary {
  return { ...edge(id, fromId, toId), fromPoint: from, toPoint: to };
}

test("does not select a connector merely inside its control-point box", () => {
  // A curved connector: card a's output port (200, 42) to card b's input
  // port (0, 222). The controls stretch the box far past the curve.
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 0, 180)], [edge("a-b", "a", "b")]));
  const from = { x: 200, y: 42 };
  const to = { x: 0, y: 222 };
  const inside = { x: -120, y: 50 };
  const box = connectionBounds(from, to);

  expect(inside.x >= box.x && inside.x <= box.x + box.width).toBe(true);
  expect(inside.y >= box.y && inside.y <= box.y + box.height).toBe(true);
  expect(distanceToConnection(from, to, inside)).toBeGreaterThan(EDGE_HIT_DISTANCE);
  expect(scene.edgeAt(inside.x, inside.y)).toBeNull();
});

test("finds a connector on its exact curve inside the control-point box", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([], [anchored("a-b", "a", "b", { x: 200, y: 42 }, { x: 0, y: 222 })]));

  // (100, 132) is the cubic's midpoint, between the box and the chord.
  expect(scene.edgeAt(100, 132)).toBe("a-b");
  // (220, 60) is 2.8 units from the sampled curve, inside the hit distance.
  expect(scene.edgeAt(220, 60)).toBe("a-b");
});

test("keeps exact hits on the edge hit distance's inclusive border", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([], [anchored("a-b", "a", "b", { x: 0, y: 0 }, { x: 200, y: 0 })]));

  // Each point is exactly EDGE_HIT_DISTANCE from the straight curve and on
  // the expanded control-point box's border.
  for (const point of [
    { x: 100, y: EDGE_HIT_DISTANCE },
    { x: 100, y: -EDGE_HIT_DISTANCE },
    { x: 0, y: EDGE_HIT_DISTANCE },
    { x: 0, y: -EDGE_HIT_DISTANCE },
    { x: 200 + EDGE_HIT_DISTANCE, y: 0 },
  ]) {
    expect(scene.edgeAt(point.x, point.y)).toBe("a-b");
  }

  // Just past the expanded box and the hit distance, the connector misses.
  expect(scene.edgeAt(100, EDGE_HIT_DISTANCE + 0.001)).toBeNull();
  expect(scene.edgeAt(200 + EDGE_HIT_DISTANCE + 0.001, 0)).toBeNull();
});

test("hit-tests a curve whose far endpoint is carried by its anchors", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0)], [{ ...edge("a-b", "a", "b"), toPoint: { x: 2_000, y: 300 } }]),
  );

  const first = scene.edges()[0];
  if (!first) throw new Error("the edge was pruned");
  const ports = scene.edgePorts(first);
  if (!ports) throw new Error("the edge has no ports");
  const onCurve = { x: 1_000, y: 150 };

  expect(distanceToConnection(ports.from, ports.to, onCurve)).toBeLessThan(EDGE_HIT_DISTANCE);
  expect(scene.edgeAt(onCurve.x, onCurve.y)).toBe("a-b");
  // Far from both the curve and the control-point box.
  expect(scene.edgeAt(1_000, 600)).toBeNull();
});

test("keeps the nearest connector and the first one on an exact tie", () => {
  const scene = new FlowScene();
  const horizontal = anchored("horizontal", "a", "b", { x: 0, y: 0 }, { x: 200, y: 0 });
  const beside = anchored("beside", "c", "d", { x: 0, y: 6 }, { x: 200, y: 6 });
  const vertical = anchored("vertical", "e", "f", { x: 100, y: -100 }, { x: 100, y: 100 });

  scene.apply(snapshot([], [beside, horizontal]));
  // (100, 1) is one unit from the horizontal curve and five from the one
  // beside it, whatever order the edges arrived in.
  expect(scene.edgeAt(100, 1)).toBe("horizontal");

  scene.apply(snapshot([], [horizontal, vertical]));
  // Both curves pass through (100, 0); the first in map order keeps the tie.
  expect(scene.edgeAt(100, 0)).toBe("horizontal");

  scene.apply(snapshot([], [vertical, horizontal]));
  expect(scene.edgeAt(100, 0)).toBe("vertical");
});
