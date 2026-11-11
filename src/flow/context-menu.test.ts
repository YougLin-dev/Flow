import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";
import { CanvasController } from "./canvas-controller";
import {
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_WIDTH,
  CanvasMenuController,
  type ContextMenuPress,
  contextMenuPosition,
} from "./context-menu";
import { FlowScene } from "./scene";

const STAGE = { width: 900, height: 700 };

function press(x: number, y: number): ContextMenuPress {
  return { x, y, worldX: 0, worldY: 0 };
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

function menuWith(): { menu: CanvasMenuController; controller: CanvasController } {
  const scene = new FlowScene();
  const camera = new CanvasCamera();
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
    addNode: () => undefined,
  });
  return { menu, controller };
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
