import { expect, test } from "nsh/test";
import { effect } from "nsh";
import type { NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import { CanvasCamera } from "./camera";
import { type CanvasHost, CanvasController } from "./canvas-controller";
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

interface Calls {
  readonly pans: { dx: number; dy: number }[];
  readonly commits: (readonly NodeBounds[])[];
  readonly edges: (string | null)[];
  readonly inline: string[];
  readonly cards: string[];
}

function setup(nodes: NodeSummary[]): {
  scene: FlowScene;
  camera: CanvasCamera;
  controller: CanvasController;
  calls: Calls;
} {
  const scene = new FlowScene();
  scene.apply(snapshot(nodes));
  const camera = new CanvasCamera();
  const calls: Calls = {
    pans: [],
    commits: [],
    edges: [],
    inline: [],
    cards: [],
  };
  const host: CanvasHost = {
    scene: () => scene,
    camera: () => camera,
    panBy: (dx, dy) => calls.pans.push({ dx, dy }),
    commitBounds: (bounds) => calls.commits.push(bounds),
    selectEdge: (id) => {
      calls.edges.push(id);
      scene.selectEdge(id);
    },
    reconnectEdge: () => undefined,
    connectNodes: () => undefined,
    openInline: (nodeId) => calls.inline.push(nodeId),
    onCardPress: (nodeId) => calls.cards.push(nodeId),
  };
  return {
    scene,
    camera,
    controller: new CanvasController(host),
    calls,
  };
}

test("selects a card on press and commits a dragged position", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  expect(scene.selectedIds()).toEqual(["a"]);
  expect(calls.cards).toEqual(["a"]);
  expect(controller.gesturing()).toBe(true);
  expect(controller.cursor()).toBe("grabbing");

  controller.move(190, 160);
  expect(scene.cardRect("a")).toEqual({ x: 140, y: 140, width: 200, height: 84 });

  controller.up(190, 160);
  expect(controller.gesturing()).toBe(false);
  expect(calls.commits).toEqual([[{ id: "a", x: 140, y: 140, width: 200, height: 84 }]]);
});

test("a selected card click does not become a moved gesture", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);
  scene.select(["a"]);
  controller.down(150, 120, false, 1);
  expect([controller.gesturing(), controller.gestureMoved()]).toEqual([true, false]);
  controller.up(150, 120);
  expect([controller.gesturing(), controller.gestureMoved()]).toEqual([false, false]);
  expect(calls.commits).toEqual([]);
});

test("a drag or resize past the threshold publishes movement until it ends", () => {
  const { controller } = setup([node("a", 100, 100)]);
  controller.down(150, 120, false, 1);
  controller.move(155, 120);
  expect(controller.gestureMoved()).toBe(true);
  controller.cancel();
  expect(controller.gestureMoved()).toBe(false);

  // A cancelled drag restored the card, so its corner handle resizes it.
  controller.down(300, 184, false, 1);
  controller.move(305, 184);
  expect(controller.gestureMoved()).toBe(true);
  controller.up(305, 184);
  expect(controller.gestureMoved()).toBe(false);
});

test("drops the override when a drag ends where it began", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  controller.move(190, 160);
  controller.move(150, 120);
  expect(scene.overrides().size).toBe(1);

  controller.up(150, 120);
  expect(scene.overrides().size).toBe(0);
  expect(calls.commits).toEqual([]);
});

test("cancels a drag without committing it", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 1);
  controller.move(190, 160);
  expect(scene.overrides().size).toBe(1);

  controller.cancel();
  expect(scene.overrides().size).toBe(0);
  expect(controller.gesturing()).toBe(false);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 100, width: 200, height: 84 });
  expect(calls.commits).toEqual([]);
  expect(controller.cursor()).toBe("default");
});

test("shift-click toggles the selection", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(150, 120, false, 1);
  controller.up(150, 120);
  controller.down(450, 120, true, 1);
  controller.up(450, 120);
  expect(scene.selectedIds()).toEqual(["a", "b"]);

  controller.down(150, 120, true, 1);
  controller.up(150, 120);
  expect(scene.selectedIds()).toEqual(["b"]);
});

