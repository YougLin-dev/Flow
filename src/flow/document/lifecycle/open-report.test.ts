import { expect, test } from "nsh/test";
import { applyOpenView, needsVerify, savedCamera } from "./open-report";

test("an unclean open schedules the recovery check", () => {
  expect(needsVerify({ openedClean: false })).toBe(true);
  expect(needsVerify({ openedClean: true })).toBe(false);
});

test("a saved camera is restored unless the package never saved one", () => {
  expect(savedCamera({ cameraX: 0, cameraY: 0, cameraZoom: 1 })).toBeNull();
  expect(savedCamera({ cameraX: 120, cameraY: -40, cameraZoom: 2.5 })).toEqual({
    x: 120,
    y: -40,
    zoom: 2.5,
  });
  expect(savedCamera({ cameraX: Number.NaN, cameraY: 0, cameraZoom: 1 })).toBeNull();
  expect(savedCamera({ cameraX: Infinity, cameraY: 0, cameraZoom: 1 })).toBeNull();
  expect(savedCamera({ cameraX: 0, cameraY: 0, cameraZoom: 0 })).toBeNull();
});

test("a saved view is restored and marked user-chosen", () => {
  const events: string[] = [];
  const camera = {
    restore: (view: { x: number; y: number; scale: number }) => {
      events.push(`restore:${view.x},${view.y},${view.scale}`);
      return true;
    },
  };
  const viewport = {
    userMoved: () => events.push("userMoved"),
  };

  expect(applyOpenView(camera, viewport, { cameraX: 120, cameraY: -40, cameraZoom: 2.5 })).toBe(
    "restored",
  );
  expect(events).toEqual(["userMoved", "restore:120,-40,2.5"]);

  events.length = 0;
  expect(applyOpenView(camera, viewport, { cameraX: 0, cameraY: 0, cameraZoom: 1 })).toBe("fit");
  expect(events).toEqual([]);
});
