/**
 * The camera of an infinite canvas: a screen-space view of a world whose
 * nodes, edges and previews live at world coordinates. The scene renders a
 * world container with this view's translate and scale, so moving the camera
 * moves the content natively. The camera is a signal, so a change re-renders
 * the container and everything positioned from it.
 */
import { signal } from "nsh";

export interface CameraView {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface CameraBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraSize {
  width: number;
  height: number;
}

/** The scale range both fitting and manual zooming share. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2.5;

/** Wheel notches that double the view: about 19% a notch. */
export const WHEEL_NOTCHES_PER_DOUBLING = 4;

/** The zoom factor a wheel or touchpad scroll of `notches` applies. */
export function wheelZoomFactor(notches: number): number {
  return 2 ** (-notches / WHEEL_NOTCHES_PER_DOUBLING);
}

export class CanvasCamera {
  /** The camera's current view; read it in JSX to follow camera changes. */
  readonly view = signal<CameraView>({ x: 0, y: 0, scale: 1 });

  get x(): number {
    return this.view().x;
  }

  set x(value: number) {
    this.set({ x: value });
  }

  get y(): number {
    return this.view().y;
  }

  set y(value: number) {
    this.set({ y: value });
  }

  get scale(): number {
    const value = this.view().scale;
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  set scale(value: number) {
    this.set({ scale: value });
  }

  /** Screen point (canvas points) to world coordinates. */
  toWorld(x: number, y: number): { x: number; y: number } {
    const scale = this.scale;
    return { x: (x - this.x) / scale, y: (y - this.y) / scale };
  }

  /** World coordinates to a screen point (canvas points). */
  toScreen(x: number, y: number): { x: number; y: number } {
    const scale = this.scale;
    return { x: x * scale + this.x, y: y * scale + this.y };
  }

  /** The part of the world a canvas of `size` shows. */
  visibleBounds(size: CameraSize): CameraBounds {
    const topLeft = this.toWorld(0, 0);
    const bottomRight = this.toWorld(size.width, size.height);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  panBy(dx: number, dy: number): void {
    const view = this.view();
    if (dx === 0 && dy === 0) return;
    this.view.set({ ...view, x: view.x + dx, y: view.y + dy });
  }

  /**
   * Multiplies the scale, keeping the world point under (`x`, `y`) where it
   * is. Returns whether the scale changed (it stays within `min`…`max`).
   */
  zoomAround(factor: number, x: number, y: number, min = MIN_SCALE, max = MAX_SCALE): boolean {
    if (!Number.isFinite(factor) || factor <= 0) return false;
    const before = this.scale;
    const next = Math.min(max, Math.max(min, before * factor));
    // A zoom-out must never be clamped upward into a zoom-in (and vice
    // versa); the old fit floor could sit below this operation's floor.
    if (next === before || (factor < 1 ? next > before : next < before)) return false;
    const k = next / before;
    this.view.set({ x: x - (x - this.x) * k, y: y - (y - this.y) * k, scale: next });
    return true;
  }

  /** Scales the camera (never past 1) and centers `bounds` in `size`. */
  fit(bounds: CameraBounds, size: CameraSize, padding = 48, maxScale = 1): number {
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height, size.width, size.height].every(
        Number.isFinite,
      ) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return this.scale;
    }
    const availableWidth = Math.max(1, size.width - padding * 2);
    const availableHeight = Math.max(1, size.height - padding * 2);
    const scale = Math.min(
      maxScale,
      Math.max(MIN_SCALE, Math.min(availableWidth / bounds.width, availableHeight / bounds.height)),
    );
    this.view.set({
      x: size.width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: size.height / 2 - (bounds.y + bounds.height / 2) * scale,
      scale,
    });
    return scale;
  }

  private set(next: Partial<CameraView>): void {
    const view = this.view();
    const x = next.x ?? view.x;
    const y = next.y ?? view.y;
    const scale = next.scale ?? view.scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (x === view.x && y === view.y && scale === view.scale) return;
    this.view.set({ x, y, scale });
  }
}
