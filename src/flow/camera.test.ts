import { effect } from "nsh";
import { expect, test } from "nsh/test";
import {
  CAMERA_MOVE_SETTLE_MS,
  CanvasCamera,
  MAX_SCALE,
  MIN_SCALE,
  WHEEL_NOTCHES_PER_DOUBLING,
  wheelNotches,
  wheelZoomFactor,
  type CameraScheduler,
  type CameraTimer,
} from "./camera";

class FakeCameraScheduler implements CameraScheduler {
  lastDelay: number | null = null;
  writes = 0;
  cancels = 0;
  private callback: (() => void) | null = null;
  private canceled: (() => void) | null = null;

  schedule(callback: () => void, delay: number): CameraTimer {
    this.writes += 1;
    this.lastDelay = delay;
    this.callback = callback;
    return { cancel: () => this.cancelCallback(callback) };
  }

  cancel(timer: CameraTimer): void {
    timer.cancel();
  }

  get active(): boolean {
    return this.callback !== null;
  }

  get pendingCallback(): (() => void) | null {
    return this.callback;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }

  /** Invokes a retained canceled callback to prove disposal gates its work. */
  fireCanceled(): void {
    this.canceled?.();
  }

  private cancelCallback(callback: () => void): void {
    this.cancels += 1;
    if (this.callback === callback) this.callback = null;
    this.canceled = callback;
  }
}

test("maps screen and world points both ways", () => {
  const camera = new CanvasCamera();
  camera.x = 30;
  camera.y = -10;
  camera.scale = 1.5;

  const world = camera.toWorld(180, 140);
  expect(world.x).toBe(100);
  expect(world.y).toBe(100);

  const screen = camera.toScreen(100, 100);
  expect(screen.x).toBe(180);
  expect(screen.y).toBe(140);
});

test("zooms around a screen point", () => {
  const camera = new CanvasCamera();
  camera.x = 20;
  camera.y = 10;
  camera.scale = 1;
  const before = camera.toWorld(150, 90);

  expect(camera.zoomAround(2, 150, 90)).toBe(true);
  expect(camera.scale).toBe(2);

  const after = camera.toWorld(150, 90);
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

test("clamps zoom and pans", () => {
  const camera = new CanvasCamera();
  expect(camera.zoomAround(1000, 0, 0)).toBe(true);
  expect(camera.scale).toBe(MAX_SCALE);
  expect(camera.zoomAround(1000, 0, 0)).toBe(false);
  expect(camera.zoomAround(0.00001, 0, 0)).toBe(true);
  expect(camera.scale).toBe(MIN_SCALE);

  camera.panBy(12, -4);
  expect(camera.x).toBe(12);
  expect(camera.y).toBe(-4);
});

test("fits and centers content", () => {
  const camera = new CanvasCamera();
  const scale = camera.fit(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 800, height: 600 },
    0,
    2,
  );

  expect(scale).toBe(2);
  expect(camera.scale).toBe(2);
  expect(camera.toScreen(200, 100)).toEqual({ x: 400, y: 300 });
});

test("centers a world point without changing the zoom", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  camera.scale = 0.5;

  camera.centerOn(300, 200, { width: 800, height: 600 });
  expect(camera.scale).toBe(0.5);
  expect(camera.toScreen(300, 200)).toEqual({ x: 400, y: 300 });
  expect(scheduler.active).toBe(true);

  const x = camera.x;
  const y = camera.y;
  camera.centerOn(Number.NaN, 0, { width: 800, height: 600 });
  expect(camera.x).toBe(x);
  expect(camera.y).toBe(y);
});

test("keeps its view signal in step with its properties", () => {
  const camera = new CanvasCamera();
  camera.x = 5;
  expect(camera.view().x).toBe(5);
  camera.scale = 0.5;
  expect(camera.view()).toEqual({ x: 5, y: 0, scale: 0.5 });
});