test("shift-deselect does not re-add the card when the release jitters", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  scene.select(["a", "b"]);

  controller.down(150, 120, true, 1);
  expect(scene.selectedIds()).toEqual(["b"]);
  controller.move(152, 121);
  controller.up(152, 121);
  expect(scene.selectedIds()).toEqual(["b"]);
});

test("box-selects only the cards the marquee covers", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  expect(scene.selectedIds()).toEqual([]);
  expect(controller.marquee()).toEqual({ x: 50, y: 50, width: 0, height: 0 });

  controller.move(350, 220);
  expect(controller.marquee()).toEqual({ x: 50, y: 50, width: 300, height: 170 });

  controller.up(350, 220);
  expect(scene.selectedIds()).toEqual(["a"]);
  expect(controller.marquee()).toBeNull();
});

test("a box selection's release never shows a multi-card selection without its frame", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  const broken: boolean[] = [];
  effect(() => {
    broken.push(scene.selection().length > 1 && !controller.multiFrame());
  });

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);

  expect(broken).not.toContain(true);
  expect(controller.multiFrame()).toBe(true);
});

test("an idle move onto a typed port updates hover state in one round", () => {
  const { controller } = setup([node("a", 0, 0)]);
  let runs = 0;
  effect(() => {
    controller.hovered();
    controller.cursor();
    runs += 1;
  });
  const before = runs;

  // The text output port's icon sits just right of the card's border.
  controller.hover(214, 46);

  expect(runs).toBe(before + 1);
  expect(controller.hovered()).toBe("a");
  expect(controller.cursor()).toBe("crosshair");
});

test("a marquee that ends with one card leaves a normal selection", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(250, 120);
  controller.up(250, 120);

  expect(scene.selectedIds()).toEqual(["a"]);
  // No group frame: the card takes the selection a press gives it, and its
  // own ports stay.
  expect(controller.marqueeSelected()).toBe(false);
  expect(controller.multiFrame()).toBe(false);
});

test("previews the cards a marquee covers before it is released", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  expect(controller.marqueePreview().size).toBe(0);
  expect(scene.selectedIds()).toEqual([]);

  controller.move(250, 120);
  expect(controller.marqueePreview().has("a")).toBe(true);
  // A preview is not a commit: the selection changes only on release.
  expect(scene.selectedIds()).toEqual([]);

  // The same covered set keeps the signal's value instead of rerendering rows.
  const preview = controller.marqueePreview();
  controller.move(260, 130);
  expect(controller.marqueePreview()).toBe(preview);

  controller.move(500, 220);
  expect([...controller.marqueePreview()]).toEqual(["a", "b"]);

  controller.up(500, 220);
  expect(scene.selectedIds()).toEqual(["a", "b"]);
  expect(controller.marqueePreview().size).toBe(0);
});

test("a shift marquee previews the selection it adds to", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  scene.select(["a"]);

  controller.down(350, 50, true, 1);
  controller.move(500, 220);
  expect([...controller.marqueePreview()]).toEqual(["a", "b"]);

  controller.up(500, 220);
  expect(scene.selectedIds()).toEqual(["a", "b"]);
});

