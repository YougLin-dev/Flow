/**
 * The minimap: the document's card silhouettes together with the camera's
 * current viewport, in the canvas' bottom-left corner. The panel always frames
 * the union of both, so a view pulled away from the content zooms the map out
 * rather than leaving it. Dragging anywhere in the panel pans the camera.
 */
import {
  computed,
  platform,
  View,
  type GestureResponderEvent,
  type PressEvent,
  type ViewStyle,
} from "nsh";
import type { Overview, OverviewCard } from "@flow/native";
import { type CanvasCamera, wheelNotches } from "../flow/camera";
import {
  minimapLayout,
  minimapRect,
  minimapViewport,
  sameBounds,
  sameLayout,
  unionBounds,
} from "../flow/minimap";
import type { MinimapController } from "../flow/minimap-controller";

const MINIMAP_WIDTH = 176;
const MINIMAP_HEIGHT = 120;
const MINIMAP_PADDING = 10;
/** Keeps a card visible when the whole document is far smaller than a point. */
const MIN_CARD_SIZE = 1.5;
/** The viewport outline is never smaller than its own corner radius. */
const MIN_VIEWPORT_SIZE = 4;

const SIZE = { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT };

export interface MiniMapProps {
  /** The whole document's bounds and card silhouettes; null until read. */
  readonly overview: () => Overview | null;
  readonly camera: CanvasCamera;
  readonly stage: () => { width: number; height: number };
  /** The drag that pans the camera; the page mounts its capture surface. */
  readonly drag: MinimapController;
  /** Whether a card is selected; its silhouette takes the accent. */
  readonly selected: (id: string) => boolean;
  /** Wheel notches over the panel; the page zooms about the view's center. */
  readonly onZoom: (notches: number) => void;
}

interface CardPoint {
  readonly x: number;
  readonly y: number;
}

export function MiniMap(props: MiniMapProps) {
  // The finger that began the drag: other fingers must not move or end it.
  let dragTouch: number | null = null;

  // The map's world region is the union of the content and the current view.
  // Bounds equality keeps a camera move inside the content from waking every
  // silhouette: only a union that actually changes rescales the map.
  const mapBounds = computed(
    () => {
      const current = props.overview();
      if (current === null) return null;
      return unionBounds(current.bounds, props.camera.visibleBounds(props.stage()));
    },
    { equals: sameBounds },
  );

  // One layout serves every silhouette, the viewport outline and a drag; the
  // value equality keeps an unchanged union from rebuilding them.
  const mapLayout = computed(
    () => {
      const bounds = mapBounds();
      return bounds === null ? null : minimapLayout(bounds, SIZE, MINIMAP_PADDING);
    },
    { equals: sameLayout },
  );

  const centerOfView = (): CardPoint => {
    const visible = props.camera.visibleBounds(props.stage());
    return { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
  };

  /** Remembers where the drag began; the viewport itself does not jump. */
  const beginDrag = (point: CardPoint, touch: number | null): void => {
    if (props.drag.dragging()) return;
    const layout = mapLayout();
    if (layout === null || !(layout.scale > 0)) return;
    dragTouch = touch;
    props.drag.start({ point, center: centerOfView(), scale: layout.scale });
  };

  const onDown = (event: PressEvent): void => {
    beginDrag(event.pagePosition, null);
  };

  // A mouse press over a view that listens to touches is also reported as a
  // touch (the platform's "reporting" pointer), so this may begin a mouse
  // drag too; the mouse moves and release then drive it through the overlay.
  const onTouchStart = (event: GestureResponderEvent): void => {
    beginDrag({ x: event.pageX, y: event.pageY }, event.identifier);
  };

  // Touches stay with the responder view, so they keep arriving here even
  // outside the panel. The event is about the finger that changed, which is
  // not necessarily `touches[0]`.
  const onTouchMove = (event: GestureResponderEvent): void => {
    if (!props.drag.dragging()) return;
    if (dragTouch !== null && event.identifier !== dragTouch) return;
    props.drag.move({ x: event.pageX, y: event.pageY });
  };

  const onTouchEnd = (event: GestureResponderEvent): void => {
    if (!props.drag.dragging()) return;
    if (dragTouch !== null && event.identifier !== dragTouch) return;
    // Apply the lift point: the last move may lag it by a frame.
    props.drag.move({ x: event.pageX, y: event.pageY });
    dragTouch = null;
    props.drag.end();
  };

  const onTouchCancel = (event: GestureResponderEvent): void => {
    if (!props.drag.dragging()) return;
    if (dragTouch !== null && event.identifier !== dragTouch) return;
    dragTouch = null;
    props.drag.end();
  };

  const cardStyle = (card: OverviewCard): ViewStyle => {
    const layout = mapLayout();
    if (layout === null) return {};
    const rect = minimapRect(card, layout, MIN_CARD_SIZE);
    return {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      // A selected card's silhouette sits above the others in the map, as
      // the card itself sits above them on the canvas.
      zIndex: props.selected(card.id) ? 1 : 0,
    };
  };

  const viewportStyle = (): ViewStyle => {
    const layout = mapLayout();
    if (layout === null) return { display: "none" };
    const visible = props.camera.visibleBounds(props.stage());
    const rect = minimapViewport(visible, layout, SIZE, MIN_VIEWPORT_SIZE);
    return {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      borderRadius: 3,
      // Above the selected silhouettes, so the viewport frame stays readable
      // across them.
      zIndex: 2,
    };
  };

  return (
    <View
      testID="flow-minimap"
      accessibilityLabel="Document minimap"
      // Above a card's composer (z-20) and inline editor (z-30): the dock it
      // sits in carries the z layer; a composer near this corner must not
      // bury it.
      class="overflow-hidden rounded-(--radius) border border-border bg-card"
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT, cursor: "grab" }}
      onPressDown={onDown}
      onWheel={(event) => {
        const notches = wheelNotches(event.delta.y, event.deltaMode, platform.os);
        if (notches !== 0) props.onZoom(notches);
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <If when={props.overview()}>
        {(overview) => (
          <>
            <Each of={overview().cards} key={(card) => card.id}>
              {(card) => (
                <View
                  classList={{
                    "absolute bg-minimap-card": !props.selected(card().id),
                    "absolute bg-foreground": props.selected(card().id),
                  }}
                  style={cardStyle(card())}
                />
              )}
            </Each>
            <View class="absolute border border-primary" style={viewportStyle()} />
          </>
        )}
      </If>
    </View>
  );
}
