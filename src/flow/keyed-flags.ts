/**
 * Lazily created per-id booleans for a frequently changing membership. Reading
 * one id subscribes only to its flag, not to the id list as a whole.
 */
import { signal, type Signal } from "nsh";

export class KeyedFlags {
  private readonly flags = new Map<string, Signal<boolean>>();

  /** Whether `id` is in the current membership. */
  has(id: string): boolean {
    let flag = this.flags.get(id);
    if (flag === undefined) {
      flag = signal(false);
      this.flags.set(id, flag);
    }
    return flag();
  }

  /** Replaces the membership, waking only ids whose boolean changed. */
  set(ids: readonly string[]): void {
    const next = new Set(ids);
    for (const [id, flag] of this.flags) {
      if (next.has(id)) {
        flag.set(true);
        next.delete(id);
      } else {
        flag.set(false);
      }
    }
    for (const id of next) this.flags.set(id, signal(true));
  }

  /** Drops flags for ids that can no longer be read as members. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.flags.keys()) {
      if (!ids.has(id)) this.flags.delete(id);
    }
  }

  /** The number of lazily created flags, for tests and diagnostics. */
  size(): number {
    return this.flags.size;
  }
}
