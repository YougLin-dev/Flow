import { type Accessor, effect } from "nsh";
import { expect, test } from "nsh/test";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
import { type BoxGeometry, type Point, connectionBounds, connectorControls } from "./connection";
import {
  CONNECTOR_VIEW_MARGIN,
  connectorLayerBounds,
  connectorLayerBox,
  trimConnectorBox,
} from "./edge-layer";
import { FlowScene } from "./scene";

function node(id: string, x: number, y: number): NodeSummary {
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
  };
}

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return { id, fromId, toId, fromPort: null, toPort: null, kind: "flow", dataJson: "{}" };
}

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[]): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

function sceneBounds(scene: FlowScene): BoxGeometry | null {
  return connectorLayerBounds(
    scene.edges().map((connector) => {
      const ports = scene.edgePorts(connector);
      return ports === null ? null : connectionBounds(ports.from, ports.to);
    }),
  );
}

function move(scene: FlowScene, x: number): void {
  scene.setOverrides(new Map([["a", { x, y: 40, width: 200, height: 84 }]]));
}

interface BoxReaders {
  readonly left: () => number;
  readonly top: () => number;
  readonly width: () => number;
  readonly height: () => number;
}

/** Four independent readers, matching the four production style bindings. */
function readBox(box: Accessor<BoxGeometry | null>): BoxReaders {
  let left = 0;
  let top = 0;
  let width = 0;
  let height = 0;
  effect(() => {
    void (box()?.x ?? 0);
    left += 1;
  });
  effect(() => {
    void (box()?.y ?? 0);
    top += 1;
  });
  effect(() => {
    void (box()?.width ?? 0);
    width += 1;
  });
  effect(() => {
    void (box()?.height ?? 0);
    height += 1;
  });
  return {
    left: () => left,
    top: () => top,
    width: () => width,
    height: () => height,
  };
}

function expectReaderRuns(readers: BoxReaders, count: number): void {
  expect([readers.left(), readers.top(), readers.width(), readers.height()]).toEqual([
    count,
    count,
    count,
    count,
  ]);
}

class CountingScene extends FlowScene {
  traversals = 0;

  override edgePorts(connector: EdgeSummary): { from: Point; to: Point } | null {
    this.traversals += 1;
    return super.edgePorts(connector);
  }
}

function countingScene(nodes: NodeSummary[], edges: EdgeSummary[]): CountingScene {
  const scene = new CountingScene();
  scene.apply(snapshot(nodes, edges));
  return scene;
}

function oneConnectorScene(): CountingScene {
  return countingScene([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]);
}

test("an empty connector list has no layer box", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([], []));
  expect(sceneBounds(scene)).toBeNull();
  expect(connectorLayerBounds([])).toBeNull();
});

test("unresolved connector boxes do not contribute to the layer box", () => {
  const scene = oneConnectorScene();
  const connector = scene.edges()[0];
  if (!connector) throw new Error("The fixture must have a connector.");
  const ports = scene.edgePorts(connector);
  if (!ports) throw new Error("The fixture connector must have ports.");
  const present = connectionBounds(ports.from, ports.to);

  expect(connectorLayerBounds([null, null])).toBeNull();
  expect(connectorLayerBounds([null, present, null])).toEqual(connectorLayerBounds([present]));
});

test("padding and 64-point rounding contain the complete connector box", () => {
  const scene = oneConnectorScene();
  const connector = scene.edges()[0];
  if (!connector) throw new Error("The fixture must have a connector.");
  const ports = scene.edgePorts(connector);
  if (!ports) throw new Error("The fixture connector must have ports.");
  const bounds = connectionBounds(ports.from, ports.to);

  expect(sceneBounds(scene)).toEqual({ x: 192, y: 64, width: 192, height: 64 });
  expect(bounds).toEqual({ x: 240, y: 82, width: 120, height: 0 });
});

