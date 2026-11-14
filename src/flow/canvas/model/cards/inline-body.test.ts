import { expect, test } from "nsh/test";
import { CanvasCamera } from "../camera";
import { inlineBodyBox } from "./inline-body";

test("anchors the in-place editor at the card body's world box", () => {
  const camera = new CanvasCamera();
  const rect = { x: 100, y: 50, width: 300, height: 220 };
  expect(inlineBodyBox(rect, camera)).toEqual({
    left: 116,
    top: 66,
    width: 268,
    height: 188,
    scale: 1,
  });

  // The editor lays out at this world size and type; the camera's scale
  // grows it, as it grows the card's own text, with no font rounding.
  camera.x = 40;
  camera.y = -10;
  camera.scale = 2;
  expect(inlineBodyBox(rect, camera)).toEqual({
    left: 272,
    top: 122,
    width: 268,
    height: 188,
    scale: 2,
  });
});
