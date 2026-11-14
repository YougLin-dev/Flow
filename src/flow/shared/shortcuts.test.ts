import { expect, test } from "nsh/test";
import { FIT_KEY, ZOOM_IN_KEY, ZOOM_OUT_KEY } from "./shortcuts";

test("the canvas' shortcut names stay the ones the controls show", () => {
  expect(ZOOM_IN_KEY).toBe("mod+=");
  expect(ZOOM_OUT_KEY).toBe("mod+-");
  expect(FIT_KEY).toBe("mod+0");
});
