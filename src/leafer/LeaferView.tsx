/**
 * A `<Canvas>` that runs a Leafer scene natively.
 *
 * The first `draw` builds a Leafer App with the canvas' size; every later
 * frame replays its drawing onto NSH's canvas. The app's scene (`tree`) and
 * editor (`sky`) live in separate layers, so the editor can select, move and
 * resize elements while the scene pans underneath. Pointer and touch events
 * go to Leafer's interaction in the select tool; the hand tool pans here.
 */
import {
  Canvas,
  cleanup,
  platform,
  signal,
  token,
  type CanvasRenderingContext2D,
  type CanvasSize,
  type ContextMenuEvent,
  type GestureResponderEvent,
  type MouseEvent as NshMouseEvent,
  type PressEvent,
  type StyleProp,
  type ViewStyle,
} from "nsh";
import type { ILeaf } from "@leafer-ui/interface";
import { App, RenderEvent } from "@leafer-ui/miniapp";
import "@leafer-in/editor";
import type { Tool } from "../tool";
import {
  addDrawRequester,
  clearRenderMarks,
  installNshPlatform,
  LeaferHost,
  pointerData,
} from "./nsh-platform";

installNshPlatform();

export interface LeaferViewProps {
  /** Runs once, as soon as the canvas size is known: build the scene. */
  setup?: (app: App, size: CanvasSize) => void;
  /** Which tool the pointer uses right now. */
  tool?: () => Tool | undefined;
  /** The user dragged with the hand tool: move the scene by this much. */
  onPan?: (dx: number, dy: number) => void;
  /** The user pinched: scale the scene around a point of the canvas. */
  onZoom?: (factor: number, x: number, y: number) => void;
  /** The select tool finished a press: persist any moved or resized elements. */
  onCommit?: () => void;
  /** Called when the canvas changes size (the second and later sizes). */
  onResize?: (size: CanvasSize) => void;
  /** Draws what is behind the scene; the default is a dot grid. */
  drawBackdrop?: (cx: CanvasRenderingContext2D, size: CanvasSize) => void;
  class?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

interface ModifierEvent {
  modifiers?: {
    alt?: boolean;
    control?: boolean;
    shift?: boolean;
    platform?: boolean;
  };
}

interface TouchPoint {
  locationX?: number;
  locationY?: number;
  pageX: number;
  pageY: number;
}

type CursorStyle = NonNullable<ViewStyle["cursor"]>;

const handleCursors = [
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
] as const satisfies readonly CursorStyle[];

export function LeaferView(props: LeaferViewProps) {
  const tick = signal(0);
  const cursor = signal<CursorStyle>("default");
  let host: LeaferHost | null = null;
  let app: App | null = null;
  let width = 1;
  let height = 1;
  let scheduled = false;
  let drawing = false;
  let disposed = false;
  let frameId = 0;

  // Panning with the hand tool (a mouse press, or a finger on a phone).
  let panning = false;
  let panX = 0;
  let panY = 0;
  // Who owns the active press: Leafer, or the hand-tool pan.
  let activePointer: "leafer" | "pan" | null = null;

  // Two-finger zoom.
  let pinching = false;
  let pinchDistance = 0;
  let pinchX = 0;
  let pinchY = 0;

  // A finger sequence also makes platforms with a mouse send press/mouse
  // events; those are ignored until shortly after the touches end.
  let touchActive = false;
  let suppressPressUntil = 0;

  // Touch events carry no modifier keys, but the mouse events sent alongside
  // them do (Windows sends both for a click). Keep the latest ones so a
  // Shift-click reaches Leafer whichever event starts the press.
  let modifierState: ModifierState = {
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
  };

  const request = (): void => {
    // Renders mark themselves changed while the frame is being drawn; those
    // marks must not schedule another frame, or the canvas never goes idle.
    if (scheduled || drawing || disposed) return;
    scheduled = true;
    frameId = requestAnimationFrame(() => {
      scheduled = false;
      if (!disposed) tick.update((n) => n + 1);
    });
  };

  const removeDrawRequester = addDrawRequester(request);
  cleanup(() => {
    disposed = true;
    cancelAnimationFrame(frameId);
    removeDrawRequester();
    app?.destroy();
    app = null;
    host?.dispose();
    host = null;
  });

  const pan = (dx: number, dy: number): void => {
    props.onPan?.(dx, dy);
  };

  const zoomAt = (factor: number, cx: number, cy: number): void => {
    props.onZoom?.(factor, cx, cy);
  };

  const hand = (): boolean => (props.tool?.() ?? "select") === "hand";

  /** NSH's modifier keys, in the shape Leafer's interaction reads them. */
  const modifierKeys = (e: ModifierEvent): ModifierState => ({
    altKey: Boolean(e.modifiers?.alt),
    ctrlKey: Boolean(e.modifiers?.control),
    shiftKey: Boolean(e.modifiers?.shift),
    metaKey: Boolean(e.modifiers?.platform),
  });

  const rememberModifiers = (e: ModifierEvent): ModifierState => {
    modifierState = modifierKeys(e);
    return modifierState;
  };

  /** Maps an editor handle to a cursor NSH's canvas can show. */
  const handleCursor = (leaf: ILeaf): CursorStyle | null => {
    if (leaf.name === "circle") return "grab";
    if (leaf.name === "rect") return "move";
    // Direction9: top-left, top, top-right, right, bottom-right, ...
    const direction = "direction" in leaf ? leaf.direction : undefined;
    return typeof direction === "number" ? (handleCursors[direction] ?? null) : null;
  };

  /** Mirrors what Leafer's interaction would set as the mouse cursor. */
  const updateCursor = (): void => {
    if (!platform.desktop) return;
    if (hand()) {
      cursor.set(panning ? "grabbing" : "grab");
      return;
    }
    const interaction = app?.interaction;
    if (!interaction) return;
    if (panning || interaction.dragging) {
      cursor.set("grabbing");
      return;
    }
    const path = interaction.hoverData?.path?.list ?? [];
    for (const leaf of path) {
      if (typeof leaf.cursor === "string" && leaf.cursor && leaf.cursor !== "none") {
        cursor.set(leaf.cursor);
        return;
      }
      if (leaf.cursor && typeof leaf.cursor === "object") {
        const mapped = handleCursor(leaf);
        if (mapped) {
          cursor.set(mapped);
          return;
        }
      }
      if (leaf.draggable) {
        cursor.set("grab");
        return;
      }
    }
    cursor.set("default");
  };

  const touchPoint = (touch: TouchPoint): { x: number; y: number } => ({
    x: touch.locationX ?? touch.pageX,
    y: touch.locationY ?? touch.pageY,
  });

  const touchDistance = (e: GestureResponderEvent): number => {
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
  };

  const touchCenter = (e: GestureResponderEvent): { x: number; y: number } => {
    const a = touchPoint(e.touches[0]);
    const b = touchPoint(e.touches[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  // -- desktop ---------------------------------------------------------------

  const onDown = (e: PressEvent): void => {
    const keys = rememberModifiers(e);
    if (!app || touchActive || Date.now() < suppressPressUntil) return;
    if (hand()) {
      activePointer = "pan";
      panning = true;
      panX = e.position.x;
      panY = e.position.y;
      updateCursor();
      return;
    }
    activePointer = "leafer";
    app.interaction?.pointerDown(pointerData(e.position.x, e.position.y, keys));
    updateCursor();
  };

  const onMove = (e: NshMouseEvent): void => {
    rememberModifiers(e);
    if (!app || touchActive) return;
    if (activePointer === "pan") {
      pan(e.position.x - panX, e.position.y - panY);
      panX = e.position.x;
      panY = e.position.y;
      updateCursor();
      return;
    }
    app.interaction?.pointerMove(pointerData(e.position.x, e.position.y, modifierState));
    updateCursor();
  };

  const onUp = (e: PressEvent): void => {
    const keys = rememberModifiers(e);
    if (!app || touchActive || Date.now() < suppressPressUntil) return;
    if (activePointer === "pan") {
      activePointer = null;
      panning = false;
      updateCursor();
      return;
    }
    if (activePointer === "leafer") {
      activePointer = null;
      app.interaction?.pointerUp(
        pointerData(e.position.x, e.position.y, {
          buttons: 0,
          button: 0,
          ...keys,
        }),
      );
      updateCursor();
      props.onCommit?.();
      return;
    }
    if (hand()) return;
    app.interaction?.pointerUp(
      pointerData(e.position.x, e.position.y, {
        buttons: 0,
        button: 0,
        ...keys,
      }),
    );
    updateCursor();
    props.onCommit?.();
  };

  const onLeave = (): void => {
    if (!app) return;
    if (activePointer === "leafer") {
      app.interaction?.pointerCancel();
      // Leafer does not revert a drag it cancels; persist whatever moved
      // before the pointer left so the next snapshot cannot snap it back.
      props.onCommit?.();
    }
    activePointer = null;
    panning = false;
    pinching = false;
    app.interaction?.cancelHover();
    cursor.set(hand() ? "grab" : "default");
  };

  const onContextMenu = (e: ContextMenuEvent): void => {
    const keys = rememberModifiers(e);
    if (!app) return;
    app.interaction?.menu(
      pointerData(e.position.x, e.position.y, {
        button: 2,
        buttons: 0,
        ...keys,
      }),
    );
  };

  // -- touch -----------------------------------------------------------------

  const onTouchStart = (e: GestureResponderEvent): void => {
    if (!app) return;
    touchActive = true;
    if (e.touches.length > 1) {
      app.interaction?.pointerCancel();
      activePointer = null;
      panning = false;
      pinching = true;
      pinchDistance = touchDistance(e);
      const center = touchCenter(e);
      pinchX = center.x;
      pinchY = center.y;
      return;
    }
    pinching = false;
    const point = touchPoint(e);
    if (hand()) {
      activePointer = "pan";
      panning = true;
      panX = point.x;
      panY = point.y;
      return;
    }
    activePointer = "leafer";
    app.interaction?.pointerDown(
      pointerData(point.x, point.y, {
        pointerType: "touch",
        ...modifierState,
      }),
    );
  };

  const onTouchMove = (e: GestureResponderEvent): void => {
    if (!app) return;
    if (pinching && e.touches.length > 1) {
      const distance = touchDistance(e);
      const center = touchCenter(e);
      if (pinchDistance > 0) {
        zoomAt(distance / pinchDistance, center.x, center.y);
        pan(center.x - pinchX, center.y - pinchY);
      }
      pinchDistance = distance;
      pinchX = center.x;
      pinchY = center.y;
      return;
    }
    if (panning) {
      const point = touchPoint(e);
      pan(point.x - panX, point.y - panY);
      panX = point.x;
      panY = point.y;
      return;
    }
    if (activePointer !== "leafer") return;
    const point = touchPoint(e);
    app.interaction?.pointerMove(
      pointerData(point.x, point.y, {
        pointerType: "touch",
        multiTouch: e.touches.length > 1,
        ...modifierState,
      }),
    );
  };

  const onTouchEnd = (e: GestureResponderEvent): void => {
    if (!app) return;
    touchActive = false;
    suppressPressUntil = Date.now() + 500;
    if (pinching) {
      if (e.touches.length < 2) {
        pinching = false;
        panning = false;
        activePointer = null;
      }
      return;
    }
    if (activePointer === "pan") {
      activePointer = null;
      panning = false;
      return;
    }
    if (activePointer !== "leafer") return;
    activePointer = null;
    const point = touchPoint(e);
    app.interaction?.pointerUp(
      pointerData(point.x, point.y, {
        pointerType: "touch",
        buttons: 0,
        button: 0,
        ...modifierState,
      }),
    );
    props.onCommit?.();
  };

  const onTouchCancel = (): void => {
    if (!app) return;
    touchActive = false;
    suppressPressUntil = Date.now() + 500;
    pinching = false;
    panning = false;
    const wasEditing = activePointer === "leafer";
    activePointer = null;
    app.interaction?.pointerCancel();
    if (wasEditing) props.onCommit?.();
  };

  // -- drawing ---------------------------------------------------------------

  const draw = (cx: CanvasRenderingContext2D, size: CanvasSize): void => {
    tick();
    const w = Math.max(1, Math.round(size.width));
    const h = Math.max(1, Math.round(size.height));
    if (!host) host = new LeaferHost();

    if (!app) {
      width = w;
      height = h;
      host.view.width = w;
      host.view.height = h;
      // An App stacks `tree` (the scene) and `sky` (the editor): the editor
      // lives in its own layer, so its handles never mix with the scene's
      // hit testing, and box selection can start on empty canvas.
      app = new App({
        view: host.view,
        width: w,
        height: h,
        pixelRatio: 1,
        usePartRender: false,
        start: false,
        tree: {},
        editor: {},
      });
      props.setup?.(app, { width: w, height: h });
      app.start();
    } else if (w !== width || h !== height) {
      width = w;
      height = h;
      app.resize({ width: w, height: h, pixelRatio: 1 });
      props.onResize?.({ width: w, height: h });
    }

    const currentApp = app;
    const drawingHost = host;

    drawing = true;
    try {
      drawingHost.beginFrame(cx, w, h);
      if (props.drawBackdrop) props.drawBackdrop(cx, { width: w, height: h });
      else drawBackdrop(cx, w, h);
      // Leafer's renderer keeps the time of the frame it asked for and
      // refuses to ask for another until that frame runs. There is no browser
      // loop here: every NSH frame draws a full frame, so clear that mark on
      // every layer and let the next change schedule another one. Rendering
      // marks the app changed again (a child's render ends), so clear the
      // marks after the frame too, or the next change would never ask for one.
      clearRenderMarks(currentApp);
      // The tree and the sky render into their own canvases; the app copies
      // both onto the view. Announcing the children's render the way Leafer's
      // App renderer does lets the editor know the scene moved and update its
      // box before the sky draws.
      currentApp.emit(RenderEvent.CHILD_START, currentApp);
      currentApp.forceRender(undefined, true);
      currentApp.emit(RenderEvent.CHILD_END, currentApp);
      currentApp.renderer.render();
      clearRenderMarks(currentApp);
    } finally {
      drawing = false;
      drawingHost.endFrame();
    }
  };

  // With `exactOptionalPropertyTypes`, pass optional props only when set.
  const optionalProps = {
    ...(props.class === undefined ? {} : { class: props.class }),
    ...(props.testID === undefined ? {} : { testID: props.testID }),
  };

  return (
    <Canvas
      {...optionalProps}
      accessibilityLabel="Flow canvas"
      style={[props.style, { cursor: cursor() }]}
      draw={draw}
      onPressDown={onDown}
      onPressUp={onUp}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onContextMenu={onContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    />
  );
}

/** The dot grid behind the scene, drawn before Leafer replays its frame. */
function drawBackdrop(cx: CanvasRenderingContext2D, w: number, h: number): void {
  cx.fillStyle = token("background");
  cx.fillRect(0, 0, w, h);

  const gap = 28;
  cx.beginPath();
  for (let x = gap; x < w; x += gap) {
    for (let y = gap; y < h; y += gap) {
      cx.moveTo(x + 1, y);
      cx.arc(x, y, 1, 0, Math.PI * 2);
    }
  }
  cx.fillStyle = token("grid-dot");
  cx.fill();
}
