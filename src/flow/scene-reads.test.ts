import { expect, test } from "nsh/test";
import { effect } from "nsh";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import type { BoxGeometry } from "./connection";
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

function rect(scene: FlowScene, id: string): BoxGeometry {
  const value = scene.cardRect(id);
  if (!value) throw new Error(`The scene has no card "${id}".`);
  return value;
}

test("an identical snapshot wakes no list or geometry reader", () => {
  const scene = new FlowScene();
  const firstNode = node("a", 40, 40);
  const firstEdge = edge("a-b", "a", "b");
  scene.apply(snapshot([firstNode, node("b", 360, 40)], [firstEdge]));

  let nodeRuns = 0;
  let edgeRuns = 0;
  let rectRuns = 0;
  effect(() => {
    scene.nodes();
    nodeRuns += 1;
  });
  effect(() => {
    scene.edges();
    edgeRuns += 1;
  });
  effect(() => {
    scene.cardRect("a");
    rectRuns += 1;
  });

  // Field-identical records in fresh objects: nothing moved, nothing changed.
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));

  expect([nodeRuns, edgeRuns, rectRuns]).toEqual([1, 1, 1]);
  expect(scene.nodes()[0]).toBe(firstNode);
  expect(scene.edges()[0]).toBe(firstEdge);
});

test("a snapshot that changes one card's status replaces only that record", () => {
  const scene = new FlowScene();
  const firstNode = node("a", 40, 40);
  const secondNode = node("b", 360, 40);
  scene.apply(snapshot([firstNode, secondNode]));

  let nodeRuns = 0;
  effect(() => {
    scene.nodes();
    nodeRuns += 1;
  });

  scene.apply(snapshot([node("a", 40, 40, { status: "running" }), node("b", 360, 40)]));

  expect(nodeRuns).toBe(2);
  const nodes = scene.nodes();
  expect(nodes[0]).not.toBe(firstNode);
  expect(nodes[0]?.status).toBe("running");
  expect(nodes[1]).toBe(secondNode);
});
