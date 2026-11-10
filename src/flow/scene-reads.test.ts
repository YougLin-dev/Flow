import { expect, test } from "nsh/test";
import { effect } from "nsh";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
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

test("a status change on one card does not wake another card's rect reader", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
  let runsA = 0;
  let runsB = 0;
  effect(() => {
    scene.cardRect("a");
    runsA += 1;
  });
  effect(() => {
    scene.cardRect("b");
    runsB += 1;
  });

  scene.applyChangeSet({
    changed: [node("a", 40, 40, { status: "running" })],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });

  // A's rectangle object did not change either; only its other fields did.
  expect([runsA, runsB]).toEqual([1, 1]);
});

test("a change set moving A wakes only A's rect readers", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
  let runsA = 0;
  let runsB = 0;
  effect(() => {
    scene.cardRect("a");
    runsA += 1;
  });
  effect(() => {
    scene.cardRect("b");
    runsB += 1;
  });

  scene.applyChangeSet({
    changed: [node("a", 90, 40)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });

  expect([runsA, runsB]).toEqual([2, 1]);
});

test("a far endpoint that enters the scene and moves wakes its early reader", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0)], [{ ...edge("a-b", "a", "b"), toPoint: { x: 2_000, y: 300 } }]),
  );
  let runs = 0;
  effect(() => {
    scene.cardRect("b");
    runs += 1;
  });
  expect(runs).toBe(1);
  expect(scene.cardRect("b")).toBeNull();

  // The change set accepts an id the viewport has not reported yet.
  scene.applyChangeSet({
    changed: [node("b", 300, 0)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(runs).toBe(2);
  expect(scene.cardRect("b")).toEqual({ x: 300, y: 0, width: 200, height: 84 });

  scene.applyChangeSet({
    changed: [node("b", 400, 0)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(runs).toBe(3);
  expect(scene.cardRect("b")?.x).toBe(400);
});

test("an identical snapshot wakes no card rect reader", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
  let runsA = 0;
  let runsB = 0;
  effect(() => {
    scene.cardRect("a");
    runsA += 1;
  });
  effect(() => {
    scene.cardRect("b");
    runsB += 1;
  });

  // A is field-equal and B moved: only B's geometry binding may re-run.
  scene.apply(snapshot([node("a", 40, 40), node("b", 500, 40)]));

  expect([runsA, runsB]).toEqual([1, 2]);
});

test("identical previews keep their identity and wake no reader", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0, { kind: "image", outputBatchId: "batch" })]));
  scene.applyPreviews([{ nodeId: "a", urls: ["data:image/png;base64,x"], count: 1 }]);
  let runs = 0;
  effect(() => {
    scene.previews();
    runs += 1;
  });
  const first = scene.previews().get("a");

  // Same contents in a fresh view object and URL array: no new publication.
  scene.applyPreviews([{ nodeId: "a", urls: ["data:image/png;base64,x"], count: 1 }]);
  expect(runs).toBe(1);
  expect(scene.previews().get("a")).toBe(first);

  scene.applyPreviews([{ nodeId: "a", urls: ["data:image/png;base64,x"], count: 2 }]);
  expect(runs).toBe(2);
});
