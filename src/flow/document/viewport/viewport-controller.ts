/**
 * The camera and viewport read loop: fitting, panning, zooming and throttled
 * scene reads. It owns no UI; the page binds the values it publishes.
 */
import {
  AsyncDrain,
  type ChangeSet,
  type Document,
  type DrainStepResult,
  type Viewport,
} from "../../shared";
import type { CanvasCamera, FlowScene } from "../../canvas";

const VIEWPORT_MARGIN = 0.25;
const VIEWPORT_DELAY_MS = 80;

export interface ViewportHost {
  camera(): CanvasCamera | null;
  scene(): FlowScene | null;
  document(): Document | null;
  /** The bounds a fit falls back to while the document is empty or unreadable. */
  fallbackBounds(): Viewport;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
  publishZoom(percent: number): void;
  isDisposed(): boolean;
}

/** The one timer the controller owns; tests inject a deterministic driver. */
export interface ViewportScheduler {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

const SYSTEM_SCHEDULER: ViewportScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
};

export class ViewportController {
  private width = 1;
  private height = 1;
  private timer: number | null = null;
  private generation = 0;
  private cameraGeneration = 0;
  private fitGeneration = 0;
  private pendingFitGeneration: number | null = null;
  private zoomFrame = 0;
  private lastRev = 0;
  private userCamera = false;
  private readonly drain = new AsyncDrain();

  constructor(
    private readonly host: ViewportHost,
    private readonly scheduler: ViewportScheduler = SYSTEM_SCHEDULER,
  ) {}

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** A command's revision: a viewport read that started before it is older. */
  noteRev(rev: number): void {
    this.lastRev = Math.max(this.lastRev, rev);
  }

  /** The camera was moved by the user; a resize must not fit again. */
  userMoved(): void {
    this.userCamera = true;
    this.cameraGeneration += 1;
    // A pan or zoom supersedes an automatic fit already queued or awaiting
    // its bounds read.
    this.fitGeneration += 1;
    this.pendingFitGeneration = null;
  }

