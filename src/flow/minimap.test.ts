import { expect, test } from "nsh/test";
import {
  minimapDragCenter,
  minimapLayout,
  minimapRect,
  minimapViewport,
  sameBounds,
  sameLayout,
  sameOverview,
  unionBounds,
} from "./minimap";

const SIZE = { width: 192, height: 128 };

test("fits and centers the bounds with one uniform scale", () => {
  const layout = minimapLayout(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 120, height: 100 },
    10,
  );

  // 100×80 available; the width is the tighter axis.
  expect(layout.scale).toBe(0.5);
  const rect = minimapRect({ x: 100, y: 50, width: 200, height: 100 }, layout);
  expect(rect.x).toBe(10);
  expect(rect.y).toBe(25);
  expect(rect.width).toBe(100);
  expect(rect.height).toBe(50);
});

test("unions the document with the viewport", () => {
  const documentBounds = { x: 0, y: 0, width: 100, height: 50 };

  expect(unionBounds(documentBounds, { x: 10, y: 10, width: 20, height: 10 })).toEqual(
    documentBounds,
  );
  expect(unionBounds(documentBounds, { x: 200, y: 60, width: 50, height: 40 })).toEqual({
    x: 0,
    y: 0,
    width: 250,
    height: 100,
  });
});

test("an unchanged union compares equal by value", () => {
  const bounds = { x: 1, y: 2, width: 3, height: 4 };
  expect(sameBounds(null, null)).toBe(true);
  expect(sameBounds(bounds, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameBounds(null, bounds)).toBe(false);
  expect(sameBounds(bounds, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
});

test("keeps silhouettes visible when the document dwarfs the panel", () => {
  const layout = minimapLayout(
    { x: 0, y: 0, width: 100_000, height: 100_000 },
    { width: 176, height: 120 },
    10,
  );

  const card = minimapRect({ x: 50_000, y: 50_000, width: 200, height: 84 }, layout, 1.5);
  expect(card.width).toBe(1.5);
  expect(card.height).toBe(1.5);
});

test("an empty document still produces a finite layout", () => {
  const layout = minimapLayout(
    { x: 0, y: 0, width: 0, height: 0 },
    { width: 176, height: 120 },
    10,
  );

  expect(Number.isFinite(layout.scale)).toBe(true);
  expect(layout.scale).toBeGreaterThan(0);
  const rect = minimapRect({ x: 0, y: 0, width: 0, height: 0 }, layout);
  expect(Number.isFinite(rect.x)).toBe(true);
  expect(Number.isFinite(rect.width)).toBe(true);
});

test("keeps a viewport inside the document in place", () => {
  const layout = minimapLayout(
    { x: 0, y: 0, width: 1024, height: 512 },
    { width: 192, height: 128 },
    16,
  );

  const rect = minimapViewport({ x: 256, y: 128, width: 256, height: 256 }, layout, SIZE);
  expect(rect).toEqual({ x: 56, y: 44, width: 40, height: 40 });
});

test("clamps a viewport that leaves the document into the panel", () => {
  const layout = minimapLayout({ x: 0, y: 0, width: 1024, height: 512 }, SIZE, 16);

  // A view far to the left keeps its mapped size and pins to the left edge.
  const aside = minimapViewport({ x: -512, y: 128, width: 512, height: 256 }, layout, SIZE);
  expect(aside).toEqual({ x: 0, y: 44, width: 80, height: 40 });

  // At Fit the view is larger than the document: the rectangle fills the panel
  // instead of falling outside it and hiding its border.
  const fit = minimapViewport({ x: -512, y: -256, width: 2048, height: 1024 }, layout, SIZE);
  expect(fit).toEqual({ x: 0, y: 0, width: 192, height: 128 });
});

test("pulling the viewport away from the document shrinks its silhouettes", () => {
  const documentBounds = { x: 0, y: 0, width: 1000, height: 500 };
  const nearView = { x: 100, y: 100, width: 400, height: 200 };
  const farView = { x: 2000, y: 0, width: 400, height: 200 };

  const near = minimapLayout(unionBounds(documentBounds, nearView), SIZE, 16);
  const far = minimapLayout(unionBounds(documentBounds, farView), SIZE, 16);

  expect(far.scale).toBeLessThan(near.scale);
  const nearContent = minimapRect(documentBounds, near);
  const farContent = minimapRect(documentBounds, far);
  expect(farContent.width).toBeLessThan(nearContent.width);

  // The far layout still holds both the content and the viewport.
  const farViewRect = minimapRect(farView, far);
  expect(farContent.x).toBeGreaterThanOrEqual(16 - 1e-6);
  expect(farViewRect.x + farViewRect.width).toBeLessThanOrEqual(SIZE.width - 16 + 1e-6);
});

test("a drag moves the view with the scale captured at press", () => {
  const drag = {
    point: { x: 88, y: 60 },
    center: { x: 1000, y: 500 },
    scale: 0.25,
  };

  expect(minimapDragCenter(drag, { x: 88, y: 60 })).toEqual({ x: 1000, y: 500 });
  // 20 and 10 map points at the press scale, not at a later shrunk one.
  expect(minimapDragCenter(drag, { x: 108, y: 70 })).toEqual({ x: 1080, y: 540 });
});

test("compares layouts and overviews by value", () => {
  const layout = minimapLayout({ x: 0, y: 0, width: 100, height: 100 }, SIZE, 16);
  expect(sameLayout(layout, { ...layout })).toBe(true);
  expect(sameLayout(layout, { ...layout, offsetX: layout.offsetX + 1 })).toBe(false);
  expect(sameLayout(null, null)).toBe(true);
  expect(sameLayout(layout, null)).toBe(false);

  const card = { id: "a", x: 10, y: 20, width: 200, height: 84 };
  const first = { rev: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, cards: [card] };
  expect(sameOverview(first, { ...first, rev: 2, cards: [{ ...card }] })).toBe(true);
  expect(sameOverview(first, { ...first, cards: [{ ...card, x: 11 }] })).toBe(false);
  expect(
    sameOverview(first, {
      ...first,
      bounds: { x: 0, y: 0, width: 101, height: 100 },
    }),
  ).toBe(false);
  expect(sameOverview(null, first)).toBe(false);
});
