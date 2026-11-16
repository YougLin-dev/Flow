import { expect, test } from "nsh/test";
import type { NodeSummary } from "@flow/native";
import { changedBounds, settledOverrideIds } from "./scene-overrides";

function node(id: string, x: number): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: id,
    x,
    y: 0,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
  };
}

test("changed bounds report only overrides that differ from the committed rect", () => {
  const applied = new Map([
    ["a", { x: 0, y: 0, width: 200, height: 84 }],
    ["b", { x: 300, y: 0, width: 200, height: 84 }],
  ]);
  const overrides = new Map([
    ["a", { x: 10, y: 0, width: 200, height: 84 }],
    ["b", { x: 300, y: 0, width: 200, height: 84 }],
    ["ghost", { x: 0, y: 0, width: 10, height: 10 }],
  ]);

  expect(changedBounds(overrides, applied)).toEqual([
    { id: "a", x: 10, y: 0, width: 200, height: 84 },
  ]);
});

test("settled overrides are the changed cards whose geometry now matches", () => {
  const overrides = new Map([
    ["a", { x: 10, y: 0, width: 200, height: 84 }],
    ["b", { x: 300, y: 0, width: 200, height: 84 }],
  ]);

  // a's override matches its committed x; b's does not; c has no override.
  expect(settledOverrideIds([node("a", 10), node("b", 320), node("c", 0)], overrides)).toEqual([
    "a",
  ]);
});
