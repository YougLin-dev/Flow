import { expect, test } from "nsh/test";
import { gridLayout } from "./grid";

test("covers a stage at any wrapped camera offset", () => {
  expect(gridLayout(0, 0, 640)).toEqual({ columns: 1, rows: 1 });
  expect(gridLayout(1920, 1080, 640)).toEqual({ columns: 4, rows: 3 });
  // A 4K stage needs a seventh column so the right edge stays covered.
  expect(gridLayout(3840, 2160, 640)).toEqual({ columns: 7, rows: 5 });
  expect(gridLayout(3841, 2161, 640)).toEqual({ columns: 8, rows: 5 });
});

test("falls back to one tile for an invalid tile side", () => {
  expect(gridLayout(1920, 1080, 0)).toEqual({ columns: 1, rows: 1 });
  expect(gridLayout(1920, 1080, Number.NaN)).toEqual({ columns: 1, rows: 1 });
  expect(gridLayout(Number.POSITIVE_INFINITY, -10, 640)).toEqual({ columns: 1, rows: 1 });
});