test("drops a marquee preview when the gesture is cancelled", () => {
  const { controller } = setup([node("a", 100, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(250, 120);
  expect(controller.marqueePreview().size).toBe(1);

  controller.cancel();
  expect(controller.marqueePreview().size).toBe(0);
  expect(controller.marqueeSelected()).toBe(false);
});

test("keeps a marquee's frame while the pointer acts inside it", () => {
  const { controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);
  expect(controller.marqueeSelected()).toBe(true);
  // The union includes each card's title row above its body.
  expect(controller.selectionBounds()).toEqual({ x: 100, y: 74, width: 500, height: 110 });

  // Pressing a selected card keeps the frame: it drags the whole group
  // instead of replacing the selection with a click selection.
  controller.down(150, 120, false, 1);
  expect(controller.marqueeSelected()).toBe(true);
  controller.move(200, 170);
  expect(controller.selectionBounds()).toEqual({ x: 150, y: 124, width: 500, height: 110 });
  controller.up(200, 170);
  expect(controller.marqueeSelected()).toBe(true);
});

test("drags a marquee selection from the empty space inside its frame", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);
  expect(scene.selectedIds()).toEqual(["a", "b"]);

  // The gap between the cards is inside the frame: it drags the selection.
  controller.hover(350, 150);
  expect(controller.cursor()).toBe("grab");

  controller.down(350, 150, false, 1);
  expect(scene.selectedIds()).toEqual(["a", "b"]);
  expect(controller.marquee()).toBeNull();
  expect(controller.gesturing()).toBe(true);

  controller.move(450, 200);
  expect(scene.cardRect("a")).toEqual({ x: 200, y: 150, width: 200, height: 84 });
  expect(scene.cardRect("b")).toEqual({ x: 500, y: 150, width: 200, height: 84 });

  controller.up(450, 200);
  expect(calls.commits).toEqual([
    [
      { id: "a", x: 200, y: 150, width: 200, height: 84 },
      { id: "b", x: 500, y: 150, width: 200, height: 84 },
    ],
  ]);
  expect(scene.selectedIds()).toEqual(["a", "b"]);
});

test("drags a marquee selection from a card border inside its frame", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);

  // (300, 110) is card a's east border, above its plus zone. Inside the
  // frame it belongs to the group drag surface, not the resize handle.
  controller.hover(300, 110);
  expect(controller.cursor()).toBe("grab");

  controller.down(300, 110, false, 1);
  expect(controller.gesturing()).toBe(true);
  controller.move(350, 160);
  expect(scene.cardRect("a")).toEqual({ x: 150, y: 150, width: 200, height: 84 });
  expect(scene.cardRect("b")).toEqual({ x: 450, y: 150, width: 200, height: 84 });
  controller.up(350, 160);
});

test("a press outside the frame clears the marquee selection", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);

  controller.down(50, 50, false, 1);
  controller.move(650, 220);
  controller.up(650, 220);
  expect(scene.selectedIds()).toEqual(["a", "b"]);

  controller.down(50, 50, false, 1);
  expect(scene.selectedIds()).toEqual([]);
  expect(controller.marqueeSelected()).toBe(false);
  expect(controller.marquee()).not.toBeNull();
  controller.cancel();
});

test("reports selection bounds in screen space", () => {
  const { scene, camera, controller } = setup([node("a", 100, 100), node("b", 400, 100)]);
  scene.select(["a", "b"]);
  camera.x = 10;
  camera.y = 20;
  camera.scale = 2;

  expect(controller.selectionBounds()).toEqual({ x: 210, y: 168, width: 1000, height: 220 });
});

test("resizes the card from its handle without selecting it first", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  controller.down(300, 184, false, 1);
  expect(scene.selectedIds()).toEqual(["a"]);
  expect(controller.cursor()).toBe("nwse-resize");
  expect(controller.gesturing()).toBe(true);

  // The corner keeps the card's aspect ratio: the equal relative deltas
  // scale the 200×84 card by 1.25.
  controller.move(350, 205);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 100, width: 250, height: 105 });

  controller.up(350, 205);
  expect(controller.gesturing()).toBe(false);
  expect(calls.commits).toEqual([[{ id: "a", x: 100, y: 100, width: 250, height: 105 }]]);
});

test("shows a resize cursor over any card's handle", () => {
  const { controller } = setup([node("a", 100, 100)]);

  controller.hover(300, 184);
  expect(controller.cursor()).toBe("nwse-resize");
  expect(controller.hovered()).toBe("a");
});

