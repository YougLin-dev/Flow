/** Loads the visible image cards' asset URLs after a scene read. */
import { AsyncDrain, type Document, type DrainStepResult } from "../../shared";
import type { AssetUrls } from "./asset-urls";
import { loadPreviews, type PreviewTarget } from "./previews";
import type { FlowScene } from "../../canvas";

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

/** The targets a drain iteration reads; follow-ups re-read them. */
interface PreviewDrain {
  targets: readonly PreviewTarget[];
  started: boolean;
}

export class PreviewLoader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastTargets: readonly PreviewTarget[] | null = null;
  private readonly drain = new AsyncDrain();

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
    // Join the active drain without touching lastTargets. An unchanged list
    // needs no follow-up read; every refresh still gets a promise settled by
    // the drain so its caller awaits progress.
    const joined = this.drain.join(!sameTargets(this.lastTargets, targets));
    if (joined !== null) return joined;
    // Every viewport read and change set schedules a refresh; an unchanged
    // target list has nothing to load and must not publish again.
    if (sameTargets(this.lastTargets, targets)) return Promise.resolve();
    const pending: PreviewDrain = { targets, started: false };
    return this.drain.start((isDirty) => this.drainStep(document, assets, pending, isDirty));
  }

  /** One queued iteration: a read now, and at most one for newer targets. */
  private async drainStep(
    document: Document,
    assets: AssetUrls,
    pending: PreviewDrain,
    isDirty: () => boolean,
  ): Promise<DrainStepResult> {
    if (this.host.isDisposed()) return "done";
    const scene = this.host.scene();
    if (!scene) return "done";
    // The first iteration uses the list `refresh` already compared; every
    // follow-up re-reads the newest targets, including one that landed in the
    // microtask gap after the previous iteration's last check.
    if (pending.started) pending.targets = scene.previewTargets();
    pending.started = true;
    const targets = pending.targets;
    if (sameTargets(this.lastTargets, targets)) return "done";
    const previousTargets = this.lastTargets;
    this.lastTargets = targets;
    if (targets.length === 0) {
      // Nothing to load. Clear a previous publication so a card whose batch
      // went away stops showing stale thumbnails; a cold start publishes
      // nothing at all. A completed iteration, not a read.
      if (previousTargets !== null && previousTargets.length > 0) {
        scene.applyPreviews([]);
      }
      if (!isDirty()) return "done";
      return "continue";
    }
    const generation = ++this.generation;
    try {
      // The drain is deliberately sequential: one read, then at most one
      // follow-up for the newest targets.
      const views = await loadPreviews(document, assets, targets);
      if (generation !== this.generation) return "done";
      if (!this.host.isDisposed()) {
        const current = this.host.scene();
        if (!current) return "done";
        current.applyPreviews(views);
      }
    } catch (error) {
      if (!this.host.isDisposed()) console.error("Flow could not load image previews", error);
    }
    if (this.host.isDisposed() || generation !== this.generation) return "done";
    if (!isDirty()) return "done";
    return "continue";
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
