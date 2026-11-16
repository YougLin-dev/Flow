import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary } from "@flow/native";
import { keepEdge, keepNode, pairKey, rectOfNode, samePairs, topologyPairs } from "./scene-records";

function node(id: string, x: number, overrides: Partial<NodeSummary> = {}): NodeSummary {
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
    ...overrides,
  };
}

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return {
    id,
    fromId,
    toId,
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 42,
    toOffset: 42,
    kind: "flow",
    dataJson: "{}",
  };
}

test("keeps a repeated record and replaces a changed one", () => {
  const current = node("a", 0);
  expect(keepNode(current, node("a", 0))).toBe(current);
  expect(keepNode(current, node("a", 10))).not.toBe(current);
  expect(keepNode(undefined, current)).toBe(current);

  const link = edge("a-b", "a", "b");
  expect(keepEdge(link, edge("a-b", "a", "b"))).toBe(link);
  expect(keepEdge(link, edge("a-b", "a", "c"))).not.toBe(link);
  expect(keepEdge(undefined, link)).toBe(link);
});

test("a node's document rectangle comes from its record", () => {
  expect(rectOfNode(node("a", 40, { y: 60, width: 200, height: 84 }))).toEqual({
    x: 40,
    y: 60,
    width: 200,
    height: 84,
  });
});

test("pair keys stay directional and collision-free", () => {
  const trickyFrom = 'a\u0000,b:c"';
  const trickyTo = "d";
  const collidingFrom = "a";
  const collidingTo = '\u0000,b:c"d';

  // These two pairs concatenate to the same raw string; the length-prefixed
  // key keeps them apart.
  expect(`${trickyFrom}${trickyTo}`).toBe(`${collidingFrom}${collidingTo}`);
  expect(pairKey(trickyFrom, trickyTo)).not.toBe(pairKey(collidingFrom, collidingTo));
  expect(pairKey("a", "b")).not.toBe(pairKey("b", "a"));
});

test("topology pairs compare by connection, not order", () => {
  const first = topologyPairs([edge("one", "a", "b"), edge("two", "b", "c")]);
  const reordered = topologyPairs([edge("two", "b", "c"), edge("one", "a", "b")]);
  const missing = topologyPairs([edge("one", "a", "b")]);
  const reversed = topologyPairs([edge("one", "a", "b"), edge("two", "c", "b")]);

  expect(samePairs(first, reordered)).toBe(true);
  expect(samePairs(first, missing)).toBe(false);
  expect(samePairs(first, reversed)).toBe(false);
});
