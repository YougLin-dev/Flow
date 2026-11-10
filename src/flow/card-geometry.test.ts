import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { CardGeometry, cardLocalLayout, cardPlusPoint, toCardLocal } from "./card-geometry";
import type { BoxGeometry } from "./connection";
import { FlowScene } from "./scene";

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

function snapshot(nodes: NodeSummary[]): SceneSnapshot {
  return { rev: 1, nodes, edges: [] };
}

/** Counts how often an effect reading each memo runs (once at the start). */
function wakes(geometry: CardGeometry): { positions: () => number; sizes: () => number } {
  let positions = 0;
  let sizes = 0;
  effect(() => {
    geometry.position();
    positions += 1;
  });
  effect(() => {
    geometry.size();
    sizes += 1;
  });
  return { positions: () => positions, sizes: () => sizes };
}

function rect(x: number, y: number, width = 200, height = 84): BoxGeometry {
  return { x, y, width, height };
}

test("a move wakes only the position memo", () => {
  const source = signal<BoxGeometry | null>(rect(10, 20));
  const geometry = new CardGeometry(() => source());
  const runs = wakes(geometry);

  source.set(rect(50, 20));

  expect(runs.positions()).toBe(2);
  expect(runs.sizes()).toBe(1);
  expect(geometry.position()).toEqual({ x: 50, y: 20 });
});

test("a resize wakes only the size memo", () => {
  const source = signal<BoxGeometry | null>(rect(10, 20));
  const geometry = new CardGeometry(() => source());
  const runs = wakes(geometry);

  source.set(rect(10, 20, 260, 120));

  expect(runs.sizes()).toBe(2);
  expect(runs.positions()).toBe(1);
  expect(geometry.size()).toEqual({ width: 260, height: 120 });
});

test("a rectangle with the same fields wakes neither memo", () => {
  const source = signal<BoxGeometry | null>(rect(10, 20));
  const geometry = new CardGeometry(() => source());
  const runs = wakes(geometry);

  // A fresh object with the same geometry (a viewport read): nothing moves.
  source.set(rect(10, 20));

  expect(runs.positions()).toBe(1);
  expect(runs.sizes()).toBe(1);
});

test("a missing rectangle clears both memos", () => {
  const source = signal<BoxGeometry | null>(rect(10, 20));
  const geometry = new CardGeometry(() => source());
  const runs = wakes(geometry);

  source.set(null);
  expect(runs.positions()).toBe(2);
  expect(runs.sizes()).toBe(2);
  expect(geometry.position()).toBeNull();
  expect(geometry.size()).toBeNull();

  source.set(rect(10, 20));
  expect(runs.positions()).toBe(3);
  expect(runs.sizes()).toBe(3);
});

test("the card's chrome is laid out in card-local points", () => {
  const layout = cardLocalLayout({ width: 300, height: 220 });
  // The root carries the card's position; the title band sits above it.
  expect(layout.title).toEqual({ x: 0, y: -26, width: 300, height: 20 });
  expect(layout.body).toEqual({ x: 0, y: 0, width: 300, height: 220 });
  const empty = cardLocalLayout({ width: 0, height: 0 });
  expect(empty.title).toEqual({ x: 0, y: -26, width: 0, height: 20 });
  expect(empty.body).toEqual({ x: 0, y: 0, width: 0, height: 0 });
});

test("a plus rests in the card's local points", () => {
  expect(cardPlusPoint({ width: 300, height: 220 }, "in")).toEqual({ x: -16, y: 110 });
  expect(cardPlusPoint({ width: 300, height: 220 }, "out")).toEqual({ x: 316, y: 110 });
  expect(cardPlusPoint({ width: 0, height: 0 }, "in")).toEqual({ x: -16, y: 0 });
});

test("a followed world point becomes card-local and lands back on it", () => {
  const origin = { x: 40, y: 20 };
  const base = cardPlusPoint({ width: 300, height: 220 }, "in");
  const followed = { x: 300, y: 200 };
  const local = toCardLocal(followed, origin);
  expect(local).toEqual({ x: 260, y: 180 });
  // The root carries `origin`, the plus rests at `base` and springs by the
  // offset: the three land exactly on the pointer's world point.
  const offset = { x: local.x - base.x, y: local.y - base.y };
  expect({ x: origin.x + base.x + offset.x, y: origin.y + base.y + offset.y }).toEqual(followed);
});

test("a scene drag wakes only the moved card's position", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
  const moved = new CardGeometry(() => scene.cardRect("a"));
  const still = new CardGeometry(() => scene.cardRect("b"));
  const runsMoved = wakes(moved);
  const runsStill = wakes(still);

  scene.setOverrides(new Map([["a", rect(140, 40)]]));
  expect(runsMoved.positions()).toBe(2);
  expect(runsMoved.sizes()).toBe(1);
  expect(runsStill.positions()).toBe(1);
  expect(runsStill.sizes()).toBe(1);

  // Releasing drops the card back onto the committed rectangle.
  scene.clearOverrides();
  expect(runsMoved.positions()).toBe(3);
  expect(runsMoved.sizes()).toBe(1);
});

test("a command's move wakes only the position memo", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  const geometry = new CardGeometry(() => scene.cardRect("a"));
  const runs = wakes(geometry);

  scene.applyChangeSet({
    changed: [node("a", 90, 70)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });

  expect(runs.positions()).toBe(2);
  expect(runs.sizes()).toBe(1);
});

test("a command's resize wakes only the size memo", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  const geometry = new CardGeometry(() => scene.cardRect("a"));
  const runs = wakes(geometry);

  scene.applyChangeSet({
    changed: [node("a", 40, 40, { width: 260, height: 120 })],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });

  expect(runs.sizes()).toBe(2);
  expect(runs.positions()).toBe(1);
});

test("a viewport read that leaves a card where it was wakes neither memo", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  const geometry = new CardGeometry(() => scene.cardRect("a"));
  const runs = wakes(geometry);

  // Fresh node records with the same geometry: the applied rect object is
  // kept, and the memos see the same fields.
  scene.apply(snapshot([node("a", 40, 40)]));

  expect(runs.positions()).toBe(1);
  expect(runs.sizes()).toBe(1);
});
