import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, CanvasController } from "./canvas-controller";
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

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

interface Calls {
  readonly pans: { dx: number; dy: number }[];
  readonly commits: (readonly NodeBounds[])[];
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
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    panBy: (dx, dy) => calls.pans.push({ dx, dy }),
    commitBounds: (bounds) => calls.commits.push(bounds),
    selectEdge: (id) => {
      calls.edges.push(id);
      scene.selectEdge(id);
    },
    reconnectEdge: (edgeId, pair) =>
      calls.reconnects.push({
        edgeId,
        fromId: pair.fromId,
        fromPort: pair.fromPort,
        toId: pair.toId,
        toPort: pair.toPort,
      }),
    connectNodes: (pairs) =>
      calls.connections.push(
        ...pairs.map((pair) => ({
          fromId: pair.fromId,
          fromPort: pair.fromPort,
          toId: pair.toId,
          toPort: pair.toPort,
        })),
      ),
    openInline: (nodeId) => calls.inline.push(nodeId),
    onCardPress: (nodeId) => calls.cards.push(nodeId),
  };
  return {
    scene,
    camera,
    controller: new CanvasController(host),
    calls,
  };
}

test("an additive marquee keeps selection order and selects each card once", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  scene.select(["b", "a"]);

  // The box covers a before b in scene order, but the additive result keeps
  // the already-selected order and appends no duplicate.
  controller.down(50, 50, true, 1);
  controller.move(500, 220);
  expect([...controller.marqueePreview()]).toEqual(["b", "a"]);
  controller.up(500, 220);
  const additive = scene.selectedIds();
  expect(additive).toEqual(["b", "a"]);
  expect(new Set(additive).size).toBe(additive.length);

  // A fresh marquee is the scene's order, not the previous selection's.
  controller.down(50, 50, false, 1);
  controller.move(500, 220);
  controller.up(500, 220);
  const fresh = scene.selectedIds();
  expect(fresh).toEqual(["a", "b"]);
  expect(new Set(fresh).size).toBe(fresh.length);
});

test("shows a resize cursor over a handle just outside a card", () => {
  const { controller } = setup([node("a", 100, 100)]);

  // (305, 189) is five points beyond the card's southeast corner.
  controller.hover(305, 189);
  expect(controller.cursor()).toBe("nwse-resize");
  expect(controller.hovered()).toBe("a");

  // The card body itself is not a handle.
  controller.hover(150, 120);
  expect(controller.cursor()).toBe("default");
  expect(controller.hovered()).toBe("a");
});

test("keeps an outside handle's seven screen points at every zoom", () => {
  for (const scale of [0.5, 2]) {
    const { scene, camera, controller } = setup([node("a", 100, 100)]);
    scene.select([]);
    camera.scale = scale;
    const x = 200 * scale;
    const top = 100 * scale;

    // Five screen points above the north border is inside the handle reach.
    controller.hover(x, top - 5);
    expect(controller.cursor()).toBe("ns-resize");
    expect(controller.hovered()).toBe("a");

    // Eight screen points above is past the reach and outside the card.
    controller.hover(x, top - 8);
    expect(controller.cursor()).toBe("default");
    expect(controller.hovered()).toBeNull();
  }
});

test("a top card hides a lower card's port during hover", () => {
  const { controller } = setup([node("a", 0, 0), node("cover", 190, 0, { z: 5 })]);

  // (214, 46) is a's output port, inside cover's body.
  controller.hover(214, 46);
  expect(controller.hovered()).toBe("cover");
  expect(controller.cursor()).toBe("default");
});
