import { expect, test } from "nsh/test";
import { MinimapController } from "./minimap-controller";

function record(): {
  controller: MinimapController;
  centers: Array<[number, number]>;
} {
  const centers: Array<[number, number]> = [];
  return {
    controller: new MinimapController((x, y) => centers.push([x, y])),
    centers,
  };
}

const START = { point: { x: 10, y: 10 }, center: { x: 100, y: 50 }, scale: 0.25 };

test("a press alone does not move the camera", () => {
  const { controller, centers } = record();

  controller.start(START);
  expect(controller.dragging()).toBe(true);
  expect(centers).toEqual([]);

  controller.end();
  expect(controller.dragging()).toBe(false);
});

test("moving a drag centers the camera by the pointer delta", () => {
  const { controller, centers } = record();
  controller.start(START);

  controller.move({ x: 30, y: 20 });
  expect(centers).toEqual([[180, 90]]);

  controller.move({ x: 0, y: 10 });
  expect(centers).toEqual([
    [180, 90],
    [60, 50],
  ]);
});

test("moves without a drag and a non-positive scale do nothing", () => {
  const { controller, centers } = record();

  controller.move({ x: 1, y: 1 });
  controller.start({ ...START, scale: 0 });
  controller.move({ x: 1, y: 1 });

  expect(centers).toEqual([]);
  expect(controller.dragging()).toBe(false);
});
