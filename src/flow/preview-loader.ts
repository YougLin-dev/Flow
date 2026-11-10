/** Loads the visible image cards' asset URLs after a scene read. */
import type { Document } from "@flow/native";
import type { AssetUrls } from "./asset-urls";
import { loadPreviews, type PreviewTarget } from "./previews";
import type { FlowScene } from "./scene";

const PREVIEW_DELAY_MS = 40;

export interface PreviewHost {
  document(): Document | null;
  assets(): AssetUrls | null;
  scene(): FlowScene | null;
  isDisposed(): boolean;
}

/**
 * Pure target equality: the same card ids and batch ids in the same order.
 * A null previous list never matches, so the first refresh always loads.
 */
export function sameTargets(
  a: readonly PreviewTarget[] | null,
  b: readonly PreviewTarget[],
): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const first = a[index];
    const second = b[index];
    if (!first || !second) return false;
    if (first.id !== second.id || first.batchId !== second.batchId) return false;
  }
  return true;
}

export class PreviewLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastTargets: readonly PreviewTarget[] | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private pendingResolvers: Array<() => void> = [];

  constructor(private readonly host: PreviewHost) {}

  schedule(): void {
    if (this.timer !== null || this.host.isDisposed()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.host.isDisposed()) void this.refresh();
    }, PREVIEW_DELAY_MS);
  }

  refresh(): Promise<void> {
    const document = this.host.document();
    const assets = this.host.assets();
    const scene = this.host.scene();
    if (!document || !assets || !scene || this.host.isDisposed()) return Promise.resolve();
    const targets = scene.previewTargets();
    if (this.inFlight !== null) {
      // Join the active drain without touching lastTargets. An unchanged list
      // needs no follow-up read; every refresh still gets a promise settled by
      // the drain so its caller awaits progress.
      if (!sameTargets(this.lastTargets, targets)) this.dirty = true;
      return new Promise<void>((resolve) => {
        this.pendingResolvers.push(resolve);
      });
    }
    // Every viewport read and change set schedules a refresh; an unchanged
    // target list has nothing to load and must not publish again.
    if (sameTargets(this.lastTargets, targets)) return Promise.resolve();
    // Publish the drain before starting it: an empty first target list
    // completes synchronously and would otherwise clear `inFlight` before it
    // was ever assigned.
    const drain = new Promise<void>((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    this.inFlight = drain;
    void this.runReads(document, assets, targets);
    return drain;
  }

  /** One queued drain: a current read plus at most one per newer request. */
  private async runReads(
    document: Document,
    assets: AssetUrls,
    firstTargets: readonly PreviewTarget[],
  ): Promise<void> {
    let targets = firstTargets;
    while (true) {
      if (this.host.isDisposed()) break;
      // Clear the flag before awaiting so a request arriving during this read
      // marks the loop dirty again.
      this.dirty = false;
      if (sameTargets(this.lastTargets, targets)) break;
      const previousTargets = this.lastTargets;
      this.lastTargets = targets;
      if (targets.length === 0) {
        // Nothing to load. Clear a previous publication so a card whose batch
        // went away stops showing stale thumbnails; a cold start publishes
        // nothing at all. A completed iteration, not a read.
        if (previousTargets !== null && previousTargets.length > 0) {
          const scene = this.host.scene();
          if (!scene) break;
          scene.applyPreviews([]);
        }
        if (!this.dirty) break;
        const scene = this.host.scene();
        if (!scene) break;
        targets = scene.previewTargets();
        continue;
      }
      const generation = ++this.generation;
      try {
        // The drain is deliberately sequential: one read, then at most one
        // follow-up for the newest targets.
        // eslint-disable-next-line no-await-in-loop
        const views = await loadPreviews(document, assets, targets);
        if (generation !== this.generation) break;
        if (!this.host.isDisposed()) {
          const current = this.host.scene();
          if (!current) break;
          current.applyPreviews(views);
        }
      } catch (error) {
        if (!this.host.isDisposed()) console.error("Flow could not load image previews", error);
      }
      if (this.host.isDisposed() || generation !== this.generation) break;
      if (!this.dirty) break;
      // Each follow-up reads the newest targets, immediately before its read.
      const scene = this.host.scene();
      if (!scene) break;
      targets = scene.previewTargets();
    }
    this.finishReads();
  }

  private finishReads(): void {
    this.inFlight = null;
    const resolvers = this.pendingResolvers;
    this.pendingResolvers = [];
    // Callers observe settlement, not proof that an outdated target list was
    // applied: a dropped read resolves here once its request finishes.
    for (const resolve of resolvers) resolve();
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
