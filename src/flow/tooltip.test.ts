/**
 * The port tooltip's placement: the side a bubble prefers, the flip when it
 * would leave the stage, the margin clamp and the approximate pill width.
 */
import { expect, test } from "nsh/test";
import { tipWidth, tooltipBox, type TipPlacement } from "./tooltip";

const stage = { width: 800, height: 600 };
const base = { width: 100, height: 26, stage, gap: 14, margin: 8 };

function place(
  x: number,
  y: number,
  portSide: "in" | "out",
  placement: TipPlacement = "auto",
): { left: number; top: number; side: string } {
  return tooltipBox({ ...base, center: { x, y }, portSide, placement });
}

test("auto puts an input's bubble left and an output's right", () => {
  expect(place(400, 300, "in")).toEqual({ left: 286, top: 287, side: "left" });
  expect(place(400, 300, "out")).toEqual({ left: 414, top: 287, side: "right" });
});

test("an explicit placement wins over the port's side", () => {
  expect(place(400, 300, "in", "above")).toEqual({ left: 350, top: 260, side: "above" });
  expect(place(400, 300, "out", "below")).toEqual({ left: 350, top: 314, side: "below" });
});

test("flips to the opposite side when the preferred one leaves the stage", () => {
  expect(place(760, 300, "out")).toEqual({ left: 646, top: 287, side: "left" });
  expect(place(40, 300, "in")).toEqual({ left: 54, top: 287, side: "right" });
  expect(place(400, 20, "in", "above")).toEqual({ left: 350, top: 34, side: "below" });
  expect(place(400, 590, "in", "below")).toEqual({ left: 350, top: 550, side: "above" });
});

test("clamps inside the margin when neither side fits", () => {
  const tiny = { width: 100, height: 40 };
  const box = tooltipBox({
    ...base,
    width: 120,
    height: 26,
    stage: tiny,
    center: { x: 90, y: 20 },
    portSide: "out",
    placement: "right",
  });
  expect(box.left).toBe(8);
  expect(box.top).toBe(8);
});

test("estimates a compact pill width that grows with the label", () => {
  expect(tipWidth("Text")).toBeLessThan(tipWidth("Prompt"));
  expect(tipWidth("Prompt")).toBeLessThan(tipWidth("Image references"));
  expect(tipWidth("图片图片")).toBeGreaterThan(tipWidth("abcd"));
  expect(tipWidth("Text")).toBeGreaterThanOrEqual(46);
});
