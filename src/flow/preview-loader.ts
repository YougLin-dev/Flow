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

  constructor(private readonly host: PreviewHost) {}

  schedule(): void {
    if (this.timer !== null || this.host.isDisposed()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.host.isDisposed()) void this.refresh();
    }, PREVIEW_DELAY_MS);
  }

  async refresh(): Promise<void> {
    const document = this.host.document();
    const assets = this.host.assets();
    const scene = this.host.scene();
    if (!document || !assets || !scene || this.host.isDisposed()) return;
    const targets = scene.previewTargets();
    // Every viewport read and change set schedules a refresh; an unchanged
    // target list has nothing to load and must not publish again.
    if (sameTargets(this.lastTargets, targets)) return;
    const generation = ++this.generation;
    const previousTargets = this.lastTargets;
    this.lastTargets = targets;
    if (targets.length === 0) {
      // Nothing to load. Clear a previous publication so a card whose batch
      // went away stops showing stale thumbnails; a cold start publishes
      // nothing at all.
      if (previousTargets !== null && previousTargets.length > 0) scene.applyPreviews([]);
      return;
    }
    try {
      const views = await loadPreviews(document, assets, targets);
      if (this.host.isDisposed() || generation !== this.generation) return;
      const current = this.host.scene();
      if (!current) return;
      current.applyPreviews(views);
    } catch (error) {
      if (!this.host.isDisposed()) console.error("Flow could not load image previews", error);
    }
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
