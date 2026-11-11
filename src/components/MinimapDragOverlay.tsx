/**
 * A full-canvas capture surface during a minimap drag: the pointer may leave
 * the small panel, so its moves must keep reaching the drag.
 */
import { View, type MouseButtonEvent, type MouseEvent as NshMouseEvent } from "nsh";
import type { MinimapController } from "../flow/minimap-controller";
import { WheelSurface } from "./wheel-surface";

export interface MinimapDragOverlayProps {
  readonly controller: MinimapController;
  /** The wheel over the surface while a drag runs. */
  readonly onZoom: (notches: number) => void;
}

export function MinimapDragOverlay(props: MinimapDragOverlayProps) {
  const onMove = (event: NshMouseEvent): void => {
    // A button-less move after a press means the button was released, which
    // may have happened outside the window. Touch drags end through the
    // minimap's touch responder, which owns the finger.
    if (event.pressedButton === null) {
      props.controller.end();
      return;
    }
    props.controller.move(event.pagePosition);
  };

  const onUp = (event: MouseButtonEvent): void => {
    if (event.button !== "left" || !props.controller.dragging()) return;
    // The last move may lag the release by a frame: apply the release point.
    props.controller.move(event.pagePosition);
    props.controller.end();
  };

  return (
    <View
      testID="flow-minimap-drag"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "transparent",
        cursor: "grabbing",
      }}
      onMouseMove={onMove}
      onMouseUp={onUp}
    >
      <WheelSurface
        testID="flow-minimap-drag-wheel"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          backgroundColor: "transparent",
        }}
        onWheel={(event) => props.onZoom(event.notchesY)}
      />
    </View>
  );
}
