import { expect, test } from "nsh/test";
import { gridLayout, wrappedGridOffset } from "./grid";

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

test("wrapped grid offsets preserve the previous tile origins", () => {
  const tile = 640;
  const origin = (value: number, column: number): number =>
    wrappedGridOffset(value, tile) - tile + column * tile;
  const columns = [0, 1, 2, 3];

  expect(wrappedGridOffset(-1, tile)).toBe(639);
  expect(wrappedGridOffset(641, tile)).toBe(1);
  // The old tile origin was wrap(value) - TILE + column * TILE.
  expect(columns.map((column) => origin(-1, column))).toEqual([-1, 639, 1279, 1919]);
  expect(columns.map((column) => origin(641, column))).toEqual([-639, 1, 641, 1281]);
});

test("invalid tile sizes keep a zero wrapped offset", () => {
  for (const tile of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(wrappedGridOffset(123, tile)).toBe(0);
  }
});
