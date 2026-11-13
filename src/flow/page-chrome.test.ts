import { platform, type ContextMenuEvent, type MouseEvent, type WheelEvent } from "nsh";
import { expect, test } from "nsh/test";
import { wheelNotches, wheelZoomFactor } from "./camera";
import { type ChromeMenu, pageChromeHandlers } from "./page-chrome";

const MODIFIERS = { control: false, alt: false, shift: false, platform: false };

function wheelAt(deltaY: number, deltaMode: "points" | "lines", x: number, y: number): WheelEvent {
  return {
    position: { x, y },
    pagePosition: { x, y },
    delta: { x: 0, y: deltaY },
    deltaMode,
    modifiers: MODIFIERS,
  };
}

function mouseAt(pressedButton: "left" | "right" | null, x: number, y: number): MouseEvent {
  return {
    position: { x, y },
    pagePosition: { x, y },
    modifiers: MODIFIERS,
    pressedButton,
    button: null,
  };
}

function contextAt(x: number, y: number): ContextMenuEvent {
  return {
    position: { x, y },
    pagePosition: { x, y },
    modifiers: MODIFIERS,
    pointerType: "mouse",
  };
}

function fakeMenu(calls: string[]): ChromeMenu {
  return {
    pressChrome: (at) => calls.push(`press ${at.x},${at.y}`),
    moveChrome: (at, held) => calls.push(`move ${at.x},${at.y} held=${held}`),
    release: () => calls.push("release"),
  };
}

test("zooms the canvas about the pointer from a wheel over page chrome", () => {
  const zooms: Array<[number, number, number]> = [];
  const chrome = pageChromeHandlers(fakeMenu([]), (factor, x, y) => zooms.push([factor, x, y]));

  // 96 points is two notches on every desktop: points do not depend on the OS.
  chrome.onWheel(wheelAt(96, "points", 140, 90));

  expect(zooms).toEqual([[wheelZoomFactor(2), 140, 90]]);
});

test("reads the wheel in its own unit and this platform", () => {
  const zooms: Array<[number, number, number]> = [];
  const chrome = pageChromeHandlers(fakeMenu([]), (factor, x, y) => zooms.push([factor, x, y]));

  // Lines are one notch on macOS and Linux but three on Windows: the
  // expectation uses the same conversion, so a hardcoded unit fails here.
  chrome.onWheel(wheelAt(3, "lines", 30, 40));

  expect(zooms).toEqual([[wheelZoomFactor(wheelNotches(3, "lines", platform.os)), 30, 40]]);
});

test("ignores a wheel that moves no notch", () => {
  let zooms = 0;
  const chrome = pageChromeHandlers(fakeMenu([]), () => {
    zooms += 1;
  });

  chrome.onWheel(wheelAt(0, "points", 10, 20));

  expect(zooms).toBe(0);
});

test("forwards the secondary gesture from page chrome", () => {
  const calls: string[] = [];
  const chrome = pageChromeHandlers(fakeMenu(calls), () => undefined);

  chrome.onContextMenu(contextAt(60, 70));
  chrome.onMouseMove(mouseAt("right", 80, 90));
  chrome.onMouseMove(mouseAt(null, 85, 95));
  chrome.onMouseUp();

  expect(calls).toEqual([
    "press 60,70",
    "move 80,90 held=true",
    "move 85,95 held=false",
    "release",
  ]);
});