test("negative coordinates and handles beyond both ports round outward", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", -300, 0), node("b", -100, 140)], [edge("a-b", "a", "b")]));
  const connector = scene.edges()[0];
  if (!connector) throw new Error("The fixture must have a connector.");
  const ports = scene.edgePorts(connector);
  if (!ports) throw new Error("The fixture connector must have ports.");
  const bounds = connectionBounds(ports.from, ports.to);
  const rounded = sceneBounds(scene);
  if (!rounded) throw new Error("The fixture must have a layer box.");
  const { c1, c2 } = connectorControls(ports.from, ports.to);

  expect(rounded).toEqual({ x: -192, y: 0, width: 192, height: 192 });
  for (const point of [ports.from, ports.to, c1, c2]) {
    expect(point.x).toBeGreaterThanOrEqual(rounded.x);
    expect(point.y).toBeGreaterThanOrEqual(rounded.y);
    expect(point.x).toBeLessThanOrEqual(rounded.x + rounded.width);
    expect(point.y).toBeLessThanOrEqual(rounded.y + rounded.height);
  }
  expect(bounds.x).toBe(-160);
});

test("a move within one rounded box produces exactly the same fields", () => {
  const scene = oneConnectorScene();
  const before = sceneBounds(scene);
  move(scene, 20);
  expect(sceneBounds(scene)).toEqual(before);
});

test("a move across a rounded boundary changes the origin without clipping", () => {
  const scene = oneConnectorScene();
  const before = sceneBounds(scene);
  if (!before) throw new Error("The fixture must have a layer box.");
  move(scene, 80);
  const after = sceneBounds(scene);
  if (!after) throw new Error("The moved connector must have a layer box.");
  const connector = scene.edges()[0];
  if (!connector) throw new Error("The fixture must have a connector.");
  const ports = scene.edgePorts(connector);
  if (!ports) throw new Error("The moved connector must have ports.");
  const bounds = connectionBounds(ports.from, ports.to);

  expect(after).toEqual({ x: 256, y: 64, width: 128, height: 64 });
  expect([after.x, after.width]).not.toEqual([before.x, before.width]);
  expect(after.x).toBeLessThanOrEqual(bounds.x);
  expect(after.x + after.width).toBeGreaterThanOrEqual(bounds.x + bounds.width);
});

test("four box readers cost one geometry traversal per drag change", () => {
  const scene = oneConnectorScene();
  const afterApply = scene.traversals;
  expect(afterApply).toBe(1);
  const box = connectorLayerBox(scene);
  expect(scene.traversals).toBe(afterApply + 1);
  const readers = readBox(box);
  expectReaderRuns(readers, 1);
  const built = scene.traversals;
  expect(built).toBe(afterApply + 1);

  move(scene, 80);

  expectReaderRuns(readers, 2);
  expect(scene.traversals).toBe(built + 1);
  expect(box()).toEqual({ x: 256, y: 64, width: 128, height: 64 });
});

test("four box readers traverse two connectors once per drag change", () => {
  const scene = countingScene(
    [node("a", 40, 40), node("b", 360, 40), node("c", 680, 40)],
    [edge("a-b", "a", "b"), edge("b-c", "b", "c")],
  );
  const afterApply = scene.traversals;
  expect(afterApply).toBe(2);
  const box = connectorLayerBox(scene);
  expect(scene.traversals).toBe(afterApply + 2);
  const readers = readBox(box);
  expectReaderRuns(readers, 1);
  const built = scene.traversals;
  expect(built).toBe(afterApply + 2);

  move(scene, 80);

  expectReaderRuns(readers, 2);
  expect(scene.traversals).toBe(built + 2);
});

