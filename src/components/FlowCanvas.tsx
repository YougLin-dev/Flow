/**
 * The native canvas: a translated and scaled world of cards and connectors,
 * a screen-space selection overlay, and one transparent view that turns
 * pointer events into canvas gestures.
 */
import {
  View,
  type GestureResponderEvent,
  type MouseEvent as NshMouseEvent,
  type PressEvent,
} from "nsh";
import type { CanvasCamera } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import type { FlowScene } from "../flow/scene";
import { FlowCard } from "./FlowCard";
import { FlowEdge } from "./FlowEdge";
import { FlowEdges } from "./FlowEdges";
import { GridBackground } from "./GridBackground";
import { SelectionFrame } from "./SelectionFrame";
import { SelectionOverlay } from "./SelectionOverlay";

export interface FlowCanvasProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
  readonly tool: () => "select" | "hand";
  readonly onSize: (size: { width: number; height: number }) => void;
  readonly onPan: (dx: number, dy: number) => void;
  readonly onZoom: (factor: number, x: number, y: number) => void;
}

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
    if (pressed || event.pressedButton !== null) {
      pressed = true;
      props.controller.move(lastX, lastY);
      return;
    }
    props.controller.hover(lastX, lastY);
  };

  const onLeave = (): void => {
    if (touchActive) return;
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
        <FlowEdges scene={props.scene} />
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
        <If when={props.scene.connectionPreview()}>
          {(preview) => (
            <FlowEdge
              from={() => preview().from}
              to={() => preview().to}
              selected={() => true}
              dashed
              zIndex={props.scene.previewZ()}
            />
          )}
        </If>
      </View>
      <SelectionOverlay controller={props.controller} />
      <View
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
        onPressDown={onDown}
        onPressUp={onUp}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      />
    </View>
  );
}
