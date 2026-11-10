/**
 * The native canvas: a translated and scaled world of cards and connectors,
 * a screen-space selection overlay, and one transparent view that turns
 * pointer events into canvas gestures.
 */
import {
  nativeComponent,
  View,
  type ContextMenuEvent,
  type GestureResponderEvent,
  type MouseEvent as NshMouseEvent,
  type PressEvent,
} from "nsh";
import type { CanvasCamera } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import type { ContextMenuPoint } from "../flow/context-menu";
import type { FlowScene } from "../flow/scene";
import { FlowCard } from "./FlowCard";
import { FlowEdges } from "./FlowEdges";
import { FlowPreviews } from "./FlowPreviews";
import { GridBackground } from "./GridBackground";
import { SelectionFrame } from "./SelectionFrame";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionPluses } from "./SelectionPluses";

export interface FlowCanvasProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
  readonly tool: () => "select" | "hand";
  readonly onSize: (size: { width: number; height: number }) => void;
  readonly onPan: (dx: number, dy: number) => void;
  readonly onZoom: (factor: number, x: number, y: number) => void;
  readonly onWheelZoom: (notches: number, x: number, y: number) => void;
  readonly onMenuPress: (at: ContextMenuPoint) => void;
  readonly onMenuRelease: () => void;
  readonly onMenuCancel: () => void;
}

interface WheelEvent {
  readonly x: number;
  readonly y: number;
  readonly notchesY: number;
}

interface WheelProps {
  /** The sensor takes no props of its own. */
  readonly noProps?: never;
}

/**
 * The canvas's pointer surface. It is a native component registered by the
 * Rust crate (`wheel_surface.rs`), which draws nothing and takes no pointer:
 * presses reach this view's handlers as on any view, and NSH hands the mouse
 * wheel and touchpad scrolls over it to `onWheel`. Where the component is not
 * registered (the headless engine), it renders an empty view and the pointer
 * handlers still work.
 */
const WheelSurface = nativeComponent<WheelProps, { wheel: WheelEvent }>("flow.wheel-surface", {
  props: [],
  events: ["wheel"],
});

interface TouchPoint {
  locationX?: number;
  locationY?: number;
  pageX: number;
  pageY: number;
}