test("resizes from anywhere along an edge", () => {
  const { scene, controller, calls } = setup([node("a", 100, 100)]);

  // The top edge, away from its midpoint and corners.
  controller.hover(170, 100);
  expect(controller.cursor()).toBe("ns-resize");
  expect(controller.hovered()).toBe("a");

  controller.down(170, 100, false, 1);
  expect(controller.cursor()).toBe("ns-resize");
  controller.move(170, 90);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 90, width: 200, height: 94 });

  controller.up(170, 90);
  expect(calls.commits).toEqual([[{ id: "a", x: 100, y: 90, width: 200, height: 94 }]]);
});

test("starts a resize from just outside a corner", () => {
  const { scene, controller } = setup([node("a", 100, 100)]);

  controller.down(305, 189, false, 1);
  expect(controller.cursor()).toBe("nwse-resize");
  controller.move(355, 210);
  expect(scene.cardRect("a")).toEqual({ x: 100, y: 100, width: 250, height: 105 });
  controller.cancel();
});

test("does not resize a card through the card above it", () => {
  const { scene, controller } = setup([node("a", 0, 0), node("b", 180, 60)]);

  // (200, 84) is card a's bottom-right handle but lies inside card b, which
  // takes the press as a drag instead of resizing the hidden card.
  controller.down(200, 84, false, 1);
  expect(scene.selectedIds()).toEqual(["b"]);
  controller.move(230, 100);
  expect(scene.cardRect("a")).toEqual({ x: 0, y: 0, width: 200, height: 84 });
  expect(scene.cardRect("b")).toEqual({ x: 210, y: 76, width: 200, height: 84 });
  controller.cancel();
});

test("prefers a typed port over the east resize handle", () => {
  const { scene, controller } = setup([node("a", 100, 100)]);
  scene.select(["a"]);

  // (314, 146) is the output port's icon, inside the east handle's reach.
  controller.hover(305, 142);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.hovered()).toBe("a");
  controller.down(305, 142, false, 1);
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.gesturing()).toBe(true);
  controller.cancel();
});

test("a port marks its card while the pointer is on it", () => {
  const { controller } = setup([node("a", 0, 0)]);

  controller.hover(214, 46);
  expect(controller.hovered()).toBe("a");
  expect(controller.cursor()).toBe("crosshair");
  expect(controller.hoveredPort()).toEqual({
    nodeId: "a",
    side: "out",
    portId: "text",
    point: { x: 214, y: 46 },
    center: { x: 214, y: 42 },
  });

  // Off the port, the pointer is over empty canvas: no hover, no crosshair.
  controller.hover(214, 120);
  expect(controller.hovered()).toBeNull();
  expect(controller.hoveredPort()).toBeNull();
  expect(controller.cursor()).toBe("default");
  // Inside the card, the card itself is hovered.
  controller.hover(100, 30);
  expect(controller.hovered()).toBe("a");
  expect(controller.cursor()).toBe("default");
});

test("reads the hover from where a gesture ends, not where it began", () => {
  const { scene, controller } = setup([node("a", 100, 100), node("b", 700, 100)]);
  controller.hover(150, 120);
  expect(controller.hovered()).toBe("a");

  // A marquee that starts on empty canvas and ends over card b: the hover
  // belongs to b once the gesture is over, not to the card it began over.
  controller.down(500, 300, false, 1);
  controller.move(750, 120);
  controller.up(750, 120);

  expect(scene.selectedIds()).toEqual(["b"]);
  expect(controller.hovered()).toBe("b");

  // A resize released beyond the card's border leaves no hover behind.
  // The east border is used below its port so the press resizes.
  controller.down(300, 110, false, 1);
  controller.move(350, 110);
  controller.up(365, 110);
  expect(controller.hovered()).toBeNull();
  expect(controller.cursor()).toBe("default");
});

test("opens the inline editor on a double-clicked text card", () => {
  const { controller, calls } = setup([node("a", 100, 100)]);

  controller.down(150, 120, false, 2);
  expect(calls.inline).toEqual(["a"]);
});
