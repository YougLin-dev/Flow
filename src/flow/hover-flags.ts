/**
 * The keyed mirrors of the controller's hover and marquee preview. Kept out
 * of canvas-controller.ts because that module is at the max-lines cap; the
 * controller writes through this helper inside its batched entry points.
 */
import { KeyedFlags } from "./keyed-flags";

export class HoverFlags {
  private readonly hoveredFlags = new KeyedFlags();
  private readonly previewFlags = new KeyedFlags();

  isHovered(id: string): boolean {
    return this.hoveredFlags.has(id);
  }

  isPreviewed(id: string): boolean {
    return this.previewFlags.has(id);
  }

  setHovered(id: string | null): void {
    this.hoveredFlags.set(id === null ? [] : [id]);
  }

  setPreviewed(ids: ReadonlySet<string>): void {
    this.previewFlags.set([...ids]);
  }
}
