import { expect, test } from "nsh/test";
import { previewCell } from "./preview-grid";

const BODY_WIDTH = 268;
const BODY_HEIGHT = 156;

test("fills the body with a single preview", () => {
  expect(previewCell(BODY_WIDTH, BODY_HEIGHT, 0, 1)).toEqual({
    left: 0,
    top: 0,
    width: BODY_WIDTH,
    height: BODY_HEIGHT,
  });
});

test("lays two previews side by side inside the body", () => {
  const first = previewCell(BODY_WIDTH, BODY_HEIGHT, 0, 2);
  const second = previewCell(BODY_WIDTH, BODY_HEIGHT, 1, 2);
  expect(first).toEqual({ left: 0, top: 0, width: 130, height: BODY_HEIGHT });
  expect(second).toEqual({ left: 138, top: 0, width: 130, height: BODY_HEIGHT });
  expect(second.left + second.width).toBeLessThanOrEqual(BODY_WIDTH);
});

test("lays three or four previews in two rows inside the body", () => {
  const third = previewCell(BODY_WIDTH, BODY_HEIGHT, 2, 3);
  const fourth = previewCell(BODY_WIDTH, BODY_HEIGHT, 3, 4);
  expect(third).toEqual({ left: 0, top: 82, width: 130, height: 74 });
  expect(fourth).toEqual({ left: 138, top: 82, width: 130, height: 74 });
  expect(third.top + third.height).toBeLessThanOrEqual(BODY_HEIGHT);
  expect(fourth.left + fourth.width).toBeLessThanOrEqual(BODY_WIDTH);
  expect(fourth.top + fourth.height).toBeLessThanOrEqual(BODY_HEIGHT);
});

test("never returns a degenerate cell", () => {
  for (const count of [0, 1, 2, 3, 4]) {
    const cell = previewCell(1, 1, 0, count);
    expect(cell.width).toBeGreaterThanOrEqual(1);
    expect(cell.height).toBeGreaterThanOrEqual(1);
  }
});