export function FlowCanvas(props: FlowCanvasProps) {
  let pressed = false;
  let touchActive = false;
  let suppressUntil = 0;
  let pinching = false;
  let pinchDistance = 0;
  let pinchX = 0;
  let pinchY = 0;
  let lastX = 0;
  let lastY = 0;

  const pointOf = (touch: TouchPoint): { x: number; y: number } => ({
    x: touch.locationX ?? touch.pageX,
    y: touch.locationY ?? touch.pageY,
  });

  const distanceOf = (event: GestureResponderEvent): number => {
    const a = event.touches[0];
    const b = event.touches[1];
    if (!a || !b) return 0;
    return Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY);
  };

  const centerOf = (event: GestureResponderEvent): { x: number; y: number } => {
    const a = event.touches[0];
    const b = event.touches[1];
    if (!a || !b) return { x: 0, y: 0 };
    const first = pointOf(a);
    const second = pointOf(b);
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  };

  const onDown = (event: PressEvent): void => {
    if (touchActive || Date.now() < suppressUntil) return;
    props.controller.right.cancel();
    props.onMenuCancel();
    pressed = true;
    lastX = event.position.x;
    lastY = event.position.y;
    props.controller.down(lastX, lastY, event.modifiers.shift, event.clickCount);
  };

  const onUp = (event: PressEvent): void => {
    if (touchActive || Date.now() < suppressUntil) return;
    if (!pressed) return;
    pressed = false;
    lastX = event.position.x;
    lastY = event.position.y;
    props.controller.up(lastX, lastY);
  };

  const onMove = (event: NshMouseEvent): void => {
    if (touchActive) return;
    lastX = event.position.x;
    lastY = event.position.y;
    if (props.controller.right.active()) {
      // Any held button continues the gesture: a macOS Control-click is a
      // secondary press whose moves still report the physical left button.
      if (event.pressedButton !== null) {
        if (props.controller.right.move(lastX, lastY)) props.onMenuCancel();
        return;
      }
      // A release reported by a move (a host that does not send the
      // mouse-up event, or a release outside the window): finish it here,
      // opening the menu when the press never dragged.
      props.onMenuRelease();
      return;
    }
    // Only a press that began on this view may move a gesture: a primary press
    // that started on an overlay keeps its press-up there.
    if (pressed) {
      props.controller.move(lastX, lastY);
      return;
    }
    props.controller.hover(lastX, lastY);
  };

  const onContextMenu = (event: ContextMenuEvent): void => {
    // A secondary press is an action of its own: a tap just before it must
    // not swallow it. NSH reports a mouse press to `onTouch` listeners too,
    // so the tap's touch end set `suppressUntil` — which is for the press
    // events some platforms emulate after a touch, not for the next click.
    if (touchActive || pressed) return;
    props.onMenuPress({ x: event.position.x, y: event.position.y });
  };

  const onLeave = (): void => {
    if (touchActive) return;
    // The right gesture survives a leave: the pointer may move over an
    // overlay or out of the window, where releases are not hit-tested. It
    // ends on the mouse-up event, on the first move without a button (a
    // release the host did not report), or when the next press supersedes it.
    if (pressed) {
      // The pointer left the canvas while dragging; finish the gesture where
      // it last was instead of silently reverting the move.
      pressed = false;
      props.controller.up(lastX, lastY);
    }
    // The pointer is gone even if a gesture just ended at its last position:
    // a hover (and the plus it holds) must not stay behind after it leaves.
    props.controller.leave();
  };

  const onTouchStart = (event: GestureResponderEvent): void => {
    props.controller.right.cancel();
    props.onMenuCancel();
    touchActive = true;
    if (event.touches.length > 1) {
      pressed = false;
      props.controller.cancel();
      pinching = true;
      pinchDistance = distanceOf(event);
      const center = centerOf(event);
      pinchX = center.x;
      pinchY = center.y;
      return;
    }
    pinching = false;
    const touch = event.touches[0];
    if (!touch) return;
    const point = pointOf(touch);
    lastX = point.x;
    lastY = point.y;
    props.controller.down(point.x, point.y, false, 1);
  };

  const onTouchMove = (event: GestureResponderEvent): void => {
    if (event.touches.length > 1) {
      if (!pinching) {
        props.controller.cancel();
        pinching = true;
        pinchDistance = distanceOf(event);
        const center = centerOf(event);
        pinchX = center.x;
        pinchY = center.y;
        return;
      }
      const distance = distanceOf(event);
      const center = centerOf(event);
      if (pinchDistance > 0 && distance > 0)
        props.onZoom(distance / pinchDistance, center.x, center.y);
      props.onPan(center.x - pinchX, center.y - pinchY);
      pinchDistance = distance;
      pinchX = center.x;
      pinchY = center.y;
      return;
    }
    if (pinching) return;
    const touch = event.touches[0];
    if (!touch) return;
    const point = pointOf(touch);
    lastX = point.x;
    lastY = point.y;
    props.controller.move(lastX, lastY);
  };

  const onTouchEnd = (event: GestureResponderEvent): void => {
    if (pinching) {
      if (event.touches.length < 2) {
        pinching = false;
        touchActive = false;
        suppressUntil = Date.now() + 500;
      }
      return;
    }
    props.controller.up(lastX, lastY);
    touchActive = false;
    suppressUntil = Date.now() + 500;
  };

  const onTouchCancel = (): void => {
    touchActive = false;
    pinching = false;
    pressed = false;
    props.controller.cancel();
  };

  return (
    <View
      class="flex-1 bg-background"
      style={{ position: "relative", overflow: "hidden" }}
      onLayout={(event) =>
        props.onSize({ width: event.bounds.size.width, height: event.bounds.size.height })
      }
    >
      <GridBackground camera={props.camera} />
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: "visible",
          pointerEvents: "none",
          transformOrigin: "0 0",
          transform: `translate(${props.camera.x}px, ${props.camera.y}px) scale(${props.camera.scale})`,
        }}
      >
        <FlowEdges
          scene={props.scene}
          paused={() =>
            props.camera.moving() ||
            props.controller.portPlus() !== null ||
            props.controller.framePlus() !== null
          }
        />
        {/* The frame shares the world's stacking: above unselected cards and
            below the selected ones, so the swept area moves as one group. */}
        <SelectionFrame scene={props.scene} camera={props.camera} controller={props.controller} />
        <Each of={props.scene.nodes()} key={(node) => node.id}>
          {(node) => {
            // The id never changes for a row. Reading it once keeps the
            // card's signals from all depending on the node accessor: a
            // viewport refresh replaces the node record, and a plus whose
            // visibility read that record would be rebuilt on every refresh
            // while it follows the pointer.
            const id = node().id;
            return (
              <FlowCard
                node={node}
                rect={() => props.scene.cardRect(id)}
                zIndex={() => props.scene.cardZ(id)}
                preview={() => props.scene.previews().get(id) ?? null}
                selected={() => props.scene.selection().includes(id)}
                previewed={() => props.controller.marqueePreview().has(id)}
                hovered={() => props.controller.hovered() === id}
                plusSuppressed={() =>
                  props.controller.multiFrame() && props.scene.selection().includes(id)
                }
                plus={() => {
                  const plus = props.controller.portPlus();
                  return plus !== null && plus.nodeId === id
                    ? { side: plus.side, point: plus.point }
                    : null;
                }}
                target={() => props.scene.connectionTarget() === id}
              />
            );
          }}
        </Each>
        <SelectionPluses scene={props.scene} camera={props.camera} controller={props.controller} />
        <If when={props.scene.connectionPreviews()}>
          {(previews) => <FlowPreviews previews={previews} zIndex={props.scene.previewZ()} />}
        </If>
      </View>
      <SelectionOverlay controller={props.controller} />
      <WheelSurface
        testID="flow-canvas"
        accessibilityLabel="Flow canvas"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          backgroundColor: "transparent",
          cursor: props.controller.cursor(),
        }}
        onWheel={(event) => props.onWheelZoom(event.notchesY, event.x, event.y)}
        onPressDown={onDown}
        onPressUp={onUp}
        onMouseMove={onMove}
        // The menu controller only acts while a secondary press is tracked,
        // so the release's button need not be filtered here: a macOS
        // Control-click releases the physical left button.
        onMouseUp={() => props.onMenuRelease()}
        onMouseLeave={onLeave}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      />
    </View>
  );
}
