import { expect, test } from "nsh/test";
import { CanvasCamera } from "./camera";
import { CanvasController } from "./canvas-controller";
import { RIGHT_DRAG_THRESHOLD, RightGesture } from "./right-gesture";
import { FlowScene } from "./scene";

type Call =
  | { readonly kind: "begin"; readonly x: number; readonly y: number }
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "end"; readonly x: number; readonly y: number };

function setup(startable = true): {
  gesture: RightGesture;
  calls: Call[];
  allow: (value: boolean) => void;
} {
  const calls: Call[] = [];
  let allowed = startable;
  const gesture = new RightGesture({
    canStart: () => allowed,
    beginPan: (x, y) => calls.push({ kind: "begin", x, y }),
    panTo: (x, y) => calls.push({ kind: "move", x, y }),
    endPan: (x, y) => calls.push({ kind: "end", x, y }),
  });
  return {
    gesture,
    calls,
    allow: (value) => {
      allowed = value;
    },
  };
}

test("does not pan until a right press moves past its threshold", () => {
  const { gesture, calls } = setup();
  expect(gesture.down(100, 100)).toBe(true);
  expect(gesture.move(100 + RIGHT_DRAG_THRESHOLD, 100)).toBe(false);
  expect(calls).toEqual([]);

  // The threshold move pans from the press, so no movement is lost.
  expect(gesture.move(100 + RIGHT_DRAG_THRESHOLD + 1, 100)).toBe(true);
  expect(calls).toEqual([
    { kind: "begin", x: 100, y: 100 },
    { kind: "move", x: 100 + RIGHT_DRAG_THRESHOLD + 1, y: 100 },
  ]);
});

test("keeps panning after the drag starts and ends where the button was seen", () => {
  const { gesture, calls } = setup();
  gesture.down(0, 0);
  gesture.move(10, 0);
  expect(gesture.move(20, 30)).toBe(false);
  expect(calls[calls.length - 1]).toEqual({ kind: "move", x: 20, y: 30 });

  gesture.end();
  expect(calls[calls.length - 1]).toEqual({ kind: "end", x: 20, y: 30 });
  expect(gesture.active()).toBe(false);
});

test("leaves a still press for the menu", () => {
  const { gesture, calls } = setup();
  gesture.down(40, 50);
  gesture.end();
  expect(calls).toEqual([]);
});

test("a new right press supersedes a pan whose release was never reported", () => {
  const { gesture, calls } = setup();
  gesture.down(0, 0);
  expect(gesture.move(20, 0)).toBe(true);

  // NSH reported no move after the release; the next press still starts.
  expect(gesture.down(100, 100)).toBe(true);
  expect(calls[calls.length - 1]).toEqual({ kind: "end", x: 20, y: 0 });
  expect(gesture.move(130, 100)).toBe(true);
});

test("does not start while another gesture owns the canvas", () => {
  const { gesture, calls, allow } = setup(false);
  expect(gesture.down(0, 0)).toBe(false);
  expect(gesture.move(30, 30)).toBe(false);
  expect(calls).toEqual([]);

  allow(true);
  expect(gesture.down(0, 0)).toBe(true);
});

function controllerWith(pans: { dx: number; dy: number }[]): CanvasController {
  const scene = new FlowScene();
  const camera = new CanvasCamera();
  return new CanvasController({
    scene: () => scene,
    camera: () => camera,
    tool: () => "select",
    panBy: (dx, dy) => pans.push({ dx, dy }),
    commitBounds: () => undefined,
    selectEdge: () => undefined,
    reconnectEdge: () => undefined,
    connectNodes: () => undefined,
    openInline: () => undefined,
    onCardPress: () => undefined,
  });
}

test("right-drags the camera without starting another canvas gesture", () => {
  const pans: { dx: number; dy: number }[] = [];
  const controller = controllerWith(pans);

  expect(controller.right.down(10, 10)).toBe(true);
  expect(controller.right.move(50, 60)).toBe(true);
  expect(pans).toEqual([{ dx: 40, dy: 50 }]);
  expect(controller.cursor()).toBe("grabbing");

  controller.right.end();
  expect(controller.cursor()).toBe("default");
});

test("ignores a right press during a left gesture", () => {
  const controller = controllerWith([]);
  controller.down(10, 10, false, 1);
  expect(controller.right.down(40, 40)).toBe(false);
  controller.cancel();
});

test("keeps a right press when the pointer moves onto an overlay", () => {
  const controller = controllerWith([]);
  expect(controller.right.down(10, 10)).toBe(true);
  // Moving onto the context menu is a canvas leave; it must not end the press.
  controller.leave();
  expect(controller.right.active()).toBe(true);
});