test("turns wheel notches into a zoom factor", () => {
  expect(wheelZoomFactor(0)).toBe(1);
  expect(wheelZoomFactor(WHEEL_NOTCHES_PER_DOUBLING)).toBe(0.5);
  expect(wheelZoomFactor(-WHEEL_NOTCHES_PER_DOUBLING)).toBe(2);
  // A notch down zooms out, a notch up zooms in.
  expect(wheelZoomFactor(1)).toBeLessThan(1);
  expect(wheelZoomFactor(-1)).toBeGreaterThan(1);
});

test("reads a wheel event's delta as notches", () => {
  // A mouse wheel reports lines; one line is one notch on macOS, Linux and
  // the web.
  expect(wheelNotches(2, "lines", "macos")).toBe(2);
  expect(wheelNotches(-1, "lines", "linux")).toBe(-1);
  // Windows reports the system's three lines a notch by default.
  expect(wheelNotches(3, "lines", "windows")).toBe(1);
  expect(wheelNotches(-3, "lines", "windows")).toBe(-1);
  // A precise device (a touchpad) reports points: 48 a notch.
  expect(wheelNotches(48, "points", "macos")).toBe(1);
  expect(wheelNotches(-48, "points", "windows")).toBe(-1);
  expect(wheelNotches(24, "points", "macos")).toBe(0.5);
  expect(wheelNotches(0, "points", "macos")).toBe(0);
});

test("ignores non-finite or non-positive camera values", () => {
  const camera = new CanvasCamera();
  camera.x = Number.NaN;
  camera.y = Number.POSITIVE_INFINITY;
  camera.scale = 0;
  expect(camera.view()).toEqual({ x: 0, y: 0, scale: 1 });

  camera.x = 10;
  camera.scale = -2;
  expect(camera.view()).toEqual({ x: 10, y: 0, scale: 1 });
  camera.dispose();
});

test("marks camera writes and settles once through the fake scheduler", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  try {
    expect(camera.moving()).toBe(false);
    camera.panBy(10, 0);
    expect(camera.moving()).toBe(true);
    expect(scheduler.lastDelay).toBe(CAMERA_MOVE_SETTLE_MS);
    const previous = scheduler.pendingCallback;
    camera.panBy(0, 10);
    expect(scheduler.writes).toBe(2);
    expect(scheduler.cancels).toBe(1);
    previous?.();
    expect(camera.moving()).toBe(true);
    scheduler.fire();
    expect(camera.moving()).toBe(false);
    expect(scheduler.active).toBe(false);
  } finally {
    camera.dispose();
  }
});

test("direct properties, zoom, and fit start camera movement", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  try {
    for (const write of [
      () => {
        camera.x = 1;
      },
      () => {
        camera.y = 1;
      },
      () => {
        camera.scale = 1.5;
      },
      () => {
        camera.zoomAround(1.2, 0, 0);
      },
      () => {
        camera.fit({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 400 });
      },
    ]) {
      scheduler.fire();
      expect(camera.moving()).toBe(false);
      write();
      expect(camera.moving()).toBe(true);
    }
  } finally {
    camera.dispose();
  }
});

test("rejected and no-op camera mutations do not extend movement", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  try {
    camera.panBy(0, 0);
    camera.x = Number.NaN;
    camera.y = Number.POSITIVE_INFINITY;
    camera.scale = 0;
    camera.x = 0;
    camera.y = 0;
    camera.scale = 1;
    expect(camera.zoomAround(Number.NaN, 0, 0)).toBe(false);
    expect(camera.zoomAround(0, 0, 0)).toBe(false);
    expect(camera.zoomAround(1, 0, 0)).toBe(false);
    camera.fit({ x: 0, y: 0, width: 0, height: 100 }, { width: 400, height: 400 });
    camera.fit({ x: Number.NaN, y: 0, width: 100, height: 100 }, { width: 400, height: 400 });
    expect(scheduler.writes).toBe(0);
    camera.zoomAround(1000, 0, 0);
    const afterZoom = scheduler.writes;
    expect(camera.zoomAround(1000, 0, 0)).toBe(false);
    expect(scheduler.writes).toBe(afterZoom);
  } finally {
    camera.dispose();
  }
});

