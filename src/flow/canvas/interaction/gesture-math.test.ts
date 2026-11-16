import { expect, test } from "nsh/test";
import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "../model/camera";
import { FlowScene } from "../model/scene/scene";
import {
  draggedRects,
  dragPastThreshold,
  marqueeIds,
  marqueeIsClick,
  marqueeWorldRect,
  resizePastThreshold,
} from "./gesture-math";

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

function snapshot(nodes: NodeSummary[]): SceneSnapshot {
  return { rev: 1, nodes, edges: [] };
}

test("a drag passes the threshold past two screen points", () => {
  expect(dragPastThreshold(0, 0, 2, 0)).toBe(false);
  expect(dragPastThreshold(0, 0, 2.01, 0)).toBe(true);
});

test("a resize passes the threshold past two points on either axis", () => {
  expect(resizePastThreshold(0, 0, 2, 2)).toBe(false);
  expect(resizePastThreshold(0, 0, 2.01, 0)).toBe(true);
  expect(resizePastThreshold(0, 0, 0, -2.01)).toBe(true);
});

test("a drag step translates every press-time rect", () => {
  const base = new Map([
    ["a", { x: 10, y: 20, width: 200, height: 84 }],
    ["b", { x: 300, y: 20, width: 200, height: 84 }],
  ]);

  const next = draggedRects(base, 5, -3);
  expect([...next]).toEqual([
    ["a", { x: 15, y: 17, width: 200, height: 84 }],
    ["b", { x: 305, y: 17, width: 200, height: 84 }],
  ]);
  // The press-time map stays the gesture's baseline.
  expect(base.get("a")?.x).toBe(10);
});

test("a marquee box under one point is a click", () => {
  expect(marqueeIsClick({ x: 5, y: 5, width: 0, height: 0 })).toBe(true);
  expect(marqueeIsClick({ x: 5, y: 5, width: 1, height: 0 })).toBe(false);
});

test("a marquee's screen box converts to world coordinates", () => {
  const camera = new CanvasCamera();
  camera.x = 10;
  camera.y = 20;
  camera.scale = 2;

  expect(marqueeWorldRect(camera, { x: 5, y: 10, width: 100, height: 50 })).toEqual({
    x: -2.5,
    y: -5,
    width: 50,
    height: 25,
  });
});

test("an additive marquee keeps the selected order and adds covered cards once", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));
  scene.select(["b"]);

  expect(marqueeIds(scene, { x: -10, y: -10, width: 520, height: 110 }, true)).toEqual(["b", "a"]);
});

test("a fresh marquee takes scene order", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));
  scene.select(["b"]);

  expect(marqueeIds(scene, { x: -10, y: -10, width: 520, height: 110 }, false)).toEqual(["a", "b"]);
});
