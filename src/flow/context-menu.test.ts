import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary } from "@flow/native";
import { CanvasCamera } from "./camera";
import { CanvasController } from "./canvas-controller";
import {
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_WIDTH,
  CanvasMenuController,
  type ContextMenuPress,
  contextMenuPosition,
  dismissContextMenuOnChange,
} from "./context-menu";
import { FlowScene } from "./scene";

const STAGE = { width: 900, height: 700 };

function press(x: number, y: number): ContextMenuPress {
  return { x, y, worldX: 0, worldY: 0, nodeId: null, edgeId: null };
}

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
    toOffset: 28,
    kind: "flow",
    dataJson: "{}",
  };
}

test("opens the menu at the press", () => {
  expect(contextMenuPosition(press(120, 90), STAGE)).toEqual({ left: 120, top: 90 });
});

test("keeps the menu inside the stage at every edge", () => {
  expect(contextMenuPosition(press(880, 690), STAGE)).toEqual({
    left: STAGE.width - CONTEXT_MENU_WIDTH - 8,
    top: STAGE.height - CONTEXT_MENU_HEIGHT - 8,
  });
  expect(contextMenuPosition(press(-20, -20), STAGE)).toEqual({ left: 8, top: 8 });
});

function menuWith(scene = new FlowScene()): {
  menu: CanvasMenuController;
  controller: CanvasController;
  camera: CanvasCamera;
  actions: string[];
} {
  const camera = new CanvasCamera();
  const actions: string[] = [];
  const controller = new CanvasController({
    scene: () => scene,
    camera: () => camera,
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: () => undefined,
    reconnectEdge: () => undefined,
    connectNodes: () => undefined,
    openInline: () => undefined,
    onCardPress: () => undefined,
  });
  const menu = new CanvasMenuController({
    camera: () => camera,
    controller: () => controller,
    scene: () => scene,
    addNode: (kind) => actions.push(`add:${kind}`),
    copyNode: (id) => actions.push(`copy:${id}`),
    deleteNode: (id) => actions.push(`delete:${id}`),
    selectEdge: (id) => {
      scene.selectEdge(id);
      scene.select([]);
    },
    deleteEdge: (id) => actions.push(`delete-edge:${id}`),
  });
  return { menu, controller, camera, actions };
}

test("opens a secondary press's menu on its release, not on the press", () => {
  const { menu } = menuWith();
  menu.press({ x: 40, y: 50 });
  expect(menu.open()).toBe(null);

  menu.release();
  expect(menu.open()?.x).toBe(40);
  expect(menu.open()?.y).toBe(50);
});

test("a drag after a secondary press pans and leaves no menu", () => {
  const { menu, controller } = menuWith();
  menu.press({ x: 10, y: 10 });
  expect(controller.right.move(60, 60)).toBe(true);
  expect(controller.right.dragging()).toBe(true);

  menu.release();
  expect(menu.open()).toBe(null);
  expect(controller.right.active()).toBe(false);
});

test("a move without its button releases a press the host did not report", () => {
  const { menu } = menuWith();
  menu.press({ x: 10, y: 10 });
  menu.move(12, 11, false);

  expect(menu.open()).not.toBe(null);
  expect(menu.open()?.x).toBe(10);
});

test("a secondary press on the open menu re-anchors it", () => {
  const { menu } = menuWith();
  menu.press({ x: 10, y: 10 });
  menu.release();
  expect(menu.open()?.x).toBe(10);

  menu.press({ x: 30, y: 40 });
  expect(menu.open()?.x).toBe(30);
  expect(menu.open()?.y).toBe(40);
});

function sceneWithCard(): FlowScene {
  const scene = new FlowScene();
  scene.apply({ rev: 1, nodes: [node("card", 40, 40)], edges: [] });
  return scene;
}

test("a press on a card opens that card's own menu", () => {
  const { menu } = menuWith(sceneWithCard());
  menu.press({ x: 60, y: 60 });
  menu.release();

  expect(menu.open()?.nodeId).toBe("card");
});

test("a press on a card's title row opens its menu too", () => {
  const { menu } = menuWith(sceneWithCard());
  // The card starts at y = 40; its title row sits in the band above it.
  menu.press({ x: 60, y: 20 });
  menu.release();

  expect(menu.open()?.nodeId).toBe("card");
});

