/**
 * Pointer interaction for the native canvas: selecting and dragging cards,
 * box selecting, resizing from a card's handles, moving the camera with the
 * secondary button, and the port/edge gestures. It owns no views; the canvas
 * components read its signals.
 */
import { batch, computed, signal } from "nsh";
import type { CanvasCursor } from "../model/cursor";
import type { BoxGeometry, NodeBounds, Point } from "../../shared";
import type { PortSide } from "../geometry/connection";
import type { CanvasCamera } from "../model/camera";
import type { ConnectionPair, MagnetPort } from "./connection-gesture";
import { EdgeGestures } from "./edge-gestures";
import { frameScreenRect } from "./frame-surface";
import { HoverFlags } from "./hover-flags";
import type { PortKind } from "../../nodes";
import { cursorForHandle, screenRect } from "./resize-handles";
import { RightGesture } from "./right-gesture";
import type { FlowScene } from "../model/scene/scene";
import {
  normalizeRect,
  type ResizeHandle,
  resizedRect,
  type ScreenRect,
} from "../geometry/selection";
import {
  dragPastThreshold,
  draggedRects,
  marqueeIds,
  marqueeIsClick,
  marqueeWorldRect,
  resizePastThreshold,
} from "./gesture-math";
import { canvasHit } from "./hit-priority";

/** The typed port whose icon follows the pointer. */
export interface PortHover {
  readonly nodeId: string;
  readonly side: PortSide;
  readonly portId: string;
  /** The pointer's world point. */
  readonly point: Point;
  /** The port icon's world centre; the connector anchor sits on the border. */
  readonly center: Point;
}

/** The group port whose icon follows the pointer, on a selection frame. */
export interface GroupPortHover {
  readonly side: PortSide;
  readonly portKind: PortKind;
  /** The pointer's world point. */
  readonly point: Point;
  readonly center: Point;
}

export interface CanvasHost {
  scene(): FlowScene;
  camera(): CanvasCamera;
  panBy(dx: number, dy: number): void;
  /** Persist the bounds a drag or resize ended with. */
  commitBounds(bounds: readonly NodeBounds[]): void;
  selectEdge(id: string | null): void;
  reconnectEdge(edgeId: string, pair: ConnectionPair): void;
  connectNodes(pairs: readonly ConnectionPair[]): void;
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

export class CanvasController {
  /** The box the user is dragging with the marquee, in screen points. */
  readonly marquee = signal<ScreenRect | null>(null);
  /** The cards a marquee in progress covers: what releasing would select. */
  readonly marqueePreview = signal<ReadonlySet<string>>(new Set());
  /** True after a marquee made a selection, so its frame stays shown. */
  readonly marqueeSelected = signal(false);
  /** The card under the pointer while no gesture runs. */
  readonly hovered = signal<string | null>(null);
  /** The typed port whose icon follows the pointer. */
  readonly hoveredPort = signal<PortHover | null>(null);
  /**
   * The hovered port's identity, without the pointer point that changes on
   * every move. Port views subscribe to this, so moving within one port
   * wakes only that port instead of every mounted one.
   */
  readonly hoveredPortKey = computed((): string | null => {
    const hover = this.hoveredPort();
    return hover === null ? null : portKey(hover.nodeId, hover.side, hover.portId);
  });
  /** The compatible port a dragged connector end magnetizes. */
  readonly connectionMagnet = signal<MagnetPort | null>(null);
  /** The magnetized port's identity, without the per-move pointer point:
   * port views subscribe to this, so only the held port follows the drag. */
  readonly connectionMagnetKey = computed((): string | null => {
    const magnet = this.connectionMagnet();
    return magnet === null ? null : portKey(magnet.nodeId, magnet.side, magnet.portId);
  });
  /** The selection frame's group port whose icon follows the pointer. */
  readonly hoveredGroup = signal<GroupPortHover | null>(null);
  /** The hovered group port's identity, without its per-move pointer point. */
  readonly hoveredGroupKey = computed((): string | null => {
    const hover = this.hoveredGroup();
    return hover === null ? null : `${hover.side}\u0000${hover.portKind}`;
  });
  /** True while a press moves cards, resizes one or pulls a connector. */
  readonly gesturing = signal(false);
  /**
   * True once the current gesture has actually moved: a drag or resize past
   * the click threshold, or a connector pulled away from its press point. A
   * still press stays a click even though `gesturing` is already true.
   */
  readonly gestureMoved = signal(false);
  readonly cursor = signal<CanvasCursor>("default");

