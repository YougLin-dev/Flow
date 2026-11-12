/**
 * The typed group ports of a multi-card marquee frame: where they rest, how
 * they take the press, the presence of one port per type, their capacity
 * state and the group connection they start.
 */
import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, CanvasController } from "./canvas-controller";
import { PORT_CENTER_GAP, portOffset } from "./connection";
import { selectionFrame } from "./frame-surface";
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

function edge(id: string, fromId: string, toId: string, toPort: string): EdgeSummary {
  return {
    id,
    fromId,
    toId,
    fromPort: "text",
    toPort,
    portKind: "text",
    fromOffset: 46,
    toOffset: 46,
    kind: "flow",
    dataJson: "{}",
  };
}

function setup(
  nodes: NodeSummary[],
  edges: EdgeSummary[] = [],
): {
  scene: FlowScene;
  controller: CanvasController;
  connections: {
    fromId: string;
    fromPort: string;
    toId: string;
    toPort: string;
  }[];
} {
  const scene = new FlowScene();
  scene.apply({ rev: 1, nodes, edges });
  const camera = new CanvasCamera();
  const connections: {
    fromId: string;
    fromPort: string;
    toId: string;
    toPort: string;
  }[] = [];
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: (id) => scene.selectEdge(id),
    reconnectEdge: () => undefined,
    connectNodes: (pairs) =>
      connections.push(
        ...pairs.map((pair) => ({
          fromId: pair.fromId,
          fromPort: pair.fromPort,
          toId: pair.toId,
          toPort: pair.toPort,
        })),
      ),
    openInline: () => undefined,
    onCardPress: () => undefined,
  };
  return { scene, controller: new CanvasController(host), connections };
}

function marquee(controller: CanvasController): void {
  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);
}

test("a still press on the frame's group port writes nothing", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    // Entirely left of the marquee, but its output icon sits 26 points from
    // the frame's text input group port: inside the release snap.
    node("c", -160, 67),
  ]);
  marquee(controller);

  controller.down(80, 109, false, 1);
  expect(controller.gesturing()).toBe(true);
  expect(controller.gestureMoved()).toBe(false);
  controller.up(80, 109);
  expect(connections).toEqual([]);
  expect(scene.connectionPreviews()).toBeNull();
});

test("rejects a group fan-out that exceeds the target input's capacity", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);
  marquee(controller);

  // Two selected outputs cannot share c's single prompt slot; the whole
  // gesture is rejected rather than writing a partial fan-out.
  controller.down(620, 129, false, 1);
  controller.move(136, 442);
  expect(scene.connectionTarget()).toBeNull();
  controller.up(136, 442);
  expect(connections).toEqual([]);
});

test("exposes one ordered group per type on a mixed selection", () => {
  const { scene, controller } = setup([
    node("a", 100, 100),
    node("b", 400, 100, { kind: "image" }),
  ]);
  marquee(controller);

  const bounds = scene.selectionBounds();
  if (bounds === null) throw new Error("the selection has no bounds");
  const frame = selectionFrame(bounds, 1);
  const y = (index: number): number => frame.y + portOffset(index, 2, frame.height);
  const right = frame.x + frame.width + PORT_CENTER_GAP;
  const left = frame.x - PORT_CENTER_GAP;

  controller.hover(right, y(0));
  expect(controller.hoveredGroup()).toMatchObject({ side: "out", portKind: "text" });
  controller.hover(right, y(1));
  expect(controller.hoveredGroup()).toMatchObject({ side: "out", portKind: "image" });
  controller.hover(left, y(0));
  expect(controller.hoveredGroup()).toMatchObject({ side: "in", portKind: "text" });
  controller.hover(left, y(1));
  expect(controller.hoveredGroup()).toMatchObject({ side: "in", portKind: "image" });
});

test("puts one typed group port per side and keeps the frame draggable", () => {
  const { scene, controller } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);
  marquee(controller);
  expect(controller.multiFrame()).toBe(true);

  // The padded frame is x 94…606, y 68…190. Its ports spread evenly: the
  // text prompt group at (80, 109), the image references group at (80, 149)
  // and the single text output group at (620, 129).
  controller.hover(80, 109);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.hovered()).toBeNull();
  expect(controller.hoveredGroup()).toMatchObject({
    side: "in",
    portKind: "text",
    point: { x: 80, y: 109 },
    center: { x: 80, y: 68 + 122 / 3 },
  });

  controller.hover(620, 129);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.hoveredGroup()).toMatchObject({
    side: "out",
    portKind: "text",
    point: { x: 620, y: 129 },
    center: { x: 620, y: 129 },
  });

  // A framed card's own port is muted; the frame drag owns the press.
  controller.hover(316, 142);
  expect(controller.hoveredGroup()).toBeNull();
  expect(controller.cursor()).toBe("grab");

  controller.down(316, 142, false, 1);
  expect(controller.gesturing()).toBe(true);
  controller.move(366, 192);
  expect(scene.cardRect("a")).toEqual({ x: 150, y: 150, width: 200, height: 84 });
  expect(scene.connectionPreviews()).toBeNull();
  controller.up(366, 192);
});