test("a press on a card's port disc opens its menu too", () => {
  const { menu } = menuWith(sceneWithCard());
  // The text card's single output port sits 14 points past the body's right
  // edge, halfway down its 84-point height.
  menu.press({ x: 254, y: 82 });
  menu.release();

  expect(menu.open()?.nodeId).toBe("card");
});

test("a press on empty canvas opens the canvas menu", () => {
  const { menu } = menuWith(sceneWithCard());
  menu.press({ x: 400, y: 400 });
  menu.release();

  expect(menu.open()?.nodeId).toBe(null);
});

test("deleting one card of a multiple selection clears it", () => {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("one", 40, 40), node("two", 300, 40)],
    edges: [],
  });
  scene.select(["one", "two"]);
  const { menu, actions } = menuWith(scene);
  menu.press({ x: 60, y: 60 });
  menu.release();
  const open = menu.open();
  if (open === null) throw new Error("the card menu did not open");

  menu.deleteCard(open);
  expect(actions).toEqual(["delete:one"]);
  expect(scene.selection()).toEqual([]);
});

test("opening a card's menu selects that card", () => {
  const scene = sceneWithCard();
  const { menu } = menuWith(scene);
  menu.press({ x: 60, y: 60 });
  // Selection follows the menu opening, not the press that may become a pan.
  expect(scene.selection()).toEqual([]);
  menu.release();

  expect(scene.selection()).toEqual(["card"]);
});

test("opening a card's menu keeps a multiple selection it belongs to", () => {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("one", 40, 40), node("two", 300, 40)],
    edges: [],
  });
  scene.select(["one", "two"]);
  const { menu } = menuWith(scene);
  menu.press({ x: 60, y: 60 });
  menu.release();

  expect(scene.selection()).toEqual(["one", "two"]);
});

test("opening the canvas menu on empty canvas keeps the selection", () => {
  const scene = sceneWithCard();
  scene.select(["card"]);
  const { menu } = menuWith(scene);
  menu.press({ x: 400, y: 400 });
  menu.release();

  expect(scene.selection()).toEqual(["card"]);
});

test("a right drag does not select the card it started on", () => {
  const scene = sceneWithCard();
  const { menu, controller } = menuWith(scene);
  menu.press({ x: 60, y: 60 });
  expect(controller.right.move(160, 60)).toBe(true);
  menu.release();

  expect(scene.selection()).toEqual([]);
  expect(menu.open()).toBe(null);
});

test("re-anchoring the menu on another card selects it", () => {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("one", 40, 40), node("two", 300, 40)],
    edges: [],
  });
  const { menu } = menuWith(scene);
  menu.press({ x: 60, y: 60 });
  menu.release();
  expect(scene.selection()).toEqual(["one"]);

  menu.press({ x: 320, y: 60 });
  menu.release();
  expect(scene.selection()).toEqual(["two"]);
});

test("a secondary press on page chrome pans without opening a menu", () => {
  const { menu, controller } = menuWith(sceneWithCard());
  menu.pressChrome({ x: 60, y: 60 });
  expect(controller.right.active()).toBe(true);
  expect(menu.open()).toBe(null);

  expect(controller.right.move(120, 60)).toBe(true);
  menu.release();
  expect(menu.open()).toBe(null);
});

test("dismisses the card menu when its card moves", () => {
  const scene = sceneWithCard();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 60, y: 60 });
  menu.release();
  expect(menu.open()?.nodeId).toBe("card");

  // Another command (an undo, say) moves the card out from under the menu.
  scene.apply({ rev: 2, nodes: [node("card", 200, 200)], edges: [] });
  expect(menu.open()).toBe(null);
});

test("dismisses the card menu when its card leaves the scene", () => {
  const scene = sceneWithCard();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 60, y: 60 });
  menu.release();

  // A command (undo, another delete) removes the selected card; a viewport
  // snapshot would pin it instead.
  scene.applyChangeSet({ changed: [], removed: ["card"], edgesChanged: [], edgesRemoved: [] });
  expect(menu.open()).toBe(null);
});

