import { expect, test } from "nsh/test";
import { effect } from "nsh";
import type { EdgeSummary, NodeSummary, SceneSnapshot } from "@flow/native";
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

function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return { id, fromId, toId, fromPort: null, toPort: null, kind: "flow", dataJson: "{}" };
}

function snapshot(nodes: NodeSummary[], edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev: 1, nodes, edges };
}

function rect(scene: FlowScene, id: string): BoxGeometry {
  const value = scene.cardRect(id);
  if (!value) throw new Error(`The scene has no card "${id}".`);
  return value;
}

test("reconciles a viewport snapshot and prunes what leaves it", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));

  expect(scene.cardCount()).toBe(2);
  expect(scene.edgeCount()).toBe(1);
  expect(rect(scene, "a")).toEqual({ x: 40, y: 40, width: 200, height: 84 });

  scene.apply(snapshot([node("a", 40, 40)]));
  expect(scene.cardCount()).toBe(1);
  expect(scene.cardRect("b")).toBeNull();
  expect(scene.edgeCount()).toBe(0);
});

test("caps a snapshot but keeps the selected cards and their connector", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0), node("b", 260, 0), node("c", 520, 0)], [edge("a-b", "a", "b")]),
  );
  scene.select(["a", "b"]);

  scene.apply(snapshot([node("c", 520, 0)]), { maxCards: 1 });
  expect(scene.cardRect("a")).not.toBeNull();
  expect(scene.cardRect("b")).not.toBeNull();
  expect(scene.cardRect("c")).not.toBeNull();
  expect(scene.edgeCount()).toBe(1);
});

test("keeps a connector whose far card left the scene", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0)], [{ ...edge("a-b", "a", "b"), toPoint: { x: 2_000, y: 300 } }]),
  );

  // Only the near card is loaded; the edge's far anchor still draws it.
  expect(scene.cardRect("b")).toBeNull();
  expect(scene.edgeCount()).toBe(1);
  const first = scene.edges()[0];
  if (!first) throw new Error("the edge was pruned");
  expect(scene.edgePorts(first)).toEqual({
    from: { x: 200, y: 42 },
    to: { x: 2_000, y: 300 },
  });
  expect(scene.edgeAt(2_000, 300)).toBe("a-b");

  // A moved near card moves its port; the far anchor stays put.
  scene.applyChangeSet({
    changed: [node("a", 0, 100)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(scene.edgePorts(first)?.from).toEqual({ x: 200, y: 142 });
  expect(scene.edgePorts(first)?.to).toEqual({ x: 2_000, y: 300 });
});

test("keeps a connector whose cards both left the scene", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot(
      [],
      [
        {
          ...edge("a-b", "a", "b"),
          fromPoint: { x: 0, y: 0 },
          toPoint: { x: 2_000, y: 300 },
        },
      ],
    ),
  );

  // The curve crosses the viewport, so the read returned the edge with both
  // ports even though neither card is instantiated.
  expect(scene.cardCount()).toBe(0);
  expect(scene.edgeCount()).toBe(1);
  expect(scene.edgeAt(1_000, 150)).toBe("a-b");
});

test("drops a connector that has neither card nor ports", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([], [edge("a-b", "a", "b")]));
  expect(scene.edgeCount()).toBe(0);
});

test("keeps a selected card's connector when a read finds neither card", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0)], [{ ...edge("a-b", "a", "b"), toPoint: { x: 2_000, y: 300 } }]),
  );
  scene.select(["a"]);
  scene.setOverrides(new Map([["a", { x: 0, y: 100, width: 200, height: 84 }]]));

  // A viewport read lands during the drag. It only sees committed geometry:
  // neither card, nor the committed connector box, is inside its rect. The
  // selected card stays pinned, and its far-anchored connector stays with it.
  scene.apply(snapshot([], []));
  expect(scene.cardRect("a")).not.toBeNull();
  expect(scene.edgeCount()).toBe(1);
  const first = scene.edges()[0];
  if (!first) throw new Error("the edge was pruned");
  expect(scene.edgePorts(first)).toEqual({
    from: { x: 200, y: 142 },
    to: { x: 2_000, y: 300 },
  });

  // Releasing the drag keeps it too; the next read catches up.
  scene.applyChangeSet({
    changed: [node("a", 0, 100)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(scene.edgeCount()).toBe(1);
});

test("keeps a far anchor when a change set reports its edge", () => {
  const scene = new FlowScene();
  scene.apply(
    snapshot([node("a", 0, 0)], [{ ...edge("a-b", "a", "b"), toPoint: { x: 2_000, y: 300 } }]),
  );

  scene.applyChangeSet({
    changed: [],
    removed: [],
    edgesChanged: [edge("a-b", "a", "b")],
    edgesRemoved: [],
  });
  expect(scene.edgeCount()).toBe(1);
  const first = scene.edges()[0];
  if (!first) throw new Error("the edge was pruned");
  expect(scene.edgePorts(first)?.to).toEqual({ x: 2_000, y: 300 });
});

test("applies a change set and keeps edges to existing cards", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0)]));

  scene.applyChangeSet({
    changed: [node("b", 300, 0)],
    removed: [],
    edgesChanged: [edge("a-b", "a", "b"), edge("b-x", "b", "x")],
    edgesRemoved: [],
  });
  expect(scene.cardRect("b")).toEqual({ x: 300, y: 0, width: 200, height: 84 });
  expect(scene.edgeCount()).toBe(1);
  expect(scene.edgeEndpoints("a-b")).toEqual({ fromId: "a", toId: "b" });

  scene.applyChangeSet({ changed: [], removed: ["b"], edgesChanged: [], edgesRemoved: [] });
  expect(scene.cardRect("b")).toBeNull();
  expect(scene.edgeCount()).toBe(0);
});

