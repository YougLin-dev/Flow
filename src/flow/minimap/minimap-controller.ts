/** The minimap drag's state: a press inside the panel pans the camera. */
import { signal, type Accessor } from "nsh";
import { minimapDragCenter, type MinimapDrag } from "./minimap";

export class MinimapController {
  private readonly state = signal<MinimapDrag | null>(null);
  /** The finger that began the drag; null for the mouse capture surface. */
  private touch: number | null = null;
  /** Whether a drag is active, so the page can mount its capture surface. */
  readonly dragging: Accessor<boolean> = () => this.state() !== null;

  constructor(private readonly onCenter: (x: number, y: number) => void) {}

  /** The press began inside the panel; nothing moves until the pointer does. */
  start(drag: MinimapDrag, touch: number | null = null): void {
    if (drag.scale <= 0) return;
    this.touch = touch;
    this.state.set(drag);
  }

  move(point: { readonly x: number; readonly y: number }, touch: number | null = null): void {
    const drag = this.state();
    if (drag === null) return;
    // Another finger must not steer the drag; a pointer move carries no
    // touch identity and still drives a drag that a touch began.
    if (touch !== null && this.touch !== null && touch !== this.touch) return;
    const center = minimapDragCenter(drag, point);
    this.onCenter(center.x, center.y);
  }

  end(touch: number | null = null): void {
    if (touch !== null && this.touch !== null && touch !== this.touch) return;
    this.touch = null;
    this.state.set(null);
  }

  dispose(): void {
    this.touch = null;
    this.state.set(null);
  }
}