  schedule(): void {
    if (this.timer !== null || this.host.isDisposed()) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.host.isDisposed()) void this.refresh();
    }, VIEWPORT_DELAY_MS);
  }

  refresh(): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || this.host.isDisposed()) return Promise.resolve();
    // The camera may have moved since the active read began, so every
    // request that joins asks for the follow-up read.
    const joined = this.drain.join();
    if (joined !== null) return joined;
    return this.drain.start((isDirty) => this.drainStep(document, scene, isDirty));
  }

  /** One queued iteration: a pending fit, then a read of the visible rect. */
  private async drainStep(
    document: Document,
    scene: FlowScene,
    isDirty: () => boolean,
  ): Promise<DrainStepResult> {
    if (this.host.isDisposed()) return "done";
    const pendingFit = this.pendingFitGeneration;
    this.pendingFitGeneration = null;
    if (pendingFit !== null && !this.userCamera) {
      // Apply the newest automatic fit before the scene read; `false` keeps
      // this same drain as the only timer and read path.
      await this.fitToDocument(true, false, pendingFit);
      if (this.host.isDisposed()) return "done";
    }
    const { rect, margin } = this.visibleRect();
    const generation = ++this.generation;
    // The card budget is read before the await so the read and the client
    // slicer agree on the same camera scale for this snapshot.
    const camera = this.host.camera();
    const scale = camera?.scale ?? 1;
    const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
    try {
      const snapshot = await document.scene(rect, margin, maxCards);
      if (
        !this.host.isDisposed() &&
        generation === this.generation &&
        snapshot.rev >= this.lastRev
      ) {
        this.lastRev = snapshot.rev;
        scene.apply(snapshot, { maxCards });
        this.host.schedulePreviews();
      }
    } catch (error) {
      if (!this.host.isDisposed()) console.error("Flow could not read the viewport", error);
    }
    if (this.host.isDisposed()) return "done";
    // A resize or a request arrived during the read: the newest fit must be
    // applied before joined callers observe the drain's settlement.
    if (this.pendingFitGeneration !== null) return "continue";
    return isDirty() ? "continue" : "done";
  }

  /** Publishes the camera's current scale, deferred to the next frame. */
  announceZoom(scale: number): void {
    this.publishZoom(scale);
  }

  async fitToDocument(
    announce = true,
    schedule = true,
    expectedFit: number | null = null,
  ): Promise<void> {
    const document = this.host.document();
    const camera = this.host.camera();
    if (!document || !camera || this.host.isDisposed()) return;
    const generation = this.cameraGeneration;
    let bounds: Viewport = this.host.fallbackBounds();
    try {
      const documentBounds = await document.bounds();
      if (documentBounds.width > 0 || documentBounds.height > 0) bounds = documentBounds;
    } catch (error) {
      if (!this.host.isDisposed()) console.error("Flow could not read the document bounds", error);
    }
    if (this.host.isDisposed() || generation !== this.cameraGeneration) return;
    if (expectedFit !== null) {
      // The newest resize or an explicit fit has superseded this automatic
      // fit while its bounds read was pending.
      if (expectedFit !== this.fitGeneration || this.userCamera) return;
    } else {
      // An explicit fit supersedes any automatic fit already queued or
      // awaiting its own bounds read.
      this.fitGeneration += 1;
      this.pendingFitGeneration = null;
    }
    this.userCamera = false;
    const scale = this.fit(bounds);
    if (announce) this.publishZoom(scale);
    if (schedule) this.schedule();
  }

  /** Fits a node (a search hit) and marks the camera as user-chosen. */
  focusBounds(bounds: Viewport): number {
    this.userMoved();
    const scale = this.fit(bounds);
    this.publishZoom(scale);
    this.schedule();
    return scale;
  }

  onResize(width: number, height: number): void {
    this.setSize(width, height);
    if (this.userCamera) {
      this.schedule();
      return;
    }
    // One newest fit token: repeated resizes before the timer replace it, so
    // the drain reads bounds once at the final stage size. An active drain
    // sees the pending fit after its read; joining it also covers a resize
    // that lands while the read finishes. Otherwise the timer starts one.
    this.fitGeneration += 1;
    this.pendingFitGeneration = this.fitGeneration;
    if (this.drain.active) void this.drain.join();
    else this.schedule();
  }

  zoomAround(factor: number, cx: number, cy: number): void {
    const camera = this.host.camera();
    if (!camera) return;
    this.userMoved();
    if (camera.zoomAround(factor, cx, cy)) {
      cancelAnimationFrame(this.zoomFrame);
      this.host.publishZoom(Math.round(camera.scale * 100));
      this.schedule();
    }
  }

  panBy(dx: number, dy: number): void {
    const camera = this.host.camera();
    if (!camera) return;
    this.userMoved();
    camera.panBy(dx, dy);
    this.schedule();
  }

  /** Centers a world point, from a press or drag on the minimap. */
  centerOn(x: number, y: number): void {
    const camera = this.host.camera();
    if (!camera) return;
    this.userMoved();
    camera.centerOn(x, y, { width: this.width, height: this.height });
    this.schedule();
  }

  dispose(): void {
    cancelAnimationFrame(this.zoomFrame);
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.pendingFitGeneration = null;
    this.host.camera()?.dispose();
  }

  private visibleRect(): { rect: Viewport; margin: number } {
    const camera = this.host.camera();
    if (!camera) return { rect: this.host.fallbackBounds(), margin: 0 };
    const rect = camera.visibleBounds({ width: this.width, height: this.height });
    const margin = Math.max(rect.width, rect.height) * VIEWPORT_MARGIN;
    return { rect, margin };
  }

  private fit(bounds: Viewport): number {
    const camera = this.host.camera();
    if (!camera) return 1;
    return camera.fit(bounds, { width: this.width, height: this.height });
  }

  private publishZoom(scale: number): void {
    cancelAnimationFrame(this.zoomFrame);
    const percent = Math.round(scale * 100);
    this.zoomFrame = requestAnimationFrame(() => {
      if (this.host.isDisposed()) return;
      const current = this.host.camera()?.scale ?? scale;
      if (Math.round(current * 100) === percent) this.host.publishZoom(percent);
    });
  }
}
