/**
 * Lazily created per-id booleans for a frequently changing membership. Reading
 * one id subscribes only to its flag, not to the id list as a whole.
 */
import { signal, type Signal } from "nsh";

export class KeyedFlags {
  private readonly flags = new Map<string, Signal<boolean>>();
  /** The ids whose flag is true; set() diffs against this rather than the
   * whole map, so a pointer move never walks every id the session has seen. */
  private members = new Set<string>();

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
    for (const id of this.members) {
      if (next.has(id)) continue;
      this.flags.get(id)?.set(false);
    }
    for (const id of next) {
      if (this.members.has(id)) continue;
      const flag = this.flags.get(id);
      if (flag === undefined) this.flags.set(id, signal(true));
      else flag.set(true);
    }
    this.members = next;
  }

  /** Drops flags for ids that can no longer be read as members. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.flags.keys()) {
      if (!ids.has(id)) this.flags.delete(id);
    }
    for (const id of this.members) {
      if (!ids.has(id)) this.members.delete(id);
    }
  }

  /** The number of lazily created flags, for tests and diagnostics. */
  size(): number {
    return this.flags.size;
  }
}
