import { expect, test } from "nsh/test";
import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "../model/camera";
import { FlowScene } from "../model/scene/scene";
import { canvasHit } from "./hit-priority";

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

function snapshot(nodes: NodeSummary[]): SceneSnapshot {
  return { rev: 1, nodes, edges: [] };
}

function setup(nodes: NodeSummary[]): FlowScene {
  const scene = new FlowScene();
  scene.apply(snapshot(nodes));
  return scene;
}

test("a typed port beats the resize handle it overlaps", () => {
  const scene = setup([node("a", 100, 100)]);
  const hit = canvasHit({
    scene,
    camera: new CanvasCamera(),
    x: 305,
    y: 142,
    framed: false,
    frameBounds: null,
  });

  expect(hit.kind).toBe("port");
  // The point is just outside the card's east border, past the port icon.
  expect(hit.card).toBeNull();
});

test("a press inside a marquee frame is the frame's drag surface", () => {
  const scene = setup([node("a", 0, 0), node("b", 300, 0)]);
  scene.select(["a", "b"]);
  const camera = new CanvasCamera();
  const bounds = scene.selectionBounds();
  if (bounds === null) throw new Error("the selection has no bounds");

  const gap = canvasHit({ scene, camera, x: 250, y: 42, framed: true, frameBounds: bounds });
  expect(gap.kind).toBe("frame");
  expect(gap.card).toBeNull();
  expect(gap.insideFrame).toBe(true);

  // The card under the pointer is carried for the double-click override.
  const overCard = canvasHit({ scene, camera, x: 350, y: 50, framed: true, frameBounds: bounds });
  expect(overCard.kind).toBe("frame");
  expect(overCard.card).toBe("b");
  expect(overCard.insideFrame).toBe(true);
});

test("a handle outside a card reports the card under the pointer separately", () => {
  const scene = setup([node("a", 100, 100)]);
  const hit = canvasHit({
    scene,
    camera: new CanvasCamera(),
    x: 305,
    y: 189,
    framed: false,
    frameBounds: null,
  });

  expect(hit.kind).toBe("handle");
  if (hit.kind !== "handle") return;
  expect(hit.id).toBe("a");
  // The handle reaches outside the card; no card is under that point.
  expect(hit.card).toBeNull();
});

test("a card border reports both the card and the handle", () => {
  const scene = setup([node("a", 0, 0)]);
  const hit = canvasHit({
    scene,
    camera: new CanvasCamera(),
    x: 200,
    y: 75,
    framed: false,
    frameBounds: null,
  });

  expect(hit.kind).toBe("handle");
  if (hit.kind !== "handle") return;
  expect(hit.id).toBe("a");
  expect(hit.card).toBe("a");
});

test("empty canvas is its own hit", () => {
  const scene = setup([node("a", 0, 0)]);
  const hit = canvasHit({
    scene,
    camera: new CanvasCamera(),
    x: 500,
    y: 500,
    framed: false,
    frameBounds: null,
  });

  expect(hit.kind).toBe("empty");
  expect(hit.card).toBeNull();
});
