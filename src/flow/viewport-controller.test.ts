import { expect, test } from "nsh/test";
import type { Document, EdgeSummary, NodeSummary, SceneSnapshot, Viewport } from "@flow/native";
import { CanvasCamera, type CameraScheduler } from "./camera";
import { FlowScene } from "./scene";
import { ViewportController, type ViewportHost } from "./viewport-controller";

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

function snapshot(nodes: NodeSummary[], rev: number, edges: EdgeSummary[] = []): SceneSnapshot {
  return { rev, nodes, edges };
}

interface DeferredRead {
  readonly rect: Viewport;
  readonly margin: number;
  readonly resolve: (snapshot: SceneSnapshot) => void;
}

function stubDocument(deferreds: DeferredRead[]): Document {
  const stub = {
    scene: (rect: Viewport, margin: number): Promise<SceneSnapshot> =>
      new Promise((resolve) => {
        deferreds.push({ rect, margin, resolve });
      }),
  };
  return stub as unknown as Document;
}

/** No timers: camera writes in these tests need not settle. */
const inertScheduler: CameraScheduler = {
  schedule: () => ({ cancel: () => {} }),
  cancel: () => {},
};

interface Fixture {
  readonly controller: ViewportController;
  readonly camera: CanvasCamera;
  readonly scene: FlowScene;
  readonly deferreds: DeferredRead[];
  dispose(): void;
}

function setup(): Fixture {
  const camera = new CanvasCamera({ scheduler: inertScheduler });
  const scene = new FlowScene();
  const deferreds: DeferredRead[] = [];
  const document = stubDocument(deferreds);
  let disposed = false;
  const host: ViewportHost = {
    camera: () => camera,
    scene: () => scene,
    document: () => document,
    applyChanges: () => {},
    schedulePreviews: () => {},
    publishZoom: () => {},
    isDisposed: () => disposed,
  };
  const controller = new ViewportController(host);
  controller.setSize(800, 600);
  return {
    controller,
    camera,
    scene,
    deferreds,
    dispose: () => {
      disposed = true;
      controller.dispose();
    },
  };
}

function take(deferreds: DeferredRead[], index: number): DeferredRead {
  const read = deferreds[index];
  if (!read) throw new Error(`Expected scene read ${index}, found ${deferreds.length}.`);
  return read;
}

/** Two microtask turns are enough for one issued read to register its successor. */
async function flushRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("three refreshes during one pending read cause exactly two scene reads and the last applied rect is the latest", async () => {
  const fixture = setup();
  const { controller, camera, scene, deferreds } = fixture;
  try {
    const first = controller.refresh();
    expect(deferreds).toHaveLength(1);

    camera.x = -100;
    const second = controller.refresh();
    camera.x = -250;
    const third = controller.refresh();

    // The two joined refreshes ask for a follow-up; they do not issue reads.
    expect(deferreds).toHaveLength(1);

    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();

    expect(deferreds).toHaveLength(2);
    expect(take(deferreds, 1).rect.x).toBe(250);

    take(deferreds, 1).resolve(snapshot([node("a", 50, 0)], 2));
    await Promise.all([first, second, third]);

    expect(deferreds).toHaveLength(2);
    expect(scene.cardRect("a")?.x).toBe(50);
  } finally {
    fixture.dispose();
  }
});

test("awaiting a refresh that joined an in-flight read resolves only after the follow-up read", async () => {
  const fixture = setup();
  const { controller, camera, deferreds } = fixture;
  try {
    let firstSettled = false;
    let joinedSettled = false;
    const first = controller.refresh().then(() => {
      firstSettled = true;
    });
    camera.x = -120;
    const joined = controller.refresh().then(() => {
      joinedSettled = true;
    });

    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();

    expect(deferreds).toHaveLength(2);
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);

    take(deferreds, 1).resolve(snapshot([node("a", 10, 0)], 2));
    await Promise.all([first, joined]);

    expect(firstSettled).toBe(true);
    expect(joinedSettled).toBe(true);
  } finally {
    fixture.dispose();
  }
});

test("a refresh that arrives after the queue drained starts a new read", async () => {
  const fixture = setup();
  const { controller, deferreds } = fixture;
  try {
    const first = controller.refresh();
    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await first;
    expect(deferreds).toHaveLength(1);

    const second = controller.refresh();
    expect(deferreds).toHaveLength(2);
    take(deferreds, 1).resolve(snapshot([node("a", 10, 0)], 2));
    await second;
    expect(deferreds).toHaveLength(2);
  } finally {
    fixture.dispose();
  }
});

test("a refresh during dispose does not enqueue", async () => {
  const fixture = setup();
  try {
    fixture.dispose();
    await fixture.controller.refresh();
    expect(fixture.deferreds).toHaveLength(0);
  } finally {
    fixture.dispose();
  }
});

test("disposing mid-drain resolves joined callers without a follow-up read", async () => {
  const fixture = setup();
  const { controller, camera, deferreds } = fixture;
  try {
    const first = controller.refresh();
    camera.x = -90;
    const joined = controller.refresh();

    fixture.dispose();
    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();

    // The held read settles the drain; the newest rect is deliberately dropped.
    expect(deferreds).toHaveLength(1);
    await Promise.all([first, joined]);
  } finally {
    fixture.dispose();
  }
});
