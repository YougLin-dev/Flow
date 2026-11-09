import { expect, test } from "nsh/test";
import {
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_WIDTH,
  type ContextMenuPress,
  contextMenuPosition,
} from "./context-menu";

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
