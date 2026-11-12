/**
 * A full-canvas capture surface during a minimap drag: the pointer may leave
 * the small panel, so its moves must keep reaching the drag.
 */
import { platform, View, type MouseEvent as NshMouseEvent } from "nsh";
import { wheelNotches } from "../flow/camera";
import type { MinimapController } from "../flow/minimap-controller";

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

  const onUp = (event: NshMouseEvent): void => {
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
      onWheel={(event) => {
        const notches = wheelNotches(event.delta.y, event.deltaMode, platform.os);
        if (notches !== 0) props.onZoom(notches);
      }}
    />
  );
}
