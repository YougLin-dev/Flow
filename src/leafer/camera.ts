/**
 * The camera of an infinite canvas: a Leafer group whose `x`, `y` and
 * `scale` are the viewport's transform. The app builds its scene in world
 * coordinates and moves this group; Leafer culls what falls outside the
 * canvas, so only what is on screen is drawn.
 */
export interface CameraTarget {
  x?: number;
  y?: number;
  /** Leafer takes a number or a point; the camera uses a number. */
  scale?: number | { x: number; y: number };
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

export class CanvasCamera {
  readonly target: CameraTarget;

  constructor(target: CameraTarget) {
    this.target = target;
  }

  get x(): number {
    return Number(this.target.x) || 0;
  }

  set x(value: number) {
    this.target.x = value;
  }

  get y(): number {
    return Number(this.target.y) || 0;
  }

  set y(value: number) {
    this.target.y = value;
  }

  get scale(): number {
    const raw = this.target.scale;
    const value = typeof raw === "number" ? raw : Number(raw?.x);
    return value > 0 ? value : 1;
  }

  set scale(value: number) {
    this.target.scale = value;
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
    this.x = this.x + dx;
    this.y = this.y + dy;
  }

  /**
   * Multiplies the scale, keeping the world point under (`x`, `y`) where it
   * is. Returns whether the scale changed (it stays within `min`…`max`).
   */
  zoomAround(factor: number, x: number, y: number, min = 0.2, max = 4): boolean {
    const before = this.scale;
    const next = Math.min(max, Math.max(min, before * factor));
    if (next === before) return false;
    const k = next / before;
    this.scale = next;
    this.x = x - (x - this.x) * k;
    this.y = y - (y - this.y) * k;
    return true;
  }

  /** Scales the camera (never past 1) and centers `bounds` in `size`. */
  fit(bounds: CameraBounds, size: CameraSize, padding = 48, maxScale = 1): number {
    const availableWidth = Math.max(1, size.width - padding * 2);
    const availableHeight = Math.max(1, size.height - padding * 2);
    const scale = Math.min(
      maxScale,
      Math.max(0.05, Math.min(availableWidth / bounds.width, availableHeight / bounds.height)),
    );
    this.scale = scale;
    this.x = size.width / 2 - (bounds.x + bounds.width / 2) * scale;
    this.y = size.height / 2 - (bounds.y + bounds.height / 2) * scale;
    return scale;
  }
}
