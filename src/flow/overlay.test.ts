import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";
import { composerAnchor, inlineAnchor } from "./overlay";

const STAGE = { width: 800, height: 600 };

test("places the composer under the card when it fits", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 100, y: 100, width: 200, height: 100 }, camera, STAGE, {
    width: 360,
    height: 300,
  });
  expect(anchor).toEqual({ left: 20, top: 210 });
});

test("moves the composer above a card at the bottom", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 100, y: 350, width: 200, height: 100 }, camera, STAGE, {
    width: 240,
    height: 200,
  });
  expect(anchor).toEqual({ left: 80, top: 140 });
});

test("moves the composer beside a tall card", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor({ x: 100, y: 100, width: 200, height: 500 }, camera, STAGE, {
    width: 240,
    height: 200,
  });
  expect(anchor).toEqual({ left: 310, top: 100 });
});

test("clamps the composer into the stage", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor(
    { x: 0, y: 0, width: 100, height: 100 },
    camera,
    { width: 300, height: 300 },
    { width: 360, height: 200 },
  );
  expect(anchor).toEqual({ left: 8, top: 92 });
});

test("follows the camera's pan and zoom", () => {
  const camera = new CanvasCamera();
  camera.x = 50;
  camera.y = 20;
  camera.scale = 2;
  const anchor = composerAnchor(
    { x: 10, y: 10, width: 100, height: 50 },
    camera,
    { width: 900, height: 700 },
    { width: 300, height: 200 },
  );
  expect(anchor).toEqual({ left: 20, top: 150 });
});

test("falls back to the roomiest side when nothing fits", () => {
  const camera = new CanvasCamera();
  const anchor = composerAnchor(
    { x: 300, y: 190, width: 300, height: 220 },
    camera,
    { width: 900, height: 600 },
    { width: 360, height: 493 },
  );
  // Right has more room than below/above; the panel is clamped to the stage.
  expect(anchor).toEqual({ left: 532, top: 99 });
});

test("lays the inline editor inside the card body", () => {
  const camera = new CanvasCamera();
  const anchor = inlineAnchor({ x: 100, y: 100, width: 300, height: 220 }, camera, STAGE);
  expect(anchor).toEqual({ left: 112, top: 148, width: 276, height: 156 });
});

test("clamps the inline editor on a small stage", () => {
  const camera = new CanvasCamera();
  const anchor = inlineAnchor({ x: 100, y: 100, width: 300, height: 220 }, camera, {
    width: 200,
    height: 140,
  });
  expect(anchor).toEqual({ left: 8, top: 8, width: 184, height: 124 });
});