  /** The secondary-button gesture: a drag pans, a still press opens the menu. */
  readonly right: RightGesture;
  readonly flags = new HoverFlags();

  private readonly edges: EdgeGestures;
  private edgeMode = false;
  private gesture: Gesture = idle();

  constructor(private readonly host: CanvasHost) {
    this.right = new RightGesture({
      canStart: () => this.gesture.mode === "idle" && !this.edgeMode,
      beginPan: (x, y) => this.beginPan(x, y),
      panTo: (x, y) => this.move(x, y),
      endPan: (x, y) => this.up(x, y),
    });
    this.edges = new EdgeGestures({
      scene: () => this.host.scene(),
      camera: () => this.host.camera(),
      selectedEdge: () => this.host.scene().selectedEdge(),
      selectEdge: (id) => this.host.selectEdge(id),
      reconnectEdge: (edgeId, pair) => this.host.reconnectEdge(edgeId, pair),
      connectNodes: (pairs) => this.host.connectNodes(pairs),
    });
  }

  /** The screen rectangle of a card, or null when it is not in the scene. */
  screenRect(id: string): ScreenRect | null {
    return screenRect(this.host.scene(), this.host.camera(), id);
  }

  /**
   * The screen rectangle around the selected cards, titles included, or null
   * when none are selected. It decides where the selection frame is pressed.
   */
  selectionBounds(): ScreenRect | null {
    const bounds = this.host.scene().selectionBounds();
    return bounds ? frameScreenRect(this.host.camera(), bounds) : null;
  }

  /** True while a marquee's frame spans two or more selected cards. */
  multiFrame(): boolean {
    return this.marqueeSelected() && this.host.scene().selection().length > 1;
  }