test("dismisses the card menu when the camera moves", () => {
  const scene = sceneWithCard();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 60, y: 60 });
  menu.release();

  camera.panBy(40, 40);
  expect(menu.open()).toBe(null);
});

test("copying from a card's menu copies that card", () => {
  const { menu, actions } = menuWith(sceneWithCard());
  menu.press({ x: 60, y: 60 });
  menu.release();
  const open = menu.open();
  if (open === null) throw new Error("the card menu did not open");

  menu.copyCard(open);
  expect(actions).toEqual(["copy:card"]);
  expect(menu.open()).toBe(null);
});

test("deleting from a card's menu deletes that card", () => {
  const { menu, actions } = menuWith(sceneWithCard());
  menu.press({ x: 60, y: 60 });
  menu.release();
  const open = menu.open();
  if (open === null) throw new Error("the card menu did not open");

  menu.deleteCard(open);
  expect(actions).toEqual(["delete:card"]);
  expect(menu.open()).toBe(null);
});

/** Two text cards joined by one connector; its curve passes (320, 75). */
function sceneWithEdge(): FlowScene {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("source", 40, 40), node("target", 400, 40)],
    edges: [edge("line", "source", "target")],
  });
  return scene;
}

test("a press on a connector opens its menu and selects it", () => {
  const scene = sceneWithEdge();
  const { menu } = menuWith(scene);
  // Between the two cards, on the cubic: the output sits at (254, 82) and the
  // input at (386, 68), halfway between them.
  menu.press({ x: 320, y: 75 });
  menu.release();

  expect(menu.open()?.edgeId).toBe("line");
  expect(menu.open()?.nodeId).toBe(null);
  expect(scene.selectedEdge()).toBe("line");
  expect(scene.selection()).toEqual([]);
});

test("opening a connector's menu drops the card selection", () => {
  const scene = sceneWithEdge();
  scene.select(["target"]);
  const { menu } = menuWith(scene);
  menu.press({ x: 320, y: 75 });
  menu.release();

  expect(scene.selection()).toEqual([]);
  expect(scene.selectedEdge()).toBe("line");
});

test("a card over a connector takes the press", () => {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("source", 0, 0), node("target", 400, 0), node("cover", 150, 0)],
    edges: [edge("line", "source", "target")],
  });
  const { menu } = menuWith(scene);
  // The connector runs through the covering card at (300, 42).
  menu.press({ x: 300, y: 42 });
  menu.release();

  expect(menu.open()?.nodeId).toBe("cover");
  expect(menu.open()?.edgeId).toBe(null);
});

test("deleting from a connector's menu deletes that connector", () => {
  const { menu, actions } = menuWith(sceneWithEdge());
  menu.press({ x: 320, y: 75 });
  menu.release();
  const open = menu.open();
  if (open === null) throw new Error("the connector menu did not open");

  menu.deleteEdge(open);
  expect(actions).toEqual(["delete-edge:line"]);
  expect(menu.open()).toBe(null);
});

test("dismisses a connector's menu when the connector leaves the scene", () => {
  const scene = sceneWithEdge();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 320, y: 75 });
  menu.release();
  expect(menu.open()?.edgeId).toBe("line");

  scene.applyChangeSet({ changed: [], removed: [], edgesChanged: [], edgesRemoved: ["line"] });
  expect(menu.open()).toBe(null);
});

test("dismisses a connector's menu when an endpoint card moves", () => {
  const scene = sceneWithEdge();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 320, y: 75 });
  menu.release();
  expect(menu.open()?.edgeId).toBe("line");

  // Another command (an undo, say) moves the source; the curve no longer
  // passes under the menu's anchor.
  scene.apply({
    rev: 2,
    nodes: [node("source", 40, 200), node("target", 400, 40)],
    edges: [edge("line", "source", "target")],
  });
  expect(menu.open()).toBe(null);
});

test("dismisses a connector's menu when the camera moves", () => {
  const scene = sceneWithEdge();
  const { menu, camera } = menuWith(scene);
  dismissContextMenuOnChange(menu, camera, scene);
  menu.press({ x: 320, y: 75 });
  menu.release();

  camera.panBy(40, 40);
  expect(menu.open()).toBe(null);
});
