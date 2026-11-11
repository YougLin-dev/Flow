/** Loads the whole document's card silhouettes for the minimap. */
import { signal, type Accessor } from "nsh";
import type { ChangeSet, Document, Overview, OverviewCard } from "@flow/native";
import { sameOverview } from "./minimap";

/** A burst of command changes coalesces into one overview read. */
const MINIMAP_DELAY_MS = 150;

export interface MinimapHost {
  document(): Document | null;
  isDisposed(): boolean;
}

/** The one timer the loader owns; tests inject a deterministic driver. */
export interface MinimapScheduler {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

const SYSTEM_SCHEDULER: MinimapScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
};

export class MinimapLoader {
  private readonly overviewState = signal<Overview | null>(null);
  /** The last overview read, or null before the first one. */
  readonly overview: Accessor<Overview | null> = () => this.overviewState();
  /** The published silhouettes, for deciding whether a change can move one. */
  private readonly rects = new Map<string, OverviewCard>();
  private published: Overview | null = null;
  private timer: number | null = null;
  private generation = 0;
  private lastRev = 0;
  private inFlight = false;
  private dirty = false;

  constructor(
    private readonly host: MinimapHost,
    private readonly scheduler: MinimapScheduler = SYSTEM_SCHEDULER,
  ) {}

  /** A command's revision: an overview that started before it is older. */
  noteRev(rev: number): void {
    this.lastRev = Math.max(this.lastRev, rev);
  }

  /**
   * Schedules a read only when the change can move a silhouette or the
   * document bounds. Title, body, status and edge-only changes leave the map
   * unchanged and must not occupy the document worker. A card outside the
   * sample is unknown here, so a change to it reads conservatively.
   */
  noteChanges(changes: ChangeSet): void {
    this.noteRev(changes.rev);
    if (this.needsRead(changes)) this.schedule();
  }

  /** Queues one read after the current burst of changes settles. */
  schedule(): void {
    if (this.host.isDisposed()) return;
    // Trailing debounce: every change pushes the read out, so a burst of
    // commands costs one read after it settles.
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.host.isDisposed()) void this.refresh();
    }, MINIMAP_DELAY_MS);
  }

  async refresh(): Promise<void> {
    const document = this.host.document();
    if (!document || this.host.isDisposed()) return;
    if (this.inFlight) {
      // One follow-up read for every change that landed during this read.
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    this.dirty = false;
    try {
      while (true) {
        const generation = ++this.generation;
        // eslint-disable-next-line no-await-in-loop
        const overview = await document.overview();
        if (this.host.isDisposed() || generation !== this.generation) break;
        // A read that started before a newer command must not replace the
        // newer overview; the newest change loads it again.
        if (overview.rev >= this.lastRev) {
          this.lastRev = overview.rev;
          this.publish(overview);
        } else {
          this.dirty = true;
        }
        if (!this.dirty) break;
        this.dirty = false;
      }
    } catch (error) {
      if (!this.host.isDisposed()) {
        console.error("Flow could not read the document overview", error);
        // A change that arrived during the failed read deserves one retry;
        // with no new change a persistent error must not spin.
        if (this.dirty) this.schedule();
      }
    } finally {
      this.inFlight = false;
      this.dirty = false;
    }
  }

  private needsRead(changes: ChangeSet): boolean {
    if (changes.removed.length > 0) return true;
    if (changes.changed.length === 0) return false;
    for (const node of changes.changed) {
      const card = this.rects.get(node.id);
      if (
        card === undefined ||
        card.x !== node.x ||
        card.y !== node.y ||
        card.width !== node.width ||
        card.height !== node.height
      ) {
        return true;
      }
    }
    return false;
  }

  /** Publishes a read that draws a different map than the last one. */
  private publish(overview: Overview): void {
    if (sameOverview(this.published, overview)) return;
    this.published = overview;
    this.rects.clear();
    for (const card of overview.cards) this.rects.set(card.id, card);
    this.overviewState.set(overview);
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = false;
    this.dirty = false;
    this.published = null;
    this.rects.clear();
    this.overviewState.set(null);
  }
}