  /** A press is one state transition: readers see the gesture's final state. */
  down(x: number, y: number, shift: boolean, clickCount: number): void {
    batch(() => {
      const scene = this.host.scene();
      const camera = this.host.camera();
      this.right.cancel();
      this.edgeMode = false;
      this.gesturing.set(false);
      this.gestureMoved.set(false);
      this.hoveredPort.set(null);
      this.hoveredGroup.set(null);
      this.connectionMagnet.set(null);
      this.clearPreview();
      this.gesture = { ...idle(), startX: x, startY: y, lastX: x, lastY: y };
      const framed = this.multiFrame();
      const frameBounds = framed ? scene.selectionBounds() : null;
      const hit = canvasHit({ scene, camera, x, y, framed, frameBounds });

      // A group port is a connector handle for the whole selection. It is
      // tested before a press outside the frame would dismiss that frame; a
      // disabled group port consumes the press without starting anything.
      if (hit.kind === "framePort") {
        if (hit.port.enabled && this.edges.beginGroup(hit.port)) {
          this.edgeMode = true;
          this.gesturing.set(true);
          this.gesture = { ...this.gesture, mode: "edge" };
          this.cursor.set("crosshair");
        }
        return;
      }

      // The frame belongs to the area the marquee swept: it stays while the
      // pointer acts inside it (a member card's port included) and disappears
      // on a press outside.
      if (!hit.insideFrame) this.marqueeSelected.set(false);

      // Ports come before resize handles: a selected card's east and west
      // handles sit exactly on its ports, and a connection is the more common
      // gesture at that point. Every other press outside the frame may select
      // a connector first; inside the frame the whole area is one drag
      // surface, so a connector under it does not drop the multi-selection.
      if (hit.kind === "port") {
        this.edges.down(x, y, hit.port);
        this.edgeMode = true;
        this.gesturing.set(true);
        this.gesture = { ...this.gesture, mode: "edge" };
        this.cursor.set("crosshair");
        return;
      }
      if (hit.kind !== "frame" && this.edges.down(x, y, null)) {
        this.edgeMode = true;
        this.gesturing.set(true);
        this.gesture = { ...this.gesture, mode: "edge" };
        this.cursor.set("crosshair");
        return;
      }

      if (clickCount >= 2 && hit.card !== null && scene.kindOf(hit.card) === "text") {
        this.host.openInline(hit.card);
        return;
      }

      // The frame a marquee left is one drag surface: a press anywhere inside
      // it moves the whole selection, even on a card's border, instead of
      // resizing one card, replacing the selection or starting a new box.
      if (hit.kind === "frame") {
        this.startDrag();
        return;
      }

      if (hit.kind === "handle") {
        const base = scene.cardRect(hit.id);
        if (base) {
          // A handle resizes its card without a prior selection; the press
          // selects the card so the resize reads as acting on it.
          if (!(scene.selection().length === 1 && scene.selection()[0] === hit.id)) {
            scene.select([hit.id]);
          }
          this.gesturing.set(true);
          this.gesture = {
            ...this.gesture,
            mode: "resize",
            base: new Map([[hit.id, base]]),
            resizeId: hit.id,
            resizeSide: hit.side,
          };
          this.cursor.set(cursorForHandle(hit.side));
          return;
        }
      }

      if (hit.card !== null) {
        const id = hit.card;
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
    });
  }

  /** One pointer move is one gesture step; nested hover joins this round. */
  move(x: number, y: number): void {
    batch(() => {
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
        this.cursor.set("grabbing");
        return;
      }
      if (gesture.mode === "edge") {
        if (this.edgeMode) {
          this.connectionMagnet.set(this.edges.move(x, y));
          // A connector is pulled once the pointer leaves the press point;
          // the pre-move preview `down` published is still a click.
          if (x !== gesture.startX || y !== gesture.startY) this.markGestureMoved();
        }
        return;
      }
      if (gesture.mode === "marquee") {
        const box = normalizeRect(gesture.startX, gesture.startY, x, y);
        this.marquee.set(box);
        // The covered cards light up as the box sweeps: the preview is the
        // release's selection, written only when the covered set changes.
        if (marqueeIsClick(box)) this.clearPreview();
        else {
          this.setPreview(
            marqueeIds(
              this.host.scene(),
              marqueeWorldRect(this.host.camera(), box),
              gesture.additive,
            ),
          );
        }
        return;
      }
      if (gesture.mode === "drag") {
        if (!gesture.moved && dragPastThreshold(gesture.startX, gesture.startY, x, y)) {
          gesture.moved = true;
          this.markGestureMoved();
        }
        if (!gesture.moved) return;
        const camera = this.host.camera();
        const world = camera.toWorld(x, y);
        const start = camera.toWorld(gesture.startX, gesture.startY);
        this.host
          .scene()
          .setOverrides(draggedRects(gesture.base, world.x - start.x, world.y - start.y));
        this.cursor.set("grabbing");
        return;
      }
      if (gesture.mode === "resize") {
        if (!gesture.moved && resizePastThreshold(gesture.startX, gesture.startY, x, y)) {
          gesture.moved = true;
          this.markGestureMoved();
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
    });
  }

  /** A release publishes selection, frame and resting hover together. */
  up(x: number, y: number): void {
    batch(() => {
      const gesture = this.gesture;
      const moved = this.gestureMoved();
      this.gesture = idle();
      this.gesturing.set(false);
      this.gestureMoved.set(false);
      if (this.edgeMode) {
        this.edgeMode = false;
        // A press that never left its point is a click: it keeps the
        // selection instead of writing a connector to whatever port happens
        // to snap nearby.
        if (moved) this.edges.up(x, y);
        else this.edges.cancel();
        this.connectionMagnet.set(null);
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
        // gesture started on (a stale hover keeps its port showing).
        this.hover(x, y);
        return;
      }
      if (gesture.mode === "marquee") {
        const box = normalizeRect(gesture.startX, gesture.startY, x, y);
        const ids = this.selectWithin(gesture, box);
        this.marquee.set(null);
        this.clearPreview();
        // One card is a normal selection: the frame, its group ports and
        // its group drag are a multi-card selection's affordance.
        this.marqueeSelected.set(ids.length > 1);
        this.hover(x, y);
        return;
      }
      this.marquee.set(null);
      this.cursor.set("default");
      this.hover(x, y);
    });
  }

  /** A cancelled gesture restores one idle state. */
  cancel(): void {
    batch(() => {
      this.edges.cancel();
      this.right.cancel();
      this.edgeMode = false;
      this.gesturing.set(false);
      this.gestureMoved.set(false);
      this.hoveredPort.set(null);
      this.hoveredGroup.set(null);
      this.connectionMagnet.set(null);
      if (this.gesture.mode === "drag" || this.gesture.mode === "resize") {
        this.host.scene().clearOverrides();
      }
      this.gesture = idle();
      this.marquee.set(null);
      this.clearPreview();
      this.cursor.set("default");
    });
  }

  /** Clears hover and the cursor together when the pointer leaves. */
  leave(): void {
    batch(() => {
      this.setHovered(null);
      this.hoveredPort.set(null);
      this.hoveredGroup.set(null);
      this.connectionMagnet.set(null);
      this.cursor.set("default");
    });
  }

  /** Hover state is one derived UI state, not a separate round per signal. */
  hover(x: number, y: number): void {
    batch(() => {
      const scene = this.host.scene();
      const camera = this.host.camera();
      const framed = this.multiFrame();
      const frameBounds = framed ? scene.selectionBounds() : null;
      const hit = canvasHit({ scene, camera, x, y, framed, frameBounds });
      // A full input group says so with its cursor instead of inviting a drag
      // that would be rejected.
      if (hit.kind === "framePort") {
        this.setHovered(null);
        this.hoveredPort.set(null);
        this.hoveredGroup.set({
          side: hit.port.side,
          portKind: hit.port.portKind,
          point: hit.world,
          center: hit.port.center,
        });
        this.cursor.set(hit.port.enabled ? "crosshair" : "not-allowed");
        return;
      }
      this.hoveredGroup.set(null);
      // A typed port takes precedence over the east/west resize handles it
      // overlaps: pressing a visible port starts a connection.
      if (hit.kind === "port") {
        this.setHovered(hit.port.nodeId);
        this.hoveredPort.set({
          nodeId: hit.port.nodeId,
          side: hit.port.side,
          portId: hit.port.portId,
          point: hit.world,
          center: hit.port.point,
        });
        this.cursor.set("crosshair");
        return;
      }
      this.hoveredPort.set(null);
      // The frame a marquee left is one drag surface: card bodies and borders
      // inside it all move the whole selection, so the move cursor is shown
      // everywhere but the explicit ports above.
      if (hit.kind === "frame") {
        this.setHovered(hit.card);
        this.cursor.set("grab");
        return;
      }
      if (hit.kind === "handle") {
        this.setHovered(hit.id);
        this.cursor.set(cursorForHandle(hit.side));
        return;
      }
      this.setHovered(hit.card);
      this.cursor.set("default");
    });
  }

  /** Publishes a gesture's first real movement; later moves are no-ops. */
  private markGestureMoved(): void {
    if (!this.gestureMoved()) this.gestureMoved.set(true);
  }

  /** Writes hover and its per-id mirror in the caller's pointer-event batch. */
  private setHovered(id: string | null): void {
    this.hovered.set(id);
    this.flags.setHovered(id);
  }

  /** Starts a camera pan (the secondary button owns the press). */
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

  private selectWithin(gesture: Gesture, box: ScreenRect): readonly string[] {
    if (marqueeIsClick(box)) return [];
    const scene = this.host.scene();
    const ids = marqueeIds(scene, marqueeWorldRect(this.host.camera(), box), gesture.additive);
    scene.select(ids);
    return ids;
  }

  /** Writes a preview only when the covered set changed, keeping rows still. */
  private setPreview(ids: readonly string[]): void {
    const current = this.marqueePreview();
    if (ids.length === current.size && ids.every((id) => current.has(id))) return;
    const next = new Set(ids);
    this.marqueePreview.set(next);
    this.flags.setPreviewed(next);
  }

  private clearPreview(): void {
    if (this.marqueePreview().size === 0) return;
    const next = new Set<string>();
    this.marqueePreview.set(next);
    this.flags.setPreviewed(next);
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

/** The stable identity of one typed port. */
export function portKey(nodeId: string, side: PortSide, portId: string): string {
  return `${nodeId}\u0000${side}\u0000${portId}`;
}
