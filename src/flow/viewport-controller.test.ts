import { expect, test } from "nsh/test";
import type { Document, EdgeSummary, NodeSummary, SceneSnapshot, Viewport } from "@flow/native";
import { CanvasCamera, type CameraScheduler } from "./camera";
import { FlowScene } from "./scene";
import {
  ViewportController,
  type ViewportHost,
  type ViewportScheduler,
} from "./viewport-controller";

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

interface DeferredBounds {
  readonly resolve: (bounds: Viewport) => void;
}

function stubDocument(deferreds: DeferredRead[], boundsDeferreds: DeferredBounds[] = []): Document {
  const stub = {
    scene: (rect: Viewport, margin: number): Promise<SceneSnapshot> =>
      new Promise((resolve) => {
        deferreds.push({ rect, margin, resolve });
      }),
    bounds: (): Promise<Viewport> =>
      new Promise((resolve) => {
        boundsDeferreds.push({ resolve });
      }),
  };
  return stub as unknown as Document;
}

/** No timers: camera writes in these tests need not settle. */
const inertScheduler: CameraScheduler = {
  schedule: () => ({ cancel: () => {} }),
  cancel: () => {},
};

/** Records the controller's one timer so tests drive it without waiting. */
class FakeViewportScheduler implements ViewportScheduler {
  private callbacks = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(callback: () => void, _delay: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.callbacks.delete(id);
  }

  get armed(): number {
    return this.callbacks.size;
  }

  runDue(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

interface Fixture {
  readonly controller: ViewportController;
  readonly camera: CanvasCamera;
  readonly scene: FlowScene;
  readonly deferreds: DeferredRead[];
  readonly boundsDeferreds: DeferredBounds[];
  readonly scheduler: FakeViewportScheduler;
  dispose(): void;
}

function setup(): Fixture {
  const camera = new CanvasCamera({ scheduler: inertScheduler });
  const scene = new FlowScene();
  const deferreds: DeferredRead[] = [];
  const boundsDeferreds: DeferredBounds[] = [];
  const scheduler = new FakeViewportScheduler();
  const document = stubDocument(deferreds, boundsDeferreds);
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
  const controller = new ViewportController(host, scheduler);
  controller.setSize(800, 600);
  return {
    controller,
    camera,
    scene,
    deferreds,
    boundsDeferreds,
    scheduler,
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

function takeBounds(deferreds: DeferredBounds[], index: number): DeferredBounds {
  const read = deferreds[index];
  if (!read) throw new Error(`Expected bounds read ${index}, found ${deferreds.length}.`);
  return read;
}

/** Two microtask turns are enough for one issued read to register its successor. */
async function flushRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("centering from the minimap moves the camera and schedules a read", () => {
  const fixture = setup();
  try {
    const { controller, camera, deferreds, scheduler } = fixture;
    camera.scale = 0.5;

    controller.centerOn(300, 200);
    expect(camera.toScreen(300, 200)).toEqual({ x: 400, y: 300 });
    expect(scheduler.armed).toBe(1);

    scheduler.runDue();
    expect(deferreds).toHaveLength(1);
    expect(take(deferreds, 0).rect.x).toBe(-500);
  } finally {
    fixture.dispose();
  }
});

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

test("coalesces automatic fits into the newest stage size", async () => {
  const fixture = setup();
  const { controller, camera, deferreds, boundsDeferreds, scheduler } = fixture;
  try {
    controller.onResize(800, 600);
    controller.onResize(1024, 700);
    expect(scheduler.armed).toBe(1);

    scheduler.runDue();
    expect(boundsDeferreds).toHaveLength(1);
    expect(deferreds).toHaveLength(0);

    const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
    takeBounds(boundsDeferreds, 0).resolve(bounds);
    await flushRead();

    expect(boundsDeferreds).toHaveLength(1);
    expect(deferreds).toHaveLength(1);
    const expected = new CanvasCamera({ scheduler: inertScheduler });
    const expectedScale = expected.fit(bounds, { width: 1024, height: 700 });
    expected.dispose();
    expect(camera.scale).toBe(expectedScale);
    expect(take(deferreds, 0).rect).toEqual(camera.visibleBounds({ width: 1024, height: 700 }));

    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();
    expect(deferreds).toHaveLength(1);
  } finally {
    fixture.dispose();
  }
});

test("a manually moved camera does not refit on resize", async () => {
  const fixture = setup();
  const { controller, deferreds, boundsDeferreds, scheduler } = fixture;
  try {
    controller.userMoved();
    controller.onResize(1024, 700);
    expect(scheduler.armed).toBe(1);

    scheduler.runDue();
    expect(boundsDeferreds).toHaveLength(0);
    expect(deferreds).toHaveLength(1);

    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();
    expect(deferreds).toHaveLength(1);
  } finally {
    fixture.dispose();
  }
});

test("a pending fit cannot apply stale bounds", async () => {
  const fixture = setup();
  const { controller, camera, deferreds, boundsDeferreds } = fixture;
  try {
    controller.onResize(1024, 700);
    const first = controller.refresh();
    const joined = controller.refresh();
    let firstSettled = false;
    let joinedSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    void joined.then(() => {
      joinedSettled = true;
    });

    expect(boundsDeferreds).toHaveLength(1);
    expect(deferreds).toHaveLength(0);

    controller.onResize(1280, 800);
    takeBounds(boundsDeferreds, 0).resolve({ x: 0, y: 0, width: 1000, height: 1000 });
    await flushRead();

    // The first fit's bounds are stale; the camera stays put for this read.
    expect(camera.scale).toBe(1);
    expect(deferreds).toHaveLength(1);
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);

    take(deferreds, 0).resolve(snapshot([node("a", 0, 0)], 1));
    await flushRead();

    // The resize that arrived during the read owns the next fit.
    expect(boundsDeferreds).toHaveLength(2);
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);

    const newest = { x: 0, y: 0, width: 2000, height: 1200 };
    takeBounds(boundsDeferreds, 1).resolve(newest);
    await flushRead();

    const expected = new CanvasCamera({ scheduler: inertScheduler });
    const expectedScale = expected.fit(newest, { width: 1280, height: 800 });
    expected.dispose();
    expect(camera.scale).toBe(expectedScale);
    expect(take(deferreds, 1).rect).toEqual(camera.visibleBounds({ width: 1280, height: 800 }));
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);

    take(deferreds, 1).resolve(snapshot([node("a", 10, 0)], 2));
    await Promise.all([first, joined]);
    expect(firstSettled).toBe(true);
    expect(joinedSettled).toBe(true);
    expect(deferreds).toHaveLength(2);
    expect(boundsDeferreds).toHaveLength(2);
  } finally {
    fixture.dispose();
  }
});

test("disposal cancels a pending automatic fit", async () => {
  const fixture = setup();
  const { controller, camera, deferreds, boundsDeferreds, scheduler } = fixture;
  controller.onResize(1024, 700);
  expect(scheduler.armed).toBe(1);

  fixture.dispose();
  expect(scheduler.armed).toBe(0);

  scheduler.runDue();
  await flushRead();

  expect(boundsDeferreds).toHaveLength(0);
  expect(deferreds).toHaveLength(0);
  expect(camera.scale).toBe(1);
  expect(camera.view()).toEqual({ x: 0, y: 0, scale: 1 });
});
