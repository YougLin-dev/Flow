import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";
import { screenRectOf } from "./screen-rect";

test("screenRectOf projects a world rect through the camera", () => {
  const camera = new CanvasCamera();
  camera.x = 10;
  camera.y = 20;
  camera.scale = 2;

  expect(screenRectOf(camera, { x: 40, y: 60, width: 200, height: 84 })).toEqual({
    x: 90,
    y: 140,
    width: 400,
    height: 168,
  });
});