test("connects every selected output from the frame's group port", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100, { kind: "image" }),
    node("b", 400, 100, { kind: "image" }),
    node("c", 150, 400),
  ]);
  marquee(controller);

  // Images fan out into one text node's references input (up to 4 edges).
  controller.down(620, 129, false, 1);
  expect(controller.gesturing()).toBe(true);
  controller.move(136, 456);
  expect(scene.connectionTarget()).toBe("c");
  expect(scene.connectionPreviews()).toEqual([
    { from: { x: 314, y: 142 }, to: { x: 136, y: 456 }, portKind: "image" },
    { from: { x: 614, y: 142 }, to: { x: 136, y: 456 }, portKind: "image" },
  ]);

  controller.up(136, 456);
  expect(connections).toEqual([
    { fromId: "a", fromPort: "image", toId: "c", toPort: "references" },
    { fromId: "b", fromPort: "image", toId: "c", toPort: "references" },
  ]);
  expect(scene.connectionPreviews()).toBeNull();
  expect(scene.connectionTarget()).toBeNull();
});

test("connects a target to every selected input from the frame's group port", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);
  marquee(controller);

  controller.down(80, 109, false, 1);
  controller.move(364, 442);
  expect(scene.connectionPreviews()).toEqual([
    { from: { x: 364, y: 442 }, to: { x: 86, y: 128 }, portKind: "text" },
    { from: { x: 364, y: 442 }, to: { x: 386, y: 128 }, portKind: "text" },
  ]);

  controller.up(364, 442);
  expect(connections).toEqual([
    { fromId: "c", fromPort: "text", toId: "a", toPort: "prompt" },
    { fromId: "c", fromPort: "text", toId: "b", toPort: "prompt" },
  ]);
});

test("fans image inputs out to one image output", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400, { kind: "image" }),
  ]);
  marquee(controller);

  // The second left group port is the image references group, below the
  // text prompt group.
  controller.down(80, 149, false, 1);
  controller.move(364, 442);
  expect(scene.connectionPreviews()).toEqual([
    { from: { x: 364, y: 442 }, to: { x: 86, y: 156 }, portKind: "image" },
    { from: { x: 364, y: 442 }, to: { x: 386, y: 156 }, portKind: "image" },
  ]);

  controller.up(364, 442);
  expect(connections).toEqual([
    { fromId: "c", fromPort: "image", toId: "a", toPort: "references" },
    { fromId: "c", fromPort: "image", toId: "b", toPort: "references" },
  ]);
});

test("disables an input group when one member port is full", () => {
  const { scene, controller } = setup(
    [node("a", 100, 100), node("b", 400, 100), node("c", 900, 400)],
    [edge("c-a", "c", "a", "prompt")],
  );
  marquee(controller);
  expect(controller.multiFrame()).toBe(true);

  // a's prompt is full, so the text input group cannot fan out at all.
  controller.hover(80, 109);
  expect(controller.cursor()).toBe("not-allowed");
  controller.down(80, 109, false, 1);
  expect(controller.gesturing()).toBe(false);
  expect(scene.connectionPreviews()).toBeNull();

  // The output side has no such limit.
  controller.hover(620, 129);
  expect(controller.cursor()).toBe("crosshair");
});

test("a press on a connector inside the frame keeps the selection", () => {
  const { scene, controller } = setup(
    [node("a", 100, 100), node("b", 400, 100), node("c", 150, 400)],
    [edge("a-c", "a", "c", "prompt")],
  );
  marquee(controller);
  expect(controller.multiFrame()).toBe(true);

  // (314, 142) is the a→c connector's start at a's output port, inside the
  // frame. The frame is one drag surface: the press keeps the multi-selection
  // instead of selecting the connector and dropping the frame.
  controller.down(314, 142, false, 1);
  controller.up(314, 142);
  expect(controller.multiFrame()).toBe(true);
  expect(scene.selection()).toEqual(["a", "b"]);
  expect(scene.selectedEdge()).toBeNull();
});

test("a connector press stays a click until the pointer moves", () => {
  const { controller } = setup([node("a", 0, 0)]);

  // (214, 46) is the card's text output port: the press arms a connection
  // but has not pulled one yet.
  controller.down(214, 46, false, 1);
  expect(controller.gesturing()).toBe(true);
  expect(controller.gestureMoved()).toBe(false);

  // A move that reports the press point publishes only the preview.
  controller.move(214, 46);
  expect(controller.gestureMoved()).toBe(false);

  // The first nonzero screen displacement is a pulled connector.
  controller.move(216, 46);
  expect(controller.gestureMoved()).toBe(true);

  controller.up(216, 46);
  expect(controller.gestureMoved()).toBe(false);
});

test("keeps a single-card frame's per-card ports", () => {
  const { controller } = setup([node("a", 100, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(350, 220);
  controller.up(350, 220);
  expect(controller.multiFrame()).toBe(false);

  controller.hover(314, 146);
  expect(controller.hovered()).toBe("a");
  expect(controller.cursor()).toBe("crosshair");
});
