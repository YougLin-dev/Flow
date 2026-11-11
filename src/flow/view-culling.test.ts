import { expect, test } from "nsh/test";
import { CARD_CULL_MARGIN, cardInView } from "./view-culling";

const view = { x: 0, y: 0, width: 1000, height: 800 };

test("a card inside the view is painted", () => {
  expect(cardInView({ x: 100, y: 100, width: 320, height: 200 }, view)).toBe(true);
});

test("a card straddling an edge is painted", () => {
  expect(cardInView({ x: -300, y: 300, width: 320, height: 200 }, view)).toBe(true);
});

test("a card beyond the margin is not painted", () => {
  expect(cardInView({ x: 1000 + CARD_CULL_MARGIN + 1, y: 0, width: 320, height: 200 }, view)).toBe(
    false,
  );
  expect(cardInView({ x: 0, y: -CARD_CULL_MARGIN - 201, width: 320, height: 200 }, view)).toBe(
    false,
  );
});

test("the margin keeps a card whose title or shadow still shows", () => {
  expect(cardInView({ x: 1000 + CARD_CULL_MARGIN - 1, y: 0, width: 320, height: 200 }, view)).toBe(
    true,
  );
});

test("the cull margin is caller-controlled", () => {
  const rect = { x: 1100, y: 0, width: 320, height: 200 };
  expect(cardInView(rect, view, 0)).toBe(false);
  expect(cardInView(rect, view, 200)).toBe(true);
});
