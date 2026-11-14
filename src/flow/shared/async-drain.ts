/**
 * The single-flight drain the loaders share. One read runs at a time; a
 * request that arrives during it asks for at most one follow-up and settles
 * with the active drain, so every caller awaits progress instead of starting
 * a second read. Scheduling, revision fences and retry rules stay in each
 * loader, where they differ.
 */

/** What one drain iteration decided: run another, or finish. */
export type DrainStepResult = "continue" | "done";

/**
 * One drain iteration: a read plus its publish. `isDirty` reports whether a
 * request joined since the iteration began. The step owns the read's errors,
 * so a failed read can still be followed by its one retry.
 */
export type DrainStep = (isDirty: () => boolean) => Promise<DrainStepResult>;

export class AsyncDrain {
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private resolvers: Array<() => void> = [];

  /** Whether a drain is running; `join` is the only way to await it. */
  get active(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Joins the active drain, or returns null when none runs. `followUp` says
   * whether this request needs an iteration after the active one; a request
   * that found the same inputs passes false.
   */
  join(followUp = true): Promise<void> | null {
    if (this.inFlight === null) return null;
    if (followUp) this.dirty = true;
    return this.wait();
  }

  /**
   * Starts a drain. Callers check `join` first; a drain that raced in is
   * joined instead so no second read can start.
   */
  start(step: DrainStep): Promise<void> {
    if (this.inFlight !== null) return this.join() ?? Promise.resolve();
    const drain = this.wait();
    this.inFlight = drain;
    void this.drain(step);
    return drain;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  private async drain(step: DrainStep): Promise<void> {
    try {
      do {
        this.dirty = false;
        // One iteration at a time: the drain is single-flight by design.
        // eslint-disable-next-line no-await-in-loop
      } while ((await step(() => this.dirty)) === "continue");
    } catch (error) {
      // The step owns its read errors; reaching this means a caller bug.
      // Settle the drain in `finally` so no caller hangs, and report it
      // rather than hide it.
      console.error("AsyncDrain step failed", error);
    } finally {
      this.inFlight = null;
      this.dirty = false;
      const resolvers = this.resolvers;
      this.resolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
}
