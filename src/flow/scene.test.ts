import { expect, test } from "nsh/test";
import { App, Box, Group, Line } from "@leafer-ui/miniapp";
import "@leafer-in/editor";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import { installNshPlatform, NshCanvasSurface } from "../leafer/nsh-platform";
import { FlowScene } from "./scene";

function node(id: string, x: number, y: number): NodeSummary {
  return {
    id,
    kind: "panel",
    title: id,
    x,
    y,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: JSON.stringify({ subtitle: id, accent: "chart-1" }),
  };
}

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return {
    id,
    fromId,
    toId,
    fromPort: null,
    toPort: null,
    kind: "flow",
    dataJson: "{}",
  };
}

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

function appWithScene(): { app: App; view: NshCanvasSurface; scene: FlowScene } {
  installNshPlatform();
  const view = new NshCanvasSurface(800, 600, false);
  const app = new App({
    view,
    width: 800,
    height: 600,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const scene = new FlowScene(app);
  app.start();
  return { app, view, scene };
}

function connectorLine(scene: FlowScene): Line {
  const layer = scene.world.children[0];
  if (!(layer instanceof Group)) throw new Error("The edge layer is not a group.");
  const line = layer.children.find((child): child is Line => child instanceof Line);
  if (!line) throw new Error("The scene has no connector line.");
  return line;
}

test("renders the viewport nodes and their edges", () => {
  const { app, scene } = appWithScene();

  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));
  app.tree.updateLayout();

  expect(scene.card("a") instanceof Box).toBe(true);
  expect(scene.card("b") instanceof Box).toBe(true);
  expect(scene.edgeCount()).toBe(1);
  expect(connectorLine(scene).visible).toBe(true);

  // Panning the viewport away from `b` removes its card and the edge.
  scene.apply(snapshot([node("a", 40, 40)]));
  app.tree.updateLayout();
  expect(scene.card("b")).toBeNull();
  expect(scene.edgeCount()).toBe(0);
  expect(scene.world.children.length).toBe(2);

  app.destroy();
});

test("caps a low-zoom snapshot and keeps a selected card", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40), node("c", 680, 40)]), {
    maxCards: 2,
  });

  expect(scene.card("a") instanceof Box).toBe(true);
  expect(scene.card("b") instanceof Box).toBe(true);
  expect(scene.card("c")).toBeNull();

  const a = scene.card("a");
  if (!(a instanceof Box)) throw new Error("The selected card was not built.");
  app.editor.select([a]);

  // A snapshot that no longer contains `a` must not drop the selection.
  scene.apply(snapshot([node("b", 360, 40), node("c", 680, 40)]), { maxCards: 2 });
  expect(scene.card("a") === a).toBe(true);

  app.editor.cancel();
  scene.apply(snapshot([node("b", 360, 40), node("c", 680, 40)]), { maxCards: 2 });
  expect(scene.card("a")).toBeNull();

  app.destroy();
});

test("does not persist editor transforms the document cannot store", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  app.tree.updateLayout();

  const card = scene.card("a");
  if (!(card instanceof Box)) throw new Error("The card was not built.");
  card.rotation = 30;
  card.scaleX = -1;
  card.skewX = 10;
  app.tree.updateLayout();

  // Rotation, skew and negative scale are not in the document model; the
  // committed geometry must stay the card's logical box, not its AABB.
  expect(scene.commitBounds()).toEqual([]);

  app.destroy();
});

test("creates a card from a change set the viewport cap did not include", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  expect(scene.card("new")).toBeNull();

  scene.applyChangeSet({
    changed: [node("new", 360, 40)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });

  expect(scene.card("new") instanceof Box).toBe(true);
  app.destroy();
});

test("keeps a connector while both endpoints stay selected", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));
  app.tree.updateLayout();

  const a = scene.card("a");
  const b = scene.card("b");
  if (!(a instanceof Box) || !(b instanceof Box)) throw new Error("Cards were not built.");
  app.editor.select([a, b]);

  // Both cards are pinned even though the snapshot returns neither; their
  // connector must survive too.
  scene.apply(snapshot([]));
  app.tree.updateLayout();
  expect(scene.card("a") === a).toBe(true);
  expect(scene.card("b") === b).toBe(true);
  expect(scene.edgeCount()).toBe(1);

  app.editor.cancel();
  scene.apply(snapshot([]));
  app.tree.updateLayout();
  expect(scene.edgeCount()).toBe(0);

  app.destroy();
});

test("caps a large viewport snapshot instead of building every card", () => {
  const { app, scene } = appWithScene();
  const nodes = Array.from({ length: 1_000 }, (_, index) => node(`n${index}`, index * 220, 0));

  scene.apply(snapshot(nodes), { maxCards: 300 });

  expect(scene.cardCount()).toBe(300);
  expect(scene.card("n0") instanceof Box).toBe(true);
  expect(scene.card("n999")).toBeNull();

  app.destroy();
});

test("updates a card in place and reports the gesture's bounds", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  app.tree.updateLayout();

  const card = scene.card("a");
  if (!(card instanceof Box)) throw new Error("The card was not built.");

  card.x = 100;
  card.width = 240;
  app.tree.updateLayout();

  expect(scene.commitBounds()).toEqual([{ id: "a", x: 100, y: 40, width: 240, height: 84 }]);

  scene.applyChangeSet({
    changed: [{ ...node("a", 100, 40), width: 240 }],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(scene.card("a") === card).toBe(true);
  expect(scene.commitBounds()).toEqual([]);

  app.destroy();
});

test("keeps a connector attached when its card moves", () => {
  const { app, scene } = appWithScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));
  app.tree.updateLayout();

  const line = connectorLine(scene);
  const before = line.points?.slice() ?? [];

  const card = scene.card("a");
  if (!(card instanceof Box)) throw new Error("The card was not built.");
  card.x = Number(card.x) + 1000;
  app.tree.updateLayout();

  expect(line.points ?? []).not.toEqual(before);

  app.destroy();
});
