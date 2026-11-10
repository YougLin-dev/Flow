import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";
import { cursorForHandle, handleAtPoint, screenRect } from "./resize-handles";
import { FlowScene } from "./scene";
import type { ResizeHandle } from "./selection";

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

function setup(nodes: NodeSummary[]): { scene: FlowScene; camera: CanvasCamera } {
  const scene = new FlowScene();
  const snapshot: SceneSnapshot = { rev: 1, nodes, edges: [] };
  scene.apply(snapshot);
  return { scene, camera: new CanvasCamera() };
}

test("screenRect projects a card's world rect through the camera", () => {
  const { scene, camera } = setup([node("a", 40, 60)]);
  camera.x = 10;
  camera.y = 20;
  camera.scale = 2;

  expect(screenRect(scene, camera, "a")).toEqual({ x: 90, y: 140, width: 400, height: 168 });
  expect(screenRect(scene, camera, "missing")).toBeNull();
});

test("handleAtPoint picks the handle of the card under the point", () => {
  const { scene, camera } = setup([node("a", 40, 40)]);
  const corners: readonly { x: number; y: number; side: ResizeHandle }[] = [
    { x: 40, y: 40, side: "nw" },
    { x: 240, y: 40, side: "ne" },
    { x: 240, y: 124, side: "se" },
    { x: 40, y: 124, side: "sw" },
  ];

  for (const corner of corners) {
    expect(handleAtPoint(scene, camera, scene.nodes(), corner.x, corner.y)).toEqual({
      id: "a",
      side: corner.side,
    });
  }
  expect(handleAtPoint(scene, camera, scene.nodes(), 140, 82)).toBeNull();
});

test("handleAtPoint prefers the card under the point over a handle that reaches through", () => {
  const { scene, camera } = setup([node("a", 0, 0), node("b", 180, 60)]);

  // (200, 84) is card a's bottom-right handle but lies inside card b's body.
  expect(handleAtPoint(scene, camera, scene.nodes(), 200, 84)).toBeNull();
});

test("handleAtPoint falls back to the topmost handle in reach when no card is under the point", () => {
  const { scene, camera } = setup([node("low", 0, 0), node("high", 8, 8, { z: 1 })]);

  // The point is outside both cards but within both southeast handles' reach.
  expect(handleAtPoint(scene, camera, scene.nodes(), 203, 87)).toEqual({
    id: "high",
    side: "se",
  });
});

test("cursorForHandle maps each side to its CSS cursor", () => {
  const cursors: ReadonlyMap<ResizeHandle, string> = new Map([
    ["nw", "nwse-resize"],
    ["se", "nwse-resize"],
    ["ne", "nesw-resize"],
    ["sw", "nesw-resize"],
    ["n", "ns-resize"],
    ["s", "ns-resize"],
    ["e", "ew-resize"],
    ["w", "ew-resize"],
  ]);

  for (const [handle, cursor] of cursors) expect(cursorForHandle(handle)).toBe(cursor);
});
