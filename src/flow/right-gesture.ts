/**
 * A secondary-button press on the canvas. NSH reports the press
 * (`onContextMenu`), moves made while the button is held, and its release
 * (`onMouseUp`); this gesture becomes a camera pan once the pointer moves past
 * a threshold, and a press that never does leaves its menu to open on the
 * release.
 */

/** The distance, in screen points, a right press may move before it pans. */
export const RIGHT_DRAG_THRESHOLD = 4;

export interface RightGestureHost {
  /** Whether no primary-button or touch gesture owns the canvas. */
  canStart(): boolean;
  beginPan(x: number, y: number): void;
  panTo(x: number, y: number): void;
  endPan(x: number, y: number): void;
}

export class RightGesture {
  private anchor: { x: number; y: number } | null = null;
  private last = { x: 0, y: 0 };
  private panning = false;

  constructor(private readonly host: RightGestureHost) {}

  /** Starts on a secondary press; false when another gesture owns the canvas. */
  down(x: number, y: number): boolean {
    // A further right press means the previous one was released: NSH may not
    // have reported that release, so end its pan before checking the canvas.
    if (this.anchor !== null) this.end();
    if (!this.host.canStart()) return false;
    this.anchor = { x, y };
    this.last = { x, y };
    this.panning = false;
    return true;
  }

  /** True while a secondary press or its pan is tracked. */
  active(): boolean {
    return this.anchor !== null;
  }

  /** True once the press became a pan. */
  dragging(): boolean {
    return this.panning;
  }

  /** A move with the secondary button held; true when it starts the pan. */
  move(x: number, y: number): boolean {
    if (this.anchor === null) return false;
    let started = false;
    if (!this.panning) {
      if (Math.hypot(x - this.anchor.x, y - this.anchor.y) <= RIGHT_DRAG_THRESHOLD) {
        return false;
      }
      this.panning = true;
      started = true;
      this.host.beginPan(this.anchor.x, this.anchor.y);
    }
    this.last = { x, y };
    this.host.panTo(x, y);
    return started;
  }

  /** The secondary button is no longer down; finish where it was last seen. */
  end(): void {
    if (this.anchor === null) return;
    const panning = this.panning;
    const last = this.last;
    this.cancel();
    if (panning) this.host.endPan(last.x, last.y);
  }

  /** Drops the press without ending a pan the caller is already cancelling. */
  cancel(): void {
    this.anchor = null;
    this.panning = false;
  }
}