test("notifies geometry bindings when a change set moves a card", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  const xs: (number | undefined)[] = [];
  effect(() => {
    xs.push(scene.cardRect("a")?.x);
  });

  scene.applyChangeSet({
    changed: [node("a", 90, 40)],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(xs.at(-1)).toBe(90);
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

  // Selecting b lifts it above every unselected card, whatever its z.
  scene.select(["b"]);
  expect(scene.cardZ("b")).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.frameZ()).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.frameZ()).toBeLessThan(scene.cardZ("b"));
  expect(scene.nodeAt(60, 50)).toBe("b");
  // The frame's world bounds include the card's title row.
  expect(scene.selectionBounds()).toEqual({ x: 50, y: 14, width: 200, height: 110 });

  // The selected group stacks in selection order: the last one draws on top.
  scene.select(["b", "a"]);
  expect(scene.cardZ("a")).toBeGreaterThan(scene.cardZ("b"));
  expect(scene.selectionBounds()).toEqual({ x: 0, y: -26, width: 250, height: 150 });
  // Merged frame pluses sit above the selection; the preview stays above them.
  expect(scene.framePlusZ()).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.previewZ()).toBeGreaterThan(scene.framePlusZ());
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

test("keeps transient geometry ahead of the document until it is committed", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));

  scene.setOverrides(new Map([["a", { x: 90, y: 60, width: 220, height: 100 }]]));
  expect(rect(scene, "a")).toEqual({ x: 90, y: 60, width: 220, height: 100 });
  expect(scene.commitBounds()).toEqual([{ id: "a", x: 90, y: 60, width: 220, height: 100 }]);

  // The document's answer clears the override when it matches.
  scene.applyChangeSet({
    changed: [node("a", 90, 60, { width: 220, height: 100 })],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(scene.overrides().size).toBe(0);
  expect(rect(scene, "a")).toEqual({ x: 90, y: 60, width: 220, height: 100 });
});

test("drops the overrides on a cancelled gesture", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40)]));
  scene.setOverrides(new Map([["a", { x: 1, y: 2, width: 3, height: 4 }]]));

  scene.clearOverrides();
  expect(scene.overrides().size).toBe(0);
  expect(rect(scene, "a")).toEqual({ x: 40, y: 40, width: 200, height: 84 });
});

test("a drag's overrides notify only the cards it moves", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)]));
  let runsA = 0;
  let runsB = 0;
  effect(() => {
    scene.cardRect("a");
    runsA += 1;
  });
  effect(() => {
    scene.cardRect("b");
    runsB += 1;
  });

  scene.setOverrides(new Map([["a", { x: 90, y: 40, width: 200, height: 84 }]]));
  expect(rect(scene, "a")).toEqual({ x: 90, y: 40, width: 200, height: 84 });
  expect(runsA).toBe(2);
  // A drag commits only what it moves: the other cards' geometry bindings
  // (and the connectors reading them) do not run.
  expect(runsB).toBe(1);
});

test("a group drag step wakes a reader of every moved card once", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)]));
  let runs = 0;
  effect(() => {
    scene.cardRect("a");
    scene.cardRect("b");
    scene.cardRect("c");
    runs += 1;
  });

  scene.setOverrides(
    new Map([
      ["a", { x: 50, y: 0, width: 200, height: 84 }],
      ["b", { x: 350, y: 0, width: 200, height: 84 }],
      ["c", { x: 650, y: 0, width: 200, height: 84 }],
    ]),
  );
  expect(runs).toBe(2);
  expect(scene.cardRect("a")?.x).toBe(50);
  expect(scene.cardRect("b")?.x).toBe(350);
  expect(scene.cardRect("c")?.x).toBe(650);
});

