import { expect, test } from "nsh/test";
import {
  currentTool,
  selectedCount,
  setSelectedCount,
  setTool,
  setZoomPercent,
  zoomPercent,
} from "./store";

test("keeps workspace state behind readers and actions", () => {
  expect(currentTool()).toBe("select");

  setTool("hand");
  expect(currentTool()).toBe("hand");

  setSelectedCount(3);
  expect(selectedCount()).toBe(3);

  setZoomPercent(175);
  expect(zoomPercent()).toBe(175);

  // Leave the workspace as the app expects to find it.
  setTool("select");
  setSelectedCount(0);
});
