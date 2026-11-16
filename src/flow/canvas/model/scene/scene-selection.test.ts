import { expect, test } from "nsh/test";
import { effect } from "nsh";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import type { BoxGeometry } from "../../../shared";
import { FlowScene } from "./scene";
import {
  normalizeSelection,
  sameSelection,
  selectionBoundsOf,
  selectionRanksOf,
} from "./scene-selection";

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

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

test("normalization keeps known ids once in order", () => {
  const known = new Set(["a", "b"]);
  expect(normalizeSelection(["a", "a", "ghost", "b"], (id) => known.has(id))).toEqual(["a", "b"]);
});

test("sameSelection compares ids by position", () => {
  expect(sameSelection(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameSelection(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameSelection(["a"], ["a", "b"])).toBe(false);
});

test("selection ranks count from one in selection order", () => {
  expect([...selectionRanksOf(["b", "a"])]).toEqual([
    ["b", 1],
    ["a", 2],
  ]);
});

test("selection bounds include the title row and skip unknown cards", () => {
  const rects: Record<string, BoxGeometry> = {
    a: { x: 50, y: 40, width: 200, height: 84 },
  };
  expect(selectionBoundsOf(["a", "ghost"], (id) => rects[id] ?? null)).toEqual({
    x: 50,
    y: 14,
    width: 200,
    height: 110,
  });
  expect(selectionBoundsOf([], () => null)).toBeNull();
});

test("isSelected answers from the selection ranks", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));

  scene.select(["b", "a"]);
  expect(scene.isSelected("a")).toBe(true);
  expect(scene.isSelected("b")).toBe(true);
  expect(scene.isSelected("c")).toBe(false);

  scene.select([]);
  expect(scene.isSelected("a")).toBe(false);
  expect(scene.isSelected("b")).toBe(false);
  scene.select(["missing-id"]);
  expect(scene.isSelected("missing-id")).toBe(false);
  expect(scene.selectedIds()).toEqual([]);
});

test("isSelected stays consistent through a snapshot that prunes the scene", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));
  scene.select(["a", "b"]);

  scene.apply(snapshot([node("c", 600, 0)]));
  expect(scene.isSelected("a")).toBe(true);
  expect(scene.isSelected("b")).toBe(true);

  scene.applyChangeSet({ changed: [], removed: ["a"], edgesChanged: [], edgesRemoved: [] });
  expect(scene.isSelected("a")).toBe(false);
  expect(scene.isSelected("b")).toBe(true);
});

test("selecting flips only the newly selected cards' keyed flags", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)]));
  const runs = { a: 0, b: 0, c: 0 };
  effect(() => {
    scene.isSelectedKeyed("a");
    runs.a += 1;
  });
  effect(() => {
    scene.isSelectedKeyed("b");
    runs.b += 1;
  });
  effect(() => {
    scene.isSelectedKeyed("c");
    runs.c += 1;
  });

  scene.select(["a", "b"]);
  expect(runs).toEqual({ a: 2, b: 2, c: 1 });
  scene.select(["b"]);
  expect(runs).toEqual({ a: 3, b: 2, c: 1 });
});

test("a change set that removes a card drops its keyed flags", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0)]));
  scene.select(["a"]);
  let runsA = 0;
  let runsOther = 0;
  effect(() => {
    scene.isSelectedKeyed("a");
    runsA += 1;
  });
  effect(() => {
    scene.isSelectedKeyed("b");
    runsOther += 1;
  });

  scene.applyChangeSet({ changed: [], removed: ["a"], edgesChanged: [], edgesRemoved: [] });
  expect(scene.isSelectedKeyed("a")).toBe(false);
  expect(runsA).toBe(2);
  expect(runsOther).toBe(1);
});

test("selecting a card clears the selected edge", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)], [edge("a-b", "a", "b")]));
  scene.selectEdge("a-b");

  scene.select(["a"]);
  expect(scene.selectedEdge()).toBeNull();
});

test("selects, toggles and ignores unknown cards", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));

  scene.select(["a", "a", "ghost"]);
  expect(scene.selectedIds()).toEqual(["a"]);

  scene.toggleSelected("b");
  expect(scene.selectedIds()).toEqual(["a", "b"]);
  scene.toggleSelected("a");
  expect(scene.selectedIds()).toEqual(["b"]);

  scene.select([]);
  expect(scene.selectedIds()).toEqual([]);
});

test("raises selected cards above unselected ones for drawing and hits", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0, { z: 5 }), node("b", 50, 40)]));

  // The document z still decides between unselected cards.
  expect(scene.nodeAt(60, 50)).toBe("a");
  expect(scene.cardZ("a")).toBeGreaterThan(scene.cardZ("b"));

  // Selecting b lifts it above every unselected card, whatever its z, and
  // the frame's wash sits above the selected group.
  scene.select(["b"]);
  expect(scene.cardZ("b")).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.frameZ()).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.frameZ()).toBeGreaterThan(scene.cardZ("b"));
  expect(scene.nodeAt(60, 50)).toBe("b");
  // The frame's world bounds include the card's title row.
  expect(scene.selectionBounds()).toEqual({ x: 50, y: 14, width: 200, height: 110 });

  // The selected group stacks in selection order: the last one draws on top.
  scene.select(["b", "a"]);
  expect(scene.cardZ("a")).toBeGreaterThan(scene.cardZ("b"));
  expect(scene.selectionBounds()).toEqual({ x: 0, y: -26, width: 250, height: 150 });
  // Group ports sit above the frame; the preview stays above them.
  expect(scene.selectionPortsZ()).toBeGreaterThan(scene.frameZ());
  expect(scene.previewZ()).toBeGreaterThan(scene.selectionPortsZ());
});

test("raises a card in the same update as its selection", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)]));

  const zs: number[] = [];
  effect(() => {
    zs.push(scene.cardZ("b"));
  });

  scene.select(["b"]);
  // The binding reading the depth sees the elevated value at once, without
  // waiting for a later render to catch up with the selection.
  expect(zs.at(-1)).toBeGreaterThan(scene.cardZ("a"));
});
