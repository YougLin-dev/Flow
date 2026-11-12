/**
 * Connector gestures through the canvas controller: starting a connection
 * from either side's typed port, snapping to a compatible port, and moving
 * either end of the selected edge.
 */
import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, CanvasController } from "./canvas-controller";
import type { ConnectionPair } from "./connection-gesture";
import { FlowScene } from "./scene";

function node(id: string, x: number, y: number): NodeSummary {
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
  };
}

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return {
    id,
    fromId,
    toId,
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 42,
    toOffset: 42,
    kind: "flow",
    dataJson: "{}",
  };
}

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

interface Calls {
  readonly edges: (string | null)[];
  readonly reconnects: {
    edgeId: string;
    fromId: string;
    fromPort: string;
    toId: string;
    toPort: string;
  }[];
  readonly connections: {
    fromId: string;
    fromPort: string;
    toId: string;
    toPort: string;
  }[];
  /** The committed pairs with their type and port anchors. */
  readonly raw: ConnectionPair[];
}

function setup(
  nodes: NodeSummary[],
  edges: EdgeSummary[] = [],
): {
  scene: FlowScene;
  controller: CanvasController;
  calls: Calls;
} {
  const scene = new FlowScene();
  scene.apply(snapshot(nodes, edges));
  const camera = new CanvasCamera();
  const calls: Calls = { edges: [], reconnects: [], connections: [], raw: [] };
  const pair = (
    value: ConnectionPair,
  ): {
    fromId: string;
    fromPort: string;
    toId: string;
    toPort: string;
  } => ({
    fromId: value.fromId,
    fromPort: value.fromPort,
    toId: value.toId,
    toPort: value.toPort,
  });
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: (id) => {
      calls.edges.push(id);
      scene.selectEdge(id);
    },
    reconnectEdge: (edgeId, value) => calls.reconnects.push({ edgeId, ...pair(value) }),
    connectNodes: (pairs) => {
      calls.raw.push(...pairs);
      calls.connections.push(...pairs.map(pair));
    },
    openInline: () => undefined,
    onCardPress: () => undefined,
  };
  return { scene, controller: new CanvasController(host), calls };
}

test("starts a connection from an output port", () => {
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(214, 42, false, 1);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.gesturing()).toBe(true);
  controller.move(250, 42);
  expect(scene.connectionPreview()).not.toBeNull();

  controller.up(286, 28);
  expect(controller.gesturing()).toBe(false);
  expect(calls.connections).toEqual([
    { fromId: "a", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
  expect(scene.connectionPreview()).toBeNull();
});

test("starts a reverse connection from an input port", () => {
  const { controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(286, 28, false, 1);
  expect(controller.cursor()).toBe("crosshair");
  controller.move(250, 42);

  controller.up(214, 42);
  expect(calls.connections).toEqual([
    { fromId: "a", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
});

test("snaps a pulled connector to a compatible port and unsnaps on leaving", () => {
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(214, 42, false, 1);
  controller.move(286, 28);
  expect(scene.connectionTarget()).toBe("b");
  expect(scene.connectionPreview()).toEqual({
    from: { x: 214, y: 42 },
    to: { x: 286, y: 28 },
    portKind: "text",
  });

  // Between the cards, the preview follows the pointer again.
  controller.move(240, 46);
  expect(scene.connectionTarget()).toBeNull();
  expect(scene.connectionPreview()?.to).toEqual({ x: 240, y: 46 });

  controller.move(286, 28);
  controller.up(286, 28);
  expect(scene.connectionTarget()).toBeNull();
  expect(calls.connections).toEqual([
    { fromId: "a", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
});

test("a still press on a port writes no connector", () => {
  // b's prompt sits 32 points from a's output: inside the release snap, as
  // a click without movement used to be enough to write the edge.
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 240, 30)]);

  controller.down(214, 42, false, 1);
  expect(controller.gestureMoved()).toBe(false);
  controller.up(214, 42);
  expect(calls.connections).toEqual([]);
  expect(scene.connectionPreviews()).toBeNull();
});

test("does not offer a pair that is already connected", () => {
  const { scene, controller, calls } = setup(
    [node("a", 0, 0), node("b", 300, 0)],
    [edge("a-b", "a", "b")],
  );

  controller.down(214, 42, false, 1);
  controller.move(286, 28);
  expect(scene.connectionTarget()).toBeNull();
  controller.up(286, 28);
  expect(calls.connections).toEqual([]);
});

test("snaps a release within the join reach even between ports", () => {
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(214, 42, false, 1);
  // 30 points below b's prompt: outside the 24-point hit radius, inside the
  // 34-point release snap.
  controller.move(286, 58);
  expect(scene.connectionTarget()).toBe("b");
  expect(scene.connectionPreviews()?.[0]?.to).toEqual({ x: 286, y: 28 });

  controller.up(286, 58);
  expect(calls.connections).toEqual([
    { fromId: "a", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
  expect(calls.raw[0]?.portKind).toBe("text");
  expect(calls.raw[0]?.fromOffset).toBe(42);
  expect(calls.raw[0]?.toOffset).toBe(28);
});

test("does not offer the source card itself as a target", () => {
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(214, 42, false, 1);
  // a's own prompt sits at (-14, 28): excluded with its output's card.
  controller.move(-14, 28);
  expect(scene.connectionTarget()).toBeNull();
  controller.up(-14, 28);
  expect(calls.connections).toEqual([]);
});

test("does not rewrite an edge released on its own endpoint", () => {
  const { controller, calls } = setup(
    [node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)],
    [edge("a-b", "a", "b")],
  );

  controller.down(250, 42, false, 1);
  expect(calls.edges).toContain("a-b");

  controller.down(286, 28, false, 1);
  controller.up(286, 28);
  expect(calls.reconnects).toEqual([]);
});

test("reconnects the selected edge's source end", () => {
  const { controller, calls } = setup(
    [node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)],
    [edge("a-b", "a", "b")],
  );

  // Select the edge by pressing its connector, then drag its source port.
  controller.down(250, 42, false, 1);
  expect(calls.edges).toContain("a-b");

  controller.down(214, 42, false, 1);
  controller.move(814, 42);
  controller.up(814, 42);
  expect(calls.reconnects).toEqual([
    { edgeId: "a-b", fromId: "c", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
});

test("reconnects the selected edge's target end from its input port", () => {
  const { controller, calls } = setup(
    [node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)],
    [edge("a-b", "a", "b")],
  );

  controller.down(250, 42, false, 1);
  expect(calls.edges).toContain("a-b");

  // The target's input port sits left of its border; release on c's.
  controller.down(286, 28, false, 1);
  controller.move(586, 28);
  controller.up(586, 28);
  expect(calls.reconnects).toEqual([
    { edgeId: "a-b", fromId: "a", fromPort: "text", toId: "c", toPort: "prompt" },
  ]);
});
