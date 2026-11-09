import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, type CanvasTool, CanvasController } from "./canvas-controller";
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

interface Calls {
  readonly pans: { dx: number; dy: number }[];
  readonly commits: (readonly NodeBounds[])[];
  readonly edges: (string | null)[];
  readonly reconnects: { edgeId: string; fromId: string; toId: string }[];
  readonly connections: { fromId: string; toId: string }[];
  readonly inline: string[];
  readonly cards: string[];
}

function setup(
  nodes: NodeSummary[],
  edges: EdgeSummary[] = [],
): {
  scene: FlowScene;
  camera: CanvasCamera;
  controller: CanvasController;
  calls: Calls;
  useTool: (tool: CanvasTool) => void;
} {
  const scene = new FlowScene();
  scene.apply(snapshot(nodes, edges));
  const camera = new CanvasCamera();
  const calls: Calls = {
    pans: [],
    commits: [],
    edges: [],
    reconnects: [],
    connections: [],
    inline: [],
    cards: [],
  };
  let tool: CanvasTool = "select";
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    tool: () => tool,
    panBy: (dx, dy) => calls.pans.push({ dx, dy }),
    commitBounds: (bounds) => calls.commits.push(bounds),
    selectEdge: (id) => {
      calls.edges.push(id);
      scene.selectEdge(id);
    },
    reconnectEdge: (edgeId, fromId, toId) => calls.reconnects.push({ edgeId, fromId, toId }),
    connectNodes: (fromId, toId) => calls.connections.push({ fromId, toId }),
    openInline: (nodeId) => calls.inline.push(nodeId),
    onCardPress: (nodeId) => calls.cards.push(nodeId),
  };
  return {
    scene,
    camera,
    controller: new CanvasController(host),
    calls,
    useTool: (next) => {
      tool = next;
    },
  };
}

test("selects a card on press and commits a dragged position", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  expect(scene.selectedIds()).toEqual(["a"]);
  expect(calls.cards).toEqual(["a"]);
  expect(controller.gesturing()).toBe(true);
  expect(controller.cursor()).toBe("grabbing");

  controller.move(190, 160);
  expect(scene.cardRect("a")).toEqual({ x: 140, y: 140, width: 200, height: 84 });

  controller.up(190, 160);
  expect(controller.gesturing()).toBe(false);
  expect(calls.commits).toEqual([[{ id: "a", x: 140, y: 140, width: 200, height: 84 }]]);
});

test("drops the override when a drag ends where it began", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  controller.move(190, 160);
  controller.move(150, 120);
  expect(scene.overrides().size).toBe(1);

  controller.up(150, 120);
  expect(scene.overrides().size).toBe(0);
  expect(calls.commits).toEqual([]);
});

test("cancels a drag without committing it", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  controller.move(190, 160);
  expect(scene.overrides().size).toBe(1);

  controller.cancel();
  expect(scene.overrides().size).toBe(0);
  expect(controller.gesturing()).toBe(false);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 100, width: 200, height: 84 });
  expect(calls.commits).toEqual([]);
  expect(controller.cursor()).toBe("default");
});

test("shift-click toggles the selection", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(150, 120, false, 1);
  controller.up(150, 120);
  controller.down(450, 120, true, 1);
  controller.up(450, 120);
  expect(scene.selectedIds()).toEqual(["a", "b"]);

  controller.down(150, 120, true, 1);
  controller.up(150, 120);
  expect(scene.selectedIds()).toEqual(["b"]);
});

test("shift-deselect does not re-add the card when the release jitters", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  scene.select(["a", "b"]);

  controller.down(150, 120, true, 1);
  expect(scene.selectedIds()).toEqual(["b"]);
  controller.move(152, 121);
  controller.up(152, 121);
  expect(scene.selectedIds()).toEqual(["b"]);
});

test("box-selects only the cards the marquee covers", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  expect(scene.selectedIds()).toEqual([]);
  expect(controller.marquee()).toEqual({ x: 50, y: 50, width: 0, height: 0 });

  controller.move(350, 220);
  expect(controller.marquee()).toEqual({ x: 50, y: 50, width: 300, height: 170 });

  controller.up(350, 220);
  expect(scene.selectedIds()).toEqual(["a"]);
  expect(controller.marquee()).toBeNull();
});

test("pans with the hand tool instead of selecting", () => {
  const { scene, controller, calls, useTool } = setup([node("a", 100, 100)]);
  useTool("hand");

  controller.down(10, 10, false, 1);
  controller.move(30, 40);
  controller.up(30, 40);

  expect(calls.pans).toEqual([{ dx: 20, dy: 30 }]);
  expect(scene.selectedIds()).toEqual([]);

  controller.hover(150, 120);
  expect(controller.hovered()).toBe("a");
  expect(controller.cursor()).toBe("grab");
});

test("resizes the selected card from its handle", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);
  scene.select(["a"]);

  controller.down(300, 184, false, 1);
  expect(controller.cursor()).toBe("nwse-resize");
  expect(controller.gesturing()).toBe(true);

  controller.move(340, 214);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 100, width: 240, height: 114 });

  controller.up(340, 214);
  expect(controller.gesturing()).toBe(false);
  expect(calls.commits).toEqual([[{ id: "a", x: 100, y: 100, width: 240, height: 114 }]]);
});

test("prefers the output port over the east resize handle", () => {
  const { scene, controller } = setup([node("a", 100, 100)]);
  scene.select(["a"]);

  // The east handle and the output port share (300, 142); the port wins.
  controller.hover(300, 142);
  expect(controller.cursor()).toBe("crosshair");
  controller.down(300, 142, false, 1);
  expect(controller.cursor()).toBe("crosshair");
  controller.cancel();
});

test("opens the inline editor on a double-clicked text card", () => {
  const { controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 2);
  expect(calls.inline).toEqual(["a"]);
});

test("starts a connection from an output port", () => {
  const { scene, controller, calls } = setup([node("a", 0, 0), node("b", 300, 0)]);

  controller.down(200, 42, false, 1);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.gesturing()).toBe(true);
  controller.move(250, 42);
  expect(scene.connectionPreview()).not.toBeNull();

  controller.up(350, 42);
  expect(controller.gesturing()).toBe(false);
  expect(calls.connections).toEqual([{ fromId: "a", toId: "b" }]);
  expect(scene.connectionPreview()).toBeNull();
});

test("does not rewrite an edge released on its own endpoint", () => {
  const { controller, calls } = setup(
    [node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)],
    [edge("a-b", "a", "b")],
  );

  controller.down(250, 42, false, 1);
  expect(calls.edges).toContain("a-b");

  controller.down(300, 42, false, 1);
  controller.up(300, 42);
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

  controller.down(200, 42, false, 1);
  controller.move(650, 42);
  controller.up(650, 42);
  expect(calls.reconnects).toEqual([{ edgeId: "a-b", fromId: "c", toId: "b" }]);
});
