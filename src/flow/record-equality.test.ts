import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary } from "@flow/native";
import { sameEdge, sameNode, samePreviewView } from "./record-equality";

function node(id: string, x: number, y: number, overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: id,
    x,
    y,
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

test("sameNode compares every field exactly", () => {
  const base = node("a", 40, 40);
  expect(sameNode(base, node("a", 40, 40))).toBe(true);

  expect(sameNode(base, { ...base, id: "b" })).toBe(false);
  expect(sameNode(base, { ...base, kind: "image" })).toBe(false);
  expect(sameNode(base, { ...base, title: "other" })).toBe(false);
  expect(sameNode(base, { ...base, body: "other" })).toBe(false);
  expect(sameNode(base, { ...base, x: 41 })).toBe(false);
  expect(sameNode(base, { ...base, y: 41 })).toBe(false);
  expect(sameNode(base, { ...base, width: 201 })).toBe(false);
  expect(sameNode(base, { ...base, height: 85 })).toBe(false);
  expect(sameNode(base, { ...base, z: 1 })).toBe(false);
  expect(sameNode(base, { ...base, rev: 2 })).toBe(false);
  expect(sameNode(base, { ...base, dataJson: '{"a":1}' })).toBe(false);
  expect(sameNode(base, { ...base, settingsJson: '{"a":1}' })).toBe(false);
  expect(sameNode(base, { ...base, status: "running" })).toBe(false);
  expect(sameNode(base, { ...base, outputBatchId: "batch" })).toBe(false);
});

test("sameNode normalizes an absent output batch to null", () => {
  const base = node("a", 40, 40);
  const withoutBatch = { ...base };
  delete withoutBatch.outputBatchId;
  expect(sameNode(base, withoutBatch)).toBe(true);
  expect(sameNode({ ...base, outputBatchId: "batch" }, withoutBatch)).toBe(false);
});

test("sameEdge compares every field exactly", () => {
  const base: EdgeSummary = {
    id: "a-b",
    fromId: "a",
    toId: "b",
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 110,
    toOffset: 110,
    kind: "flow",
    dataJson: "{}",
    fromPoint: { x: 1, y: 2 },
    toPoint: { x: 3, y: 4 },
  };
  const same: EdgeSummary = { ...base, fromPoint: { x: 1, y: 2 }, toPoint: { x: 3, y: 4 } };
  expect(sameEdge(base, same)).toBe(true);

  expect(sameEdge(base, { ...base, fromPoint: { x: 1.5, y: 2 } })).toBe(false);
  expect(sameEdge(base, { ...base, toPoint: { x: 3, y: 5 } })).toBe(false);
  expect(sameEdge(base, { ...base, fromPoint: null })).toBe(false);
  expect(sameEdge(base, { ...base, toPoint: null })).toBe(false);
  expect(sameEdge(base, { ...base, id: "other" })).toBe(false);
  expect(sameEdge(base, { ...base, fromId: "c" })).toBe(false);
  expect(sameEdge(base, { ...base, toId: "c" })).toBe(false);
  expect(sameEdge(base, { ...base, kind: "data" })).toBe(false);
  expect(sameEdge(base, { ...base, dataJson: '{"a":1}' })).toBe(false);
  expect(sameEdge(base, { ...base, fromPort: "references" })).toBe(false);
  expect(sameEdge(base, { ...base, toPort: "references" })).toBe(false);
  expect(sameEdge(base, { ...base, portKind: "image" })).toBe(false);
  expect(sameEdge(base, { ...base, fromOffset: 0 })).toBe(false);
  expect(sameEdge(base, { ...base, toOffset: 0 })).toBe(false);
});

test("sameEdge normalizes an absent point to null", () => {
  const base: EdgeSummary = {
    id: "a-b",
    fromId: "a",
    toId: "b",
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 110,
    toOffset: 110,
    kind: "flow",
    dataJson: "{}",
    fromPoint: { x: 1, y: 2 },
  };
  const withoutPoint = { ...base };
  delete withoutPoint.fromPoint;
  expect(sameEdge({ ...base, fromPoint: null }, withoutPoint)).toBe(true);
});

test("samePreviewView compares the URL list element by element", () => {
  const base = { nodeId: "a", urls: ["one", "two"], count: 2 };
  expect(samePreviewView(base, { nodeId: "a", urls: ["one", "two"], count: 2 })).toBe(true);
  expect(samePreviewView(base, { nodeId: "a", urls: ["one", "two", "three"], count: 2 })).toBe(
    false,
  );
  expect(samePreviewView(base, { nodeId: "a", urls: ["one", "other"], count: 2 })).toBe(false);
  expect(samePreviewView(base, { nodeId: "a", urls: ["one", "two"], count: 3 })).toBe(false);
  expect(samePreviewView(base, { nodeId: "b", urls: ["one", "two"], count: 2 })).toBe(false);
  expect(
    samePreviewView({ nodeId: "a", urls: [], count: 0 }, { nodeId: "a", urls: [], count: 0 }),
  ).toBe(true);
});
