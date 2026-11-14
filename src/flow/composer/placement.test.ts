import { expect, test } from "nsh/test";
import { CanvasCamera } from "../canvas";
import { composerAnchor, composerPlacement } from "./placement";

const STAGE = { width: 800, height: 600 };

test("places the composer directly under the card", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 100, y: 100, width: 200, height: 100 }, camera, 360);
  expect(anchor).toEqual({ left: 20, top: 210 });
});

test("keeps the composer below a card at the bottom of the stage", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 100, y: 350, width: 200, height: 100 }, camera, 240);
  // The card leaves little room below it, but the panel still opens there
  // instead of flipping above it.
  expect(anchor).toEqual({ left: 80, top: 460 });
});

test("does not shift the composer to stay inside the stage", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 0, y: 0, width: 100, height: 100 }, camera, 360);
  // Centred on the card, even though the panel extends past the left edge.
  expect(anchor).toEqual({ left: -130, top: 110 });
});

test("follows the camera's pan and zoom", () => {
  const camera = new CanvasCamera();
  camera.x = 50;
  camera.y = 20;
  camera.scale = 2;
  const anchor = composerAnchor({ x: 10, y: 10, width: 100, height: 50 }, camera, 300);
  expect(anchor).toEqual({ left: 20, top: 150 });
});

test("the composer placement hides during a gesture or without a card", () => {
  const camera = new CanvasCamera();
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  expect(composerPlacement("a", true, () => rect, camera, STAGE)).toBe(null);
  expect(composerPlacement(null, false, () => rect, camera, STAGE)).toBe(null);
  expect(composerPlacement("missing", false, () => null, camera, STAGE)).toBe(null);
  expect(composerPlacement("a", false, () => rect, camera, STAGE)).toEqual({
    left: 20,
    top: 210,
    width: 360,
  });
});
