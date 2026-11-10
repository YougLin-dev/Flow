/**
 * The camera and viewport read loop: fitting, panning, zooming and throttled
 * scene reads. It owns no UI; the page binds the values it publishes.
 */
import type { ChangeSet, Document, Viewport } from "@flow/native";
import type { CanvasCamera } from "./camera";
import { CONTENT } from "./data";
import type { FlowScene } from "./scene";

const VIEWPORT_MARGIN = 0.25;
const VIEWPORT_DELAY_MS = 80;

export interface ViewportHost {
  camera(): CanvasCamera | null;
  scene(): FlowScene | null;
  document(): Document | null;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
  publishZoom(percent: number): void;
  isDisposed(): boolean;
}

export class ViewportController {
  private width = 1;
  private height = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private cameraGeneration = 0;
  private zoomFrame = 0;
  private lastRev = 0;
  private userCamera = false;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private pendingResolvers: Array<() => void> = [];

  constructor(private readonly host: ViewportHost) {}

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
  }

  schedule(): void {
    if (this.timer !== null || this.host.isDisposed()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.host.isDisposed()) void this.refresh();
    }, VIEWPORT_DELAY_MS);
  }

  refresh(): Promise<void> {
    const document = this.host.document();
    const scene = this.host.scene();
    if (!document || !scene || this.host.isDisposed()) return Promise.resolve();
    if (this.inFlight !== null) {
      // Join the active drain; one follow-up will read the newest rect.
      this.dirty = true;
      return new Promise<void>((resolve) => {
        this.pendingResolvers.push(resolve);
      });
    }
    // Publish the drain before starting it: a read that settles synchronously
    // would otherwise clear `inFlight` before it was ever assigned.
    const drain = new Promise<void>((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    this.inFlight = drain;
    void this.runReads(document, scene);
    return drain;
  }

  /** One queued drain: a current read plus at most one per newer request. */
  private async runReads(document: Document, scene: FlowScene): Promise<void> {
    while (true) {
      if (this.host.isDisposed()) break;
      // Clear the flag before awaiting so a request arriving during this read
      // marks the loop dirty again.
      this.dirty = false;
      const { rect, margin } = this.visibleRect();
      const generation = ++this.generation;
      try {
        // The drain is deliberately sequential: one read, then at most one
        // follow-up for the newest rect.
        // eslint-disable-next-line no-await-in-loop
        const snapshot = await document.scene(rect, margin);
        if (
          !this.host.isDisposed() &&
          generation === this.generation &&
          snapshot.rev >= this.lastRev
        ) {
          this.lastRev = snapshot.rev;
          const camera = this.host.camera();
          const scale = camera?.scale ?? 1;
          const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
          scene.apply(snapshot, { maxCards });
          this.host.schedulePreviews();
        }
      } catch (error) {
        if (!this.host.isDisposed()) console.error("Flow could not read the viewport", error);
      }
      if (this.host.isDisposed()) break;
      if (!this.dirty) break;
    }
    this.finishReads();
  }

  private finishReads(): void {
    this.inFlight = null;
    const resolvers = this.pendingResolvers;
    this.pendingResolvers = [];
    // Callers observe settlement, not proof that an outdated revision was
    // applied: a dropped read resolves here once its request finishes.
    for (const resolve of resolvers) resolve();
  }

  /** Publishes the camera's current scale, deferred to the next frame. */
  announceZoom(scale: number): void {
    this.publishZoom(scale);
  }

  async fitToDocument(announce = true, schedule = true): Promise<void> {
    const document = this.host.document();
    const camera = this.host.camera();
    if (!document || !camera || this.host.isDisposed()) return;
    const generation = this.cameraGeneration;
    let bounds: Viewport = CONTENT;
    try {
      const documentBounds = await document.bounds();
      if (documentBounds.width > 0 || documentBounds.height > 0) bounds = documentBounds;
    } catch (error) {
      if (!this.host.isDisposed()) console.error("Flow could not read the document bounds", error);
    }
    if (this.host.isDisposed() || generation !== this.cameraGeneration) return;
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
    if (!this.userCamera) void this.fitToDocument();
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

  dispose(): void {
    cancelAnimationFrame(this.zoomFrame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.host.camera()?.dispose();
  }

  private visibleRect(): { rect: Viewport; margin: number } {
    const camera = this.host.camera();
    if (!camera) return { rect: CONTENT, margin: 0 };
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
