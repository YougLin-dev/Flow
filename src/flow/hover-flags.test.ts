import { effect } from "nsh";
import { expect, test } from "nsh/test";
import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "./camera";
import { CanvasController } from "./canvas-controller";
import { FlowScene } from "./scene";

function setup(): CanvasController {
  const nodes = [0, 300, 700].map((x, index): NodeSummary => ({
    id: ["a", "b", "c"][index] ?? "",
    kind: "text",
    title: "card",
    body: "body",
    x,
    y: 0,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
  }));
  const snapshot: SceneSnapshot = { rev: 1, nodes, edges: [] };
  const scene = new FlowScene();
  scene.apply(snapshot);
  const camera = new CanvasCamera();
  return new CanvasController({
    scene: () => scene,
    camera: () => camera,
    tool: () => "select",
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: (id) => scene.selectEdge(id),
    reconnectEdge: () => undefined,
    connectNodes: () => undefined,
    openInline: () => undefined,
    onCardPress: () => undefined,
  });
}

test("hovering a card flips only that card's flag", () => {
  const controller = setup();
  controller.hover(100, 30);
  let runsA = 0;
  let runsB = 0;
  let runsC = 0;
  effect(() => {
    controller.flags.isHovered("a");
    runsA += 1;
  });
  effect(() => {
    controller.flags.isHovered("b");
    runsB += 1;
  });
  effect(() => {
    controller.flags.isHovered("c");
    runsC += 1;
  });

  controller.hover(400, 30);
  expect(controller.flags.isHovered("a")).toBe(false);
  expect(controller.flags.isHovered("b")).toBe(true);
  expect(controller.flags.isHovered("c")).toBe(false);
  expect([runsA, runsB, runsC]).toEqual([2, 2, 1]);
});

test("a marquee preview flips only the covered cards' flags", () => {
  const controller = setup();
  controller.down(-50, -50, false, 1);
  controller.move(550, 250);
  expect(controller.flags.isPreviewed("a")).toBe(true);
  expect(controller.flags.isPreviewed("b")).toBe(true);
  expect(controller.flags.isPreviewed("c")).toBe(false);

  controller.up(550, 250);
  expect(controller.flags.isPreviewed("a")).toBe(false);
  expect(controller.flags.isPreviewed("b")).toBe(false);
});

test("clearing the preview wakes only the cards that left it", () => {
  const controller = setup();
  let runsA = 0;
  let runsB = 0;
  let runsC = 0;
  effect(() => {
    controller.flags.isPreviewed("a");
    runsA += 1;
  });
  effect(() => {
    controller.flags.isPreviewed("b");
    runsB += 1;
  });
  effect(() => {
    controller.flags.isPreviewed("c");
    runsC += 1;
  });

  controller.down(-50, -50, false, 1);
  controller.move(550, 250);
  expect([runsA, runsB, runsC]).toEqual([2, 2, 1]);
  controller.cancel();
  expect([runsA, runsB, runsC]).toEqual([3, 3, 1]);
});