test("a move inside the rounded box wakes no readers, but crossing it wakes each once", () => {
  const scene = oneConnectorScene();
  const afterApply = scene.traversals;
  const box = connectorLayerBox(scene);
  const readers = readBox(box);
  const built = scene.traversals;
  expect(built).toBe(afterApply + 1);
  const before = box();
  if (!before) throw new Error("The fixture must have a layer box.");

  move(scene, 20);

  expect(box()).toEqual({ x: 192, y: 64, width: 192, height: 64 });
  expectReaderRuns(readers, 1);
  expect(scene.traversals).toBe(built + 1);

  move(scene, 80);

  expect(box()).toEqual({ x: 256, y: 64, width: 128, height: 64 });
  expectReaderRuns(readers, 2);
  expect(scene.traversals).toBe(built + 2);
  expect(before.x).not.toBe(box()?.x);
});

test("a view inside the connector box trims it to the view plus margin, rounded out", () => {
  const box = { x: 0, y: 0, width: 4000, height: 3000 };
  const view = { x: 1000, y: 800, width: 390, height: 844 };
  const trimmed = trimConnectorBox(box, view);
  expect(trimmed).toEqual({ x: 896, y: 704, width: 576, height: 1024 });
  // The rounded box still covers the view and its margin.
  expect(trimmed?.x).toBeLessThanOrEqual(view.x - CONNECTOR_VIEW_MARGIN);
  expect(trimmed?.y).toBeLessThanOrEqual(view.y - CONNECTOR_VIEW_MARGIN);
  expect((trimmed?.x ?? 0) + (trimmed?.width ?? 0)).toBeGreaterThanOrEqual(
    view.x + view.width + CONNECTOR_VIEW_MARGIN,
  );
  expect((trimmed?.y ?? 0) + (trimmed?.height ?? 0)).toBeGreaterThanOrEqual(
    view.y + view.height + CONNECTOR_VIEW_MARGIN,
  );
});

test("a view larger than the connector box keeps the rounded box", () => {
  const box = { x: 128, y: 64, width: 320, height: 256 };
  expect(trimConnectorBox(box, { x: -500, y: -500, width: 4000, height: 4000 })).toEqual(box);
});

test("a view beside the connector box leaves no canvas", () => {
  const box = { x: 0, y: 0, width: 320, height: 200 };
  expect(trimConnectorBox(box, { x: 1000, y: 0, width: 390, height: 844 })).toBeNull();
});

test("an unmeasured view keeps the whole connector box", () => {
  const box = { x: 0, y: 0, width: 320, height: 200 };
  expect(trimConnectorBox(box, null)).toBe(box);
  expect(trimConnectorBox(null, { x: 0, y: 0, width: 390, height: 844 })).toBeNull();
});

test("the drawing origin shares the box memo without adding a traversal", () => {
  const scene = oneConnectorScene();
  const afterApply = scene.traversals;
  const box = connectorLayerBox(scene);
  const readers = readBox(box);
  expectReaderRuns(readers, 1);
  const built = scene.traversals;
  expect(built).toBe(afterApply + 1);

  const origin = { x: box()?.x ?? 0, y: box()?.y ?? 0 };
  expect(origin).toEqual({ x: 192, y: 64 });
  expect(scene.traversals).toBe(built);

  move(scene, 80);

  const movedOrigin = { x: box()?.x ?? 0, y: box()?.y ?? 0 };
  expect(movedOrigin).toEqual({ x: 256, y: 64 });
  expectReaderRuns(readers, 2);
  expect(scene.traversals).toBe(built + 1);
});

test("losing every usable connector clears the box and wakes its readers once", () => {
  const scene = oneConnectorScene();
  const afterApply = scene.traversals;
  const box = connectorLayerBox(scene);
  const readers = readBox(box);
  const built = scene.traversals;
  expect(built).toBe(afterApply + 1);
  expect(box()).toEqual({ x: 192, y: 64, width: 192, height: 64 });
  expectReaderRuns(readers, 1);

  scene.apply(snapshot([], []));

  expect(box()).toBeNull();
  expectReaderRuns(readers, 2);
  expect(scene.traversals).toBe(built);
});
