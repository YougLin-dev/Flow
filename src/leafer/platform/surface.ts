import type { CanvasSnapshot } from "./snapshot";
import { NshRecordingContext } from "./recording-context";

/** The canvas element Leafer draws its scene into. */
export class NshCanvasSurface {
  private surfaceWidth: number;
  private surfaceHeight: number;
  readonly context: NshRecordingContext;
  readonly __nshCanvas = true;

  constructor(width: number, height: number, offscreen: boolean) {
    this.surfaceWidth = Math.max(1, width);
    this.surfaceHeight = Math.max(1, height);
    this.context = new NshRecordingContext(this, offscreen);
  }

  get width(): number {
    return this.surfaceWidth;
  }

  set width(value: number) {
    const next = Math.max(1, value);
    if (next === this.surfaceWidth) return;
    this.surfaceWidth = next;
    // Assigning a canvas' width or height resets its bitmap and state. A
    // rendered offscreen layer must not keep the previous drawing.
    this.context.beginFrame();
  }

  get height(): number {
    return this.surfaceHeight;
  }

  set height(value: number) {
    const next = Math.max(1, value);
    if (next === this.surfaceHeight) return;
    this.surfaceHeight = next;
    this.context.beginFrame();
  }

  getContext(_type?: string, _settings?: unknown): NshRecordingContext {
    return this.context;
  }

  /** What this offscreen canvas holds now, for replay as vectors. */
  snapshot(): CanvasSnapshot {
    return {
      width: Math.max(1, this.width),
      height: Math.max(1, this.height),
      ops: this.context.ops.slice(),
    };
  }

  toDataURL(): string {
    return "";
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    return requestAnimationFrame(callback);
  }
}
