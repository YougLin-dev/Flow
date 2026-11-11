import { platform } from "nsh";
import { isAvailable } from "nsh/desktop";
import { expect, test } from "nsh/test";
import {
  isPinned,
  selectedCount,
  setSelectedCount,
  setZoomPercent,
  togglePinned,
  zoomPercent,
} from "./store";

test("keeps workspace state behind readers and actions", () => {
  setSelectedCount(3);
  expect(selectedCount()).toBe(3);

  setZoomPercent(175);
  expect(zoomPercent()).toBe(175);

  // Leave the workspace as the app expects to find it.
  setSelectedCount(0);
});

test("pins only where the platform can set a window level", () => {
  const pinnable = isAvailable && platform.os !== "linux";
  expect(isPinned()).toBe(false);

  togglePinned();
  expect(isPinned()).toBe(pinnable);

  if (pinnable) {
    togglePinned();
    expect(isPinned()).toBe(false);
  }
});
