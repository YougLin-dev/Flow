/**
 * Pointer interaction for the native canvas: selecting and dragging cards,
 * box selecting, resizing from a card's handles, moving the camera with the
 * hand tool, and the port/edge gestures. It owns no views; the canvas
 * components read its signals.
 */
import { signal, type ViewStyle } from "nsh";
import type { NodeBounds } from "@flow/native";
import type { CanvasCamera } from "./camera";
import type { BoxGeometry, Point, PortSide } from "./connection";
import { EdgeGestures } from "./edge-gestures";
import type { FlowScene } from "./scene";
import {
  handleAt,
  intersects,
  normalizeRect,
  type ResizeHandle,
  resizedRect,
  type ScreenRect,
} from "./selection";

export type CanvasCursor = NonNullable<ViewStyle["cursor"]>;
export type CanvasTool = "select" | "hand";

/** A card's plus button while it follows the pointer, in world coordinates. */
export interface PortPlus {
  readonly nodeId: string;
  readonly side: PortSide;
  readonly point: Point;
}

export interface CanvasHost {
  scene(): FlowScene;
  camera(): CanvasCamera;
  tool(): CanvasTool;
  panBy(dx: number, dy: number): void;
  /** Persist the bounds a drag or resize ended with. */
  commitBounds(bounds: readonly NodeBounds[]): void;
  selectEdge(id: string | null): void;
  reconnectEdge(edgeId: string, fromId: string, toId: string): void;
  connectNodes(fromId: string, toId: string): void;
  openInline(nodeId: string): void;
  /** A card was pressed (it may already be selected): show its composer. */
  onCardPress(nodeId: string): void;
}

type Mode = "idle" | "pan" | "drag" | "resize" | "marquee" | "edge";

interface Gesture {
  mode: Mode;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  base: Map<string, BoxGeometry>;
  resizeId: string | null;
  resizeSide: ResizeHandle | null;
  additive: boolean;
  moved: boolean;
}

const DRAG_THRESHOLD = 2;

export class CanvasController {
  /** The box the user is dragging with the marquee, in screen points. */
  readonly marquee = signal<ScreenRect | null>(null);
  /** The card under the pointer while no gesture runs. */
  readonly hovered = signal<string | null>(null);
  /** The plus button following the pointer in a card's side zone. */
  readonly portPlus = signal<PortPlus | null>(null);
  /** True while a press moves cards, resizes one or pulls a connector. */
  readonly gesturing = signal(false);
  readonly cursor = signal<CanvasCursor>("default");

  private readonly edges: EdgeGestures;
  private edgeMode = false;
  private gesture: Gesture = idle();

  constructor(private readonly host: CanvasHost) {
    this.edges = new EdgeGestures({
      scene: () => this.host.scene(),
      camera: () => this.host.camera(),
      selectedEdge: () => this.host.scene().selectedEdge(),
      selectEdge: (id) => this.host.selectEdge(id),
      reconnectEdge: (edgeId, fromId, toId) => this.host.reconnectEdge(edgeId, fromId, toId),
      connectNodes: (fromId, toId) => this.host.connectNodes(fromId, toId),
      changed: () => undefined,
    });
  }

