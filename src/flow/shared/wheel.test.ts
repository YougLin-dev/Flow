import { expect, test } from "nsh/test";
import { keepsWheel } from "./wheel";

test("the view that owns its wheel swallows the page's zoom without a trace", () => {
  expect(keepsWheel()).toBeUndefined();
  expect(keepsWheel()).toBeUndefined();
});