test("dropping a group's overrides wakes its readers once", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0), node("c", 600, 0)]));
  let runs = 0;
  effect(() => {
    scene.cardRect("a");
    scene.cardRect("b");
    scene.cardRect("c");
    runs += 1;
  });
  scene.setOverrides(
    new Map([
      ["a", { x: 50, y: 0, width: 200, height: 84 }],
      ["b", { x: 350, y: 0, width: 200, height: 84 }],
      ["c", { x: 650, y: 0, width: 200, height: 84 }],
    ]),
  );
  const before = runs;

  scene.clearOverrides();
  expect(runs).toBe(before + 1);
});

test("a snapshot updates the selected edge and the lists in one round", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 40, 40), node("b", 360, 40)], [edge("a-b", "a", "b")]));
  scene.selectEdge("a-b");
  let runs = 0;
  effect(() => {
    const selectedEdge = scene.selectedEdge();
    const counts = [scene.nodes().length, scene.edges().length];
    runs += 1;
    void selectedEdge;
    void counts;
  });
  const before = runs;

  scene.apply(snapshot([node("a", 40, 40)], []));
  expect(runs).toBe(before + 1);
  expect(scene.selectedEdge()).toBeNull();
  expect(scene.edgeCount()).toBe(0);
});

test("finds ports, cards and connectors in world coordinates", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)], [edge("a-b", "a", "b")]));

  expect(scene.portWorld("a", "out")).toEqual({ x: 200, y: 42 });
  expect(scene.portZoneAt(210, 42)).toEqual({
    nodeId: "a",
    side: "out",
    point: { x: 210, y: 42 },
  });
  expect(scene.portZoneAt(290, 42)).toEqual({
    nodeId: "b",
    side: "in",
    point: { x: 290, y: 42 },
  });
  expect(scene.nodeAt(100, 30)).toBe("a");
  expect(scene.nodeAt(250, 30)).toBeNull();
  expect(scene.edgeAt(250, 42)).toBe("a-b");
  expect(scene.kindOf("a")).toBe("text");
});

test("the topmost card owns an overlapping side zone", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("low", 0, 0, { z: 0 }), node("high", 0, 0, { z: 5 })]));

  expect(scene.portZoneAt(210, 42)).toEqual({
    nodeId: "high",
    side: "out",
    point: { x: 210, y: 42 },
  });
});

test("a card under the pointer hides a lower card's side zone", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("cover", 190, 0, { z: 5 })]));

  // (204, 42) is in a's output zone but the cover card is in front of it.
  expect(scene.portZoneAt(204, 42)).toBeNull();
});

test("picks the topmost card under a point", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("low", 0, 0, { z: 0 }), node("high", 40, 20, { z: 5 })]));

  expect(scene.nodeAt(100, 50)).toBe("high");
});

test("previews only the cards in the scene", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0, { kind: "image", outputBatchId: "batch" })]));

  expect(scene.previewTargets()).toEqual([{ id: "a", batchId: "batch" }]);
  scene.applyPreviews([
    { nodeId: "a", urls: ["data:image/png;base64,x"], count: 1 },
    { nodeId: "ghost", urls: [], count: 0 },
  ]);
  expect(scene.previews().get("a")?.count).toBe(1);
  expect(scene.previews().has("ghost")).toBe(false);
});

test("publishes and clears the connection preview", () => {
  const scene = new FlowScene();
  scene.setConnectionPreview({ x: 1, y: 2 }, { x: 3, y: 4 });
  expect(scene.connectionPreview()).toEqual({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  expect(scene.connectionPreviews()).toEqual([{ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }]);

  // A group drag publishes one line per fixed end.
  scene.setConnectionPreviews([
    { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
    { from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
  ]);
  expect(scene.connectionPreviews()).toHaveLength(2);
  // An equal write keeps the signal's value, so the canvas does not redraw.
  const current = scene.connectionPreviews();
  scene.setConnectionPreviews([
    { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
    { from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
  ]);
  expect(scene.connectionPreviews()).toBe(current);

  scene.setConnectionPreviews([]);
  expect(scene.connectionPreview()).toBeNull();
  expect(scene.connectionPreviews()).toBeNull();
});

test("knows whether a pair is already connected", () => {
  const scene = new FlowScene();
  scene.apply(snapshot([node("a", 0, 0), node("b", 300, 0)], [edge("a-b", "a", "b")]));
  expect(scene.hasEdge("a", "b")).toBe(true);
  expect(scene.hasEdge("b", "a")).toBe(false);
});
