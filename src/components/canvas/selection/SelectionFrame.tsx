/**
 * The frame around a marquee's multi-card selection, drawn with the world
 * above the selected cards so its neutral outline and wash cover the whole
 * swept group; its group ports and a pulled connector stay above it. The wash
 * marks the region over the cards and the space between them. A press
 * anywhere inside the frame drags the whole selection; a press outside it
 * starts over. A marquee that ends with one card shows no frame: that card is
 * a normal selection.
 */
import { View } from "nsh";
import type { CanvasController } from "../../../flow/canvas/interaction/canvas-controller";
import type { CanvasCamera, FlowScene } from "../../../flow/canvas";
import { selectionFrame } from "../../../flow/canvas/interaction/frame-surface";
import type { BoxGeometry } from "../../../flow/shared";
import { SELECTION_OUTLINE, SELECTION_WASH } from "./selection-visuals";

export interface SelectionFrameProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
}

export function SelectionFrame(props: SelectionFrameProps) {
  return (
    <If when={props.controller.multiFrame() ? props.scene.selectionBounds() : null}>
      {(box) => (
        <View
          testID="selection-frame"
          class={SELECTION_OUTLINE}
          style={frameStyle(box(), props.camera.scaleView(), props.scene.frameZ())}
        >
          <View class={SELECTION_WASH} />
        </View>
      )}
    </If>
  );
}

/** The frame's world rect and its one-screen-point border, from the same
 * padded rectangle the frame's hit testing uses. */
function frameStyle(
  bounds: BoxGeometry,
  scale: number,
  zIndex: number,
): {
  left: number;
  top: number;
  width: number;
  height: number;
  borderWidth: number;
  zIndex: number;
} {
  const frame = selectionFrame(bounds, scale);
  return {
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
    borderWidth: 1 / scale,
    zIndex,
  };
}
