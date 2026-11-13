/** The canvas context menu's anchor, target, stage placement and gestures. */
import { effect, signal, untracked } from "nsh";
import type { CanvasCamera } from "./camera";
import type { CanvasController } from "./canvas-controller";
import type { BoxGeometry, Point } from "./connection";
import type { NodeKindId } from "./node-kinds";
import type { StageSize } from "./overlay";
import type { FlowScene } from "./scene";
import { portAt } from "./scene-ports";

/** A secondary-button press in the canvas's screen points. */
export interface ContextMenuPoint {
  readonly x: number;
  readonly y: number;
}

/** The press with the world point a new card is centred on, and the card or
 * connector under it when the menu belongs to one rather than the canvas. A
 * card wins over a connector it covers, as it does for a left press. */
export interface ContextMenuPress extends ContextMenuPoint {
  readonly worldX: number;
  readonly worldY: number;
  readonly nodeId: string | null;
  readonly edgeId: string | null;
}

/** The menu's fixed width, and the height of its tallest form: the empty
 * canvas's three rows (a card's menu has two). */
export const CONTEXT_MENU_WIDTH = 180;
export const CONTEXT_MENU_HEIGHT = 108;
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
  scene(): FlowScene;
  addNode(kind: NodeKindId, x: number, y: number): void;
  copyNode(nodeId: string): void;
  deleteNode(nodeId: string): void;
  /** Selects a connector, dropping any card selection. */
  selectEdge(edgeId: string): void;
  deleteEdge(edgeId: string): void;
}

/**
 * Wires a secondary press to the right-button gesture and the menu: the press
 * opens the menu (unless a right drag claims it), a move over the menu can
 * start that drag, and an item adds a card at the pressed world point, copies
 * or deletes the card the press landed on, or deletes the connector it
 * landed on.
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
    const scene = this.host.scene();
    // A port's disc sits just outside the body, but it is still the card's
    // chrome: a press on it belongs to that card. Only a press that missed
    // every card can belong to a connector drawn behind them.
    const nodeId =
      scene.nodeAt(world.x, world.y, true) ?? portAt(scene, world.x, world.y)?.nodeId ?? null;
    const edgeId = nodeId === null ? scene.edgeAt(world.x, world.y) : null;
    this.state.pressAt({ ...at, worldX: world.x, worldY: world.y, nodeId, edgeId });
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
    this.selectTarget();
  }

  /** A move over the menu: a secondary drag dismisses it and pans. */
  move(x: number, y: number, held: boolean): void {
    if (!held) {
      this.release();
      return;
    }
    if (this.host.controller().right.move(x, y)) this.state.close();
  }

  /**
   * A secondary press over the page's own views (the composer, its dock, the
   * minimap), which sit above the canvas overlay and never let it see the
   * press. A drag pans through the same right gesture; a still press opens
   * no menu.
   */
  pressChrome(at: ContextMenuPoint): void {
    if (!this.host.controller().right.down(at.x, at.y)) return;
    this.state.close();
  }

  /** A pointer move over those views while the secondary gesture is tracked. */
  moveChrome(at: ContextMenuPoint, held: boolean): void {
    if (!this.host.controller().right.active()) return;
    this.move(at.x, at.y, held);
  }

  /** Adds the pressed card and closes the menu. */
  add(kind: NodeKindId, at: ContextMenuPress): void {
    this.state.close();
    this.host.addNode(kind, at.worldX, at.worldY);
  }

  /** Duplicates the pressed card and closes the menu. */
  copyCard(at: ContextMenuPress): void {
    const nodeId = at.nodeId;
    if (nodeId === null) return;
    this.state.close();
    this.host.copyNode(nodeId);
  }

  /** Deletes the pressed card and closes the menu. */
  deleteCard(at: ContextMenuPress): void {
    const nodeId = at.nodeId;
    if (nodeId === null) return;
    // One menu delete removes one card; in a multi-card selection, clear the
    // selection first as the Delete key does, so the survivors' composer does
    // not pop open.
    const scene = this.host.scene();
    if (scene.selection().length > 1 && scene.selection().includes(nodeId)) scene.select([]);
    this.state.close();
    this.host.deleteNode(nodeId);
  }

  /** Deletes the pressed connector and closes the menu. */
  deleteEdge(at: ContextMenuPress): void {
    const edgeId = at.edgeId;
    if (edgeId === null) return;
    this.state.close();
    this.host.deleteEdge(edgeId);
  }

  /** Closes the menu; true when one was open or about to open. */
  close(): boolean {
    return this.state.close();
  }

  /**
   * A card's menu shows which card its items act on: the card becomes the
   * selection. A press on a card already in a multiple selection keeps that
   * selection, and empty canvas leaves the selection alone. The page opens
   * the composer for a single selection except while this menu is open, so a
   * right click never pops the editor. A connector's menu likewise selects
   * that connector, as a left press on it does.
   */
  private selectTarget(): void {
    const open = this.open();
    if (open === null) return;
    const nodeId = open.nodeId;
    if (nodeId !== null) {
      const scene = this.host.scene();
      if (scene.selection().includes(nodeId)) return;
      scene.select([nodeId]);
      return;
    }
    const edgeId = open.edgeId;
    if (edgeId === null) return;
    if (this.host.scene().selectedEdge() === edgeId) return;
    this.host.selectEdge(edgeId);
  }
}

/**
 * Dismisses an open menu when the camera moves, or when the card it targets
 * leaves the scene or changes rectangle: its screen anchor and its items
 * would otherwise point at something the user is no longer looking at. Call
 * it during the page's render, in the page's owner.
 */
export function dismissContextMenuOnChange(
  menu: CanvasMenuController,
  camera: CanvasCamera,
  scene: FlowScene,
): void {
  effect(() => {
    camera.view();
    untracked(() => menu.close());
  });

  // The rectangle the menu opened over; a re-anchored or freshly opened menu
  // starts a new baseline, and a change from it moves the card out from under
  // the menu.
  let anchor: { id: string; rect: BoxGeometry } | null = null;
  effect(() => {
    const id = menu.open()?.nodeId ?? null;
    if (id === null) {
      anchor = null;
      return;
    }
    const rect = scene.cardRect(id);
    if (rect === null) {
      anchor = null;
      untracked(() => menu.close());
      return;
    }
    if (anchor === null || anchor.id !== id) {
      anchor = { id, rect };
      return;
    }
    if (sameRect(anchor.rect, rect)) return;
    anchor = null;
    untracked(() => menu.close());
  });

  // The connector's endpoints when the menu opened over it; a connector that
  // left the scene, or a curve a card move pulled away, no longer sits under
  // the menu's anchor.
  let edgeAnchor: { id: string; from: Point; to: Point } | null = null;
  effect(() => {
    const id = menu.open()?.edgeId ?? null;
    if (id === null) {
      edgeAnchor = null;
      return;
    }
    const edge = scene.edges().find((candidate) => candidate.id === id) ?? null;
    const ports = edge === null ? null : scene.edgePorts(edge);
    if (ports === null) {
      edgeAnchor = null;
      untracked(() => menu.close());
      return;
    }
    if (edgeAnchor === null || edgeAnchor.id !== id) {
      edgeAnchor = { id, from: ports.from, to: ports.to };
      return;
    }
    if (samePoint(edgeAnchor.from, ports.from) && samePoint(edgeAnchor.to, ports.to)) return;
    edgeAnchor = null;
    untracked(() => menu.close());
  });
}

function sameRect(a: BoxGeometry, b: BoxGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
