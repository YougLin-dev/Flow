import { expect, test } from "nsh/test";
import {
  edge,
  menuWith,
  node,
  sceneWithCard,
  sceneWithEdge,
} from "../../../flow/canvas/interaction/test/menu-fixtures";
import { dismissContextMenuOnChange } from "./flow-effects";

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
