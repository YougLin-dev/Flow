/**
 * The native canvas: a translated and scaled world of cards and connectors,
 * a screen-space selection overlay, and one transparent view that turns
 * pointer events into canvas gestures.
 */
import {
  computed,
  effect,
  platform,
  signal,
  View,
  type ContextMenuEvent,
  type GestureResponderEvent,
  type MouseEvent as NshMouseEvent,
  type PressEvent,
} from "nsh";
import { type CanvasCamera, type CameraSize, sameBounds, wheelNotches } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import type { ContextMenuPoint } from "../flow/context-menu";
import type { FlowScene } from "../flow/scene";
import { cardInView } from "../flow/view-culling";
import { FlowCard, type CardImageEvent } from "./FlowCard";
import { FlowEdges } from "./FlowEdges";
import { FlowPreviews } from "./FlowPreviews";
import { GridBackground } from "./GridBackground";
import { PortTooltip } from "./PortTooltip";
import { SelectionFrame } from "./SelectionFrame";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionPorts } from "./SelectionPorts";

export interface FlowCanvasProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
  /** The page's stage size: the one the camera and minimap share. */
  readonly stage: () => CameraSize;
  readonly onSize: (size: { width: number; height: number }) => void;
  readonly onPan: (dx: number, dy: number) => void;
  readonly onZoom: (factor: number, x: number, y: number) => void;
  readonly onWheelZoom: (notches: number, x: number, y: number) => void;
  readonly onMenuPress: (at: ContextMenuPoint) => void;
  readonly onMenuRelease: () => void;
  readonly onMenuCancel: () => void;
  /** The test-only image observation path; normal rendering has no hook. */
  readonly imageEvent?: ((event: CardImageEvent) => void) | undefined;
}

interface TouchPoint {
  locationX?: number;
  locationY?: number;
  pageX: number;
  pageY: number;
}

export function FlowCanvas(props: FlowCanvasProps) {
  // The page's stage starts at a placeholder size; clipping against it before
  // the first layout would be wrong, so the view stays unmeasured until then.
  const laidOut = signal(false);
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

  /** The world rectangle on screen; cards and connectors cull against it. */
  const view = computed(
    () => {
      if (!laidOut()) return null;
      const size = props.stage();
      if (size.width <= 0 || size.height <= 0) return null;
      return props.camera.visibleBounds(size);
    },
    { equals: sameBounds },
  );

  /**
   * The marquee's covered cards in sweep order. A covered card draws at the
   * rank it will hold once the release writes the selection, so the preview
   * and the settled state share one stacking.
   */
  const previewRanks = computed(() => {
    const ranks = new Map<string, number>();
    let rank = 1;
    for (const id of props.controller.marqueePreview()) {
      ranks.set(id, rank);
      rank += 1;
    }
    return ranks;
  });

  /**
   * Selection pins every selected card in the scene, because the group frame
   * and its connectors need the rectangle even off screen. At a high zoom
   * most of a box-selected board is outside the viewport, so those cards are
   * made transparent: NSH skips their whole paint subtree at zero opacity,
   * and the clip would discard it anyway.
   */
  const cardVisible = (id: string): boolean => {
    const shown = view();
    if (shown === null) return true;
    const rect = props.scene.cardRect(id);
    return rect !== null && cardInView(rect, shown);
  };

  /** The cards with an edge on either side; one set per edge change. */
  const connectedCards = computed(() => {
    const ids = new Set<string>();
    for (const edge of props.scene.edges()) {
      ids.add(edge.fromId);
      ids.add(edge.toId);
    }
    return ids;
  });

  // The hover and preview mirrors are per-id signals; drop the ones for
  // cards the scene no longer holds, so their map tracks the document rather
  // than every card a session ever saw.
  effect(() => {
    const live = new Set(props.scene.nodes().map((node) => node.id));
    props.controller.flags.retain(live);
  });

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
    // a hover (and the port it holds) must not stay behind after it leaves.
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
      onLayout={(event) => {
        props.onSize({ width: event.bounds.size.width, height: event.bounds.size.height });
        if (!laidOut()) laidOut.set(true);
      }}
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
          visible={view}
          previewed={() => props.controller.marqueePreview()}
        />
        {/* The frame draws above the selected cards so its wash covers the
            whole swept group; its group ports stay above it. */}
        <SelectionFrame scene={props.scene} camera={props.camera} controller={props.controller} />
        <Each of={props.scene.nodes()} key={(node) => node.id}>
          {(node) => {
            // The id and kind never change for a row. Reading them once keeps
            // the card's signals from all depending on the node accessor: a
            // viewport refresh replaces the node record, and a card whose
            // bindings read that record would be rebuilt on every refresh.
            const id = node().id;
            const kind = node().kind;
            return (
              <FlowCard
                node={node}
                nodeId={id}
                kind={kind}
                rect={() => props.scene.cardRect(id)}
                zIndex={() => {
                  // Only covered cards read the preview's ranks; every other
                  // card keeps its document depth and stays asleep.
                  if (!props.controller.flags.isPreviewed(id)) return props.scene.cardZ(id);
                  return props.scene.cardZ(id, previewRanks().get(id));
                }}
                preview={() => props.scene.previews().get(id) ?? null}
                selected={() => props.scene.isSelectedKeyed(id)}
                previewed={() => props.controller.flags.isPreviewed(id)}
                framed={() => props.controller.multiFrame() && props.scene.isSelectedKeyed(id)}
                hovered={() => props.controller.flags.isHovered(id)}
                hoveredPort={() => props.controller.hoveredPort()}
                hoveredPortKey={() => props.controller.hoveredPortKey()}
                connected={() => connectedCards().has(id)}
                zoom={() => props.camera.scaleView()}
                target={() => props.scene.isConnectionTarget(id)}
                visible={() => cardVisible(id)}
                imageEvent={props.imageEvent}
              />
            );
          }}
        </Each>
        <SelectionPorts scene={props.scene} camera={props.camera} controller={props.controller} />
        <If when={props.scene.connectionPreviews()}>
          {(previews) => <FlowPreviews previews={previews} zIndex={props.scene.previewZ()} />}
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
        onWheel={(event) => {
          const notches = wheelNotches(event.delta.y, event.deltaMode, platform.os);
          if (notches !== 0) {
            props.onWheelZoom(notches, event.position.x, event.position.y);
          }
        }}
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
      <PortTooltip
        scene={props.scene}
        camera={props.camera}
        controller={props.controller}
        stage={props.stage}
      />
    </View>
  );
}
