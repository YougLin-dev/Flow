import { expect, test } from "nsh/test";
import { cardDetailAt } from "./card-detail";

test("full detail at and above 0.35", () => {
  expect(cardDetailAt(1)).toBe("full");
  expect(cardDetailAt(0.35)).toBe("full");
  expect(cardDetailAt(2.5)).toBe("full");
});

test("reduced detail between 0.2 and 0.35", () => {
  expect(cardDetailAt(0.34)).toBe("reduced");
  expect(cardDetailAt(0.2)).toBe("reduced");
});

test("minimal detail below 0.2", () => {
  expect(cardDetailAt(0.19)).toBe("minimal");
  expect(cardDetailAt(0.05)).toBe("minimal");
});

test("a non-finite scale falls back to full", () => {
  expect(cardDetailAt(Number.NaN)).toBe("full");
  expect(cardDetailAt(Number.POSITIVE_INFINITY)).toBe("full");
});

test("the tiers are strictly ordered at the boundaries", () => {
  expect(cardDetailAt(0.349999)).toBe("reduced");
  expect(cardDetailAt(0.199999)).toBe("minimal");
});
