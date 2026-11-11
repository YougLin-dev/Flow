/**
 * The merged plus buttons of a multi-card marquee frame: where they rest,
 * how they take the press, and the group connection they start.
 */
import { expect, test } from "nsh/test";
import type { NodeSummary } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, CanvasController } from "./canvas-controller";
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

function setup(nodes: NodeSummary[]): {
  scene: FlowScene;
  controller: CanvasController;
  connections: { fromId: string; toId: string }[];
} {
  const scene = new FlowScene();
  scene.apply({ rev: 1, nodes, edges: [] });
  const camera = new CanvasCamera();
  const connections: { fromId: string; toId: string }[] = [];
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: (id) => scene.selectEdge(id),
    reconnectEdge: () => undefined,
    connectNodes: (pairs) => connections.push(...pairs),
    openInline: () => undefined,
    onCardPress: () => undefined,
  };
  return { scene, controller: new CanvasController(host), connections };
}

test("moves a multi-card frame's pluses onto its sides", () => {
  const { scene, controller } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);
  expect(controller.multiFrame()).toBe(true);

  // The padded frame is x 94…606, y 68…190: the right plus rests at (622,129).
  controller.hover(622, 129);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.framePlus()).toEqual({ side: "out", point: { x: 622, y: 129 } });
  expect(controller.portPlus()).toBeNull();

  // A framed card's own plus zone is muted; the frame drag owns the press.
  controller.hover(316, 142);
  expect(controller.portPlus()).toBeNull();
  expect(controller.framePlus()).toBeNull();
  expect(controller.cursor()).toBe("grab");

  controller.down(316, 142, false, 1);
  expect(controller.gesturing()).toBe(true);
  controller.move(366, 192);
  expect(scene.cardRect("a")).toEqual({ x: 150, y: 150, width: 200, height: 84 });
  expect(scene.connectionPreviews()).toBeNull();
  controller.up(366, 192);
});

test("connects every selected card from the frame's right plus", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);
  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);

  controller.down(622, 129, false, 1);
  expect(controller.gesturing()).toBe(true);
  controller.move(250, 440);
  expect(scene.connectionTarget()).toBe("c");
  expect(scene.connectionPreviews()).toEqual([
    { from: { x: 300, y: 142 }, to: { x: 150, y: 442 } },
    { from: { x: 600, y: 142 }, to: { x: 150, y: 442 } },
  ]);

  controller.up(250, 440);
  expect(connections).toEqual([
    { fromId: "a", toId: "c" },
    { fromId: "b", toId: "c" },
  ]);
  expect(scene.connectionPreviews()).toBeNull();
  expect(scene.connectionTarget()).toBeNull();
});

test("connects a target to every selected card from the frame's left plus", () => {
  const { scene, controller, connections } = setup([
    node("a", 100, 100),
    node("b", 400, 100),
    node("c", 150, 400),
  ]);
  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);

  controller.down(78, 129, false, 1);
  controller.move(250, 440);
  expect(scene.connectionPreviews()).toEqual([
    { from: { x: 350, y: 442 }, to: { x: 100, y: 142 } },
    { from: { x: 350, y: 442 }, to: { x: 400, y: 142 } },
  ]);

  controller.up(250, 440);
  expect(connections).toEqual([
    { fromId: "c", toId: "a" },
    { fromId: "c", toId: "b" },
  ]);
});

test("a connector press stays a click until the pointer moves", () => {
  const { controller } = setup([node("a", 0, 0)]);

  // (216, 42) is the card's right plus: the press arms a connection but has
  // not pulled one yet.
  controller.down(216, 42, false, 1);
  expect(controller.gesturing()).toBe(true);
  expect(controller.gestureMoved()).toBe(false);

  // A move that reports the press point publishes only the preview.
  controller.move(216, 42);
  expect(controller.gestureMoved()).toBe(false);

  // The first nonzero screen displacement is a pulled connector.
  controller.move(218, 42);
  expect(controller.gestureMoved()).toBe(true);

  controller.up(218, 42);
  expect(controller.gestureMoved()).toBe(false);
});

test("keeps a single-card frame's per-card pluses", () => {
  const { controller } = setup([node("a", 100, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(350, 220);
  controller.up(350, 220);
  expect(controller.multiFrame()).toBe(false);

  controller.hover(316, 142);
  expect(controller.portPlus()).not.toBeNull();
  expect(controller.cursor()).toBe("crosshair");
});