  /** The screen rectangle of a card, or null when it is not in the scene. */
  screenRect(id: string): ScreenRect | null {
    const rect = this.host.scene().cardRect(id);
    if (!rect) return null;
    const camera = this.host.camera();
    const topLeft = camera.toScreen(rect.x, rect.y);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: rect.width * camera.scale,
      height: rect.height * camera.scale,
    };
  }

  /**
   * The card whose resize handle is under a screen point, topmost first.
   * Handles work on every visible card, not only the selected one, so a card
   * can be resized with one press. A card under the point owns the decision:
   * another card's handle never reaches through it.
   */
  private handleAtPoint(x: number, y: number): { id: string; side: ResizeHandle } | null {
    const scene = this.host.scene();
    const camera = this.host.camera();
    const world = camera.toWorld(x, y);
    const under = scene.nodeAt(world.x, world.y);
    if (under !== null) {
      const rect = this.screenRect(under);
      const side = rect ? handleAt(rect, x, y) : null;
      return side === null ? null : { id: under, side };
    }
    // Outside every card: a handle reaches past its card's border, so look
    // for the topmost one within reach.
    let hit: { id: string; side: ResizeHandle; z: number } | null = null;
    for (const node of scene.nodes()) {
      const rect = this.screenRect(node.id);
      if (!rect) continue;
      const side = handleAt(rect, x, y);
      if (side !== null && (hit === null || node.z >= hit.z)) {
        hit = { id: node.id, side, z: node.z };
      }
    }
    return hit === null ? null : { id: hit.id, side: hit.side };
  }

  down(x: number, y: number, shift: boolean, clickCount: number): void {
    const scene = this.host.scene();
    const camera = this.host.camera();
    this.edgeMode = false;
    this.gesturing.set(false);
    this.portPlus.set(null);
    this.gesture = { ...idle(), startX: x, startY: y, lastX: x, lastY: y };

    if (this.host.tool() === "hand") {
      this.beginPan(x, y);
      return;
    }

    // Ports come before resize handles: a selected card's east and west
    // handles sit exactly on its ports, and a connection is the more common
    // gesture at that point.
    if (this.edges.down(x, y)) {
      this.edgeMode = true;
      this.gesturing.set(true);
      this.gesture = { ...this.gesture, mode: "edge" };
      this.cursor.set("crosshair");
      return;
    }

    const target = this.handleAtPoint(x, y);
    const base = target === null ? null : scene.cardRect(target.id);
    if (target && base) {
      // A handle resizes its card without a prior selection; the press
      // selects the card so the resize reads as acting on it.
      if (!(scene.selection().length === 1 && scene.selection()[0] === target.id)) {
        scene.select([target.id]);
      }
      this.gesturing.set(true);
      this.gesture = {
        ...this.gesture,
        mode: "resize",
        base: new Map([[target.id, base]]),
        resizeId: target.id,
        resizeSide: target.side,
      };
      this.cursor.set(cursorFor(target.side));
      return;
    }

    if (clickCount >= 2) {
      const world = camera.toWorld(x, y);
      const id = scene.nodeAt(world.x, world.y);
      if (id !== null && scene.kindOf(id) === "text") {
        this.host.openInline(id);
        return;
      }
    }

    const world = camera.toWorld(x, y);
    const id = scene.nodeAt(world.x, world.y);
    if (id !== null) {
      if (shift) scene.toggleSelected(id);
      else if (!scene.selection().includes(id)) scene.select([id]);
      if (scene.selection().includes(id)) {
        this.host.onCardPress(id);
        this.startDrag();
        return;
      }
      // A shift press on a selected card is consumed by deselecting it; a
      // slightly moved release must not become an additive marquee that
      // covers (and re-adds) the very card the user removed.
      if (shift) {
        this.host.selectEdge(null);
        return;
      }
    }

    if (!shift) scene.select([]);
    this.host.selectEdge(null);
    this.gesture = { ...this.gesture, mode: "marquee", additive: shift };
    this.marquee.set({ x, y, width: 0, height: 0 });
    this.cursor.set("crosshair");
  }

  move(x: number, y: number): void {
    const gesture = this.gesture;
    if (gesture.mode === "idle") {
      this.hover(x, y);
      return;
    }
    const dx = x - gesture.lastX;
    const dy = y - gesture.lastY;
    gesture.lastX = x;
    gesture.lastY = y;

    if (gesture.mode === "pan") {
      this.host.panBy(dx, dy);
      return;
    }
    if (gesture.mode === "edge") {
      if (this.edgeMode) this.edges.move(x, y);
      return;
    }
    if (gesture.mode === "marquee") {
      this.marquee.set(normalizeRect(gesture.startX, gesture.startY, x, y));
      return;
    }
    if (gesture.mode === "drag") {
      if (screenDistance(gesture, x, y) > DRAG_THRESHOLD) gesture.moved = true;
      if (!gesture.moved) return;
      const camera = this.host.camera();
      const world = camera.toWorld(x, y);
      const start = camera.toWorld(gesture.startX, gesture.startY);
      const worldDx = world.x - start.x;
      const worldDy = world.y - start.y;
      const next = new Map<string, BoxGeometry>();
      for (const [id, rect] of gesture.base) {
        next.set(id, { ...rect, x: rect.x + worldDx, y: rect.y + worldDy });
      }
      this.host.scene().setOverrides(next);
      this.cursor.set("grabbing");
      return;
    }
    if (gesture.mode === "resize") {
      if (
        Math.abs(x - gesture.startX) > DRAG_THRESHOLD ||
        Math.abs(y - gesture.startY) > DRAG_THRESHOLD
      ) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      const camera = this.host.camera();
      const world = camera.toWorld(x, y);
      const start = camera.toWorld(gesture.startX, gesture.startY);
      const id = gesture.resizeId;
      const side = gesture.resizeSide;
      const base = id ? gesture.base.get(id) : null;
      if (!id || !side || !base) return;
      this.host
        .scene()
        .setOverrides(
          new Map([[id, resizedRect(base, side, world.x - start.x, world.y - start.y)]]),
        );
    }
  }

  up(x: number, y: number): void {
    const gesture = this.gesture;
    this.gesture = idle();
    this.gesturing.set(false);
    if (this.edgeMode) {
      this.edgeMode = false;
      this.edges.up(x, y);
      this.hover(x, y);
      return;
    }
    if (gesture.mode === "drag" || gesture.mode === "resize") {
      if (gesture.moved) {
        const bounds = this.host.scene().commitBounds();
        // A gesture that ended where it began has nothing to write; drop its
        // override instead of leaving transient geometry in the scene.
        if (bounds.length === 0) this.host.scene().clearOverrides();
        else this.host.commitBounds(bounds);
      } else {
        this.host.scene().clearOverrides();
      }
      // The pointer may have ended the gesture somewhere else, or on a
      // border: read the hover state there instead of keeping the card the
      // gesture started on (a stale hover keeps its plus showing).
      this.hover(x, y);
      return;
    }
    if (gesture.mode === "marquee") {
      const box = normalizeRect(gesture.startX, gesture.startY, x, y);
      this.selectWithin(gesture, box);
      this.marquee.set(null);
      this.hover(x, y);
      return;
    }
    this.marquee.set(null);
    this.cursor.set("default");
    this.hover(x, y);
  }

  cancel(): void {
    this.edges.cancel();
    this.edgeMode = false;
    this.gesturing.set(false);
    this.portPlus.set(null);
    if (this.gesture.mode === "drag" || this.gesture.mode === "resize") {
      this.host.scene().clearOverrides();
    }
    this.gesture = idle();
    this.marquee.set(null);
    this.cursor.set("default");
  }

  /** Clears the pointer state when it leaves the canvas. */
  leave(): void {
    this.hovered.set(null);
    this.portPlus.set(null);
    this.cursor.set("default");
  }

  /** A mouse move with no button down, updating hover and the cursor. */
  hover(x: number, y: number): void {
    const scene = this.host.scene();
    const camera = this.host.camera();
    const world = camera.toWorld(x, y);
    const tool = this.host.tool();
    // A plus zone takes precedence over the east/west resize handles it
    // overlaps: pressing a visible plus starts a connection.
    if (tool === "select") {
      const zone = scene.portZoneAt(world.x, world.y);
      if (zone) {
        this.hovered.set(zone.nodeId);
        this.portPlus.set({ nodeId: zone.nodeId, side: zone.side, point: zone.point });
        this.cursor.set("crosshair");
        return;
      }
    }
    const target = this.handleAtPoint(x, y);
    if (target) {
      this.hovered.set(target.id);
      this.portPlus.set(null);
      this.cursor.set(cursorFor(target.side));
      return;
    }
    this.hovered.set(scene.nodeAt(world.x, world.y));
    this.portPlus.set(null);
    this.cursor.set(tool === "hand" ? "grab" : "default");
  }

  /** Starts a camera pan (the hand tool owns the press). */
  beginPan(x: number, y: number): void {
    this.gesture = { ...idle(), mode: "pan", startX: x, startY: y, lastX: x, lastY: y };
    this.cursor.set("grabbing");
  }

  private startDrag(): void {
    const scene = this.host.scene();
    const base = new Map<string, BoxGeometry>();
    for (const id of scene.selection()) {
      const rect = scene.cardRect(id);
      if (rect) base.set(id, rect);
    }
    this.gesturing.set(true);
    this.gesture = { ...this.gesture, mode: "drag", base };
    this.host.selectEdge(null);
    this.cursor.set("grabbing");
  }

  private selectWithin(gesture: Gesture, box: ScreenRect): void {
    const scene = this.host.scene();
    const camera = this.host.camera();
    if (box.width < 1 && box.height < 1) return;
    const topLeft = camera.toWorld(box.x, box.y);
    const bottomRight = camera.toWorld(box.x + box.width, box.y + box.height);
    const world = {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
    const ids = gesture.additive ? [...scene.selection()] : [];
    for (const node of scene.nodes()) {
      const rect = scene.cardRect(node.id);
      if (rect && intersects(rect, world) && !ids.includes(node.id)) ids.push(node.id);
    }
    scene.select(ids);
  }
}

function idle(): Gesture {
  return {
    mode: "idle",
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    base: new Map(),
    resizeId: null,
    resizeSide: null,
    additive: false,
    moved: false,
  };
}

function screenDistance(gesture: Gesture, x: number, y: number): number {
  return Math.hypot(x - gesture.startX, y - gesture.startY);
}

function cursorFor(handle: ResizeHandle): CanvasCursor {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      throw new Error(`Unexpected resize handle "${String(handle)}".`);
  }
}
