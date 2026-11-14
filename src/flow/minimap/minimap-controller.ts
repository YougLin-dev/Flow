/** The minimap drag's state: a press inside the panel pans the camera. */
import { signal, type Accessor } from "nsh";
import { minimapDragCenter, type MinimapDrag } from "./minimap";

export class MinimapController {
  private readonly state = signal<MinimapDrag | null>(null);
  /** Whether a drag is active, so the page can mount its capture surface. */
  readonly dragging: Accessor<boolean> = () => this.state() !== null;

  constructor(private readonly onCenter: (x: number, y: number) => void) {}

  /** The press began inside the panel; nothing moves until the pointer does. */
  start(drag: MinimapDrag): void {
    if (drag.scale <= 0) return;
    this.state.set(drag);
  }

  move(point: { readonly x: number; readonly y: number }): void {
    const drag = this.state();
    if (drag === null) return;
    const center = minimapDragCenter(drag, point);
    this.onCenter(center.x, center.y);
  }

  end(): void {
    this.state.set(null);
  }

  dispose(): void {
    this.state.set(null);
  }
}