test("dispose cancels movement and safely ignores repeated disposal", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  camera.panBy(10, 0);
  const canceled = scheduler.pendingCallback;
  camera.dispose();
  expect(scheduler.active).toBe(false);
  expect(camera.moving()).toBe(false);
  const cancels = scheduler.cancels;
  camera.dispose();
  expect(scheduler.cancels).toBe(cancels);
  canceled?.();
  scheduler.fireCanceled();
  expect(camera.moving()).toBe(false);
});

test("a new camera write re-arms after the settle callback", () => {
  const scheduler = new FakeCameraScheduler();
  const camera = new CanvasCamera({ scheduler });
  try {
    camera.panBy(10, 0);
    scheduler.fire();
    camera.panBy(10, 0);
    expect(camera.moving()).toBe(true);
    expect(scheduler.writes).toBe(2);
    scheduler.fire();
    expect(camera.moving()).toBe(false);
  } finally {
    camera.dispose();
  }
});

test("scale-only readers do not wake on pan", () => {
  const camera = new CanvasCamera();
  let runs = 0;
  effect(() => {
    camera.scaleView();
    runs += 1;
  });
  expect(runs).toBe(1);

  camera.panBy(10, 20);

  expect(runs).toBe(1);
  expect(camera.scale).toBe(1);
  camera.dispose();
});

test("one zoom publishes view and scale together", () => {
  const camera = new CanvasCamera();
  const seen: Array<{ x: number; y: number; viewScale: number; scale: number }> = [];
  effect(() => {
    const view = camera.view();
    seen.push({ x: view.x, y: view.y, viewScale: view.scale, scale: camera.scaleView() });
  });
  expect(seen).toHaveLength(1);

  expect(camera.zoomAround(2, 150, 90)).toBe(true);

  expect(seen).toHaveLength(2);
  const latest = seen[1];
  if (!latest) throw new Error("the zoom effect must run once");
  expect(latest.viewScale).toBe(2);
  expect(latest.scale).toBe(2);
  expect(latest.x).toBe(-150);
  expect(latest.y).toBe(-90);
  expect(camera.view().scale).toBe(camera.scaleView());
  camera.dispose();
});

test("all camera writes keep scale in sync", () => {
  const camera = new CanvasCamera();
  const inSync = (): void => {
    expect(camera.scale).toBe(camera.view().scale);
    expect(camera.scaleView()).toBe(camera.view().scale);
  };

  camera.x = 30;
  inSync();
  camera.y = -10;
  inSync();
  camera.scale = 1.5;
  inSync();
  expect(
    camera.fit({ x: 100, y: 50, width: 200, height: 100 }, { width: 800, height: 600 }, 0, 2),
  ).toBe(2);
  expect(camera.scale).toBe(2);
  inSync();
  expect(camera.zoomAround(0.5, 0, 0)).toBe(true);
  expect(camera.scale).toBe(1);
  inSync();
  camera.panBy(12, -4);
  expect(camera.scale).toBe(1);
  inSync();
  camera.dispose();
});

test("rejected camera values leave view and scale unchanged", () => {
  const camera = new CanvasCamera();
  camera.x = 10;
  const view = camera.view();

  camera.x = Number.NaN;
  camera.y = Number.POSITIVE_INFINITY;
  camera.scale = 0;
  camera.scale = -2;
  expect(camera.zoomAround(Number.NaN, 0, 0)).toBe(false);
  expect(camera.zoomAround(0, 0, 0)).toBe(false);
  camera.fit({ x: 0, y: 0, width: 0, height: 100 }, { width: 400, height: 400 });
  camera.fit({ x: Number.NaN, y: 0, width: 100, height: 100 }, { width: 400, height: 400 });

  expect(camera.view()).toEqual(view);
  expect(camera.scaleView()).toBe(view.scale);
  expect(camera.scale).toBe(view.scale);
  camera.dispose();
});

test("a clamped zoom keeps the published scale", () => {
  const camera = new CanvasCamera();
  expect(camera.zoomAround(1000, 0, 0)).toBe(true);
  expect(camera.scale).toBe(MAX_SCALE);
  expect(camera.scaleView()).toBe(MAX_SCALE);
  expect(camera.view().scale).toBe(MAX_SCALE);
  camera.dispose();
});
