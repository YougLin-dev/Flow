/** The canvas context menu's anchor, stage placement and gestures. */
import { signal } from "nsh";
import type { CanvasCamera } from "./camera";
import type { CanvasController } from "./canvas-controller";
import type { NodeKindId } from "./node-kinds";
import type { StageSize } from "./overlay";

/** A secondary-button press in the canvas's screen points. */
export interface ContextMenuPoint {
  readonly x: number;
  readonly y: number;
}

/** The press with the world point a new card is centred on. */
export interface ContextMenuPress extends ContextMenuPoint {
  readonly worldX: number;
  readonly worldY: number;
}

/** The menu's fixed width and the height it reserves on the stage. */
export const CONTEXT_MENU_WIDTH = 180;
export const CONTEXT_MENU_HEIGHT = 84;
const MARGIN = 8;

/** The menu's top-left corner, kept on the stage. */
export function contextMenuPosition(
  press: ContextMenuPress,
  stage: StageSize,
): { left: number; top: number } {
  return {
    left: clamp(press.x, MARGIN, stage.width - CONTEXT_MENU_WIDTH - MARGIN),
    top: clamp(press.y, MARGIN, stage.height - CONTEXT_MENU_HEIGHT - MARGIN),
  };
}

/**
 * The open menu's anchor and the press waiting for its release. A secondary
 * press only records the press; the menu opens when the button is released
 * without the press becoming a drag. Private to `CanvasMenuController`.
 */
class ContextMenuState {
  readonly press = signal<ContextMenuPress | null>(null);
  private pending: ContextMenuPress | null = null;

  /** Records a press, or re-anchors an already open menu. */
  pressAt(press: ContextMenuPress): void {
    if (this.press() !== null) {
      this.press.set(press);
      return;
    }
    this.pending = press;
  }

  /** The button was released without a drag: open the waiting menu. */
  release(): void {
    const press = this.pending;
    this.pending = null;
    if (press !== null && this.press() === null) this.press.set(press);
  }

  /** Closes an open menu or forgets a waiting press; true when there was one. */
  close(): boolean {
    const wasOpen = this.press() !== null || this.pending !== null;
    this.pending = null;
    if (this.press() !== null) this.press.set(null);
    return wasOpen;
  }
}

export interface CanvasMenuHost {
  camera(): CanvasCamera;
  controller(): CanvasController;
  addNode(kind: NodeKindId, x: number, y: number): void;
}

/**
 * Wires a secondary press to the right-button gesture and the menu: the press
 * opens the menu (unless a right drag claims it), a move over the menu can
 * start that drag, and an item adds a card at the pressed world point.
 */
export class CanvasMenuController {
  private readonly state = new ContextMenuState();

  constructor(private readonly host: CanvasMenuHost) {}

  /** The menu's anchor while it is open. */
  open(): ContextMenuPress | null {
    return this.state.press();
  }

  /** A secondary press, from the canvas or from the open menu. */
  press(at: ContextMenuPoint): void {
    if (!this.host.controller().right.down(at.x, at.y)) return;
    const world = this.host.camera().toWorld(at.x, at.y);
    this.state.pressAt({ ...at, worldX: world.x, worldY: world.y });
  }

  /**
   * The secondary button was released: a press that never became a drag
   * opens its menu at the pressed point; a drag only ends its pan.
   */
  release(): void {
    const right = this.host.controller().right;
    if (!right.active()) return;
    const dragging = right.dragging();
    right.end();
    if (dragging) {
      this.state.close();
      return;
    }
    this.state.release();
  }

  /** A move over the menu: a secondary drag dismisses it and pans. */
  move(x: number, y: number, held: boolean): void {
    if (!held) {
      this.release();
      return;
    }
    if (this.host.controller().right.move(x, y)) this.state.close();
  }

  /** Adds the pressed card and closes the menu. */
  add(kind: NodeKindId, at: ContextMenuPress): void {
    this.state.close();
    this.host.addNode(kind, at.worldX, at.worldY);
  }

  /** Closes the menu; true when one was open or about to open. */
  close(): boolean {
    return this.state.close();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
