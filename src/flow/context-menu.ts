/** The canvas context menu's anchor, delay, stage placement and gestures. */
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

/**
 * How long a secondary press waits for its menu. NSH delivers the right press
 * at once but never its release, so the wait lets a right drag claim the press
 * and pan before a menu would cover the canvas.
 */
export const CONTEXT_MENU_DELAY_MS = 100;

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
 * The open menu's anchor; the menu closes after a secondary drag starts.
 * Private to `CanvasMenuController` in app code.
 */
class ContextMenuState {
  readonly press = signal<ContextMenuPress | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Opens after the drag-disambiguating delay, or re-anchors at once. */
  open(press: ContextMenuPress): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.press() !== null) {
      this.press.set(press);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.press.set(press);
    }, CONTEXT_MENU_DELAY_MS);
  }

  /** Closes an open menu or cancels a pending one; true when there was one. */
  close(): boolean {
    const wasOpen = this.press() !== null || this.timer !== null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    this.state.open({ ...at, worldX: world.x, worldY: world.y });
  }

  /** A move over the menu: a right drag dismisses it and pans. */
  move(x: number, y: number, right: boolean): void {
    if (!right) {
      this.host.controller().right.end();
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
