/**
 * The frame around a marquee's multi-card selection, drawn with the world so
 * it shares its stacking: above the unselected cards and below the selected
 * ones, the whole swept area reads as one group. The fill marks the region
 * without tinting the selected cards. A press anywhere inside the frame
 * drags the whole selection; a press outside it starts over. A marquee that
 * ends with one card shows no frame: that card is a normal selection.
 */
import { View } from "nsh";
import type { CanvasCamera } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import type { BoxGeometry } from "../flow/connection";
import { selectionFrame } from "../flow/frame-surface";
import type { FlowScene } from "../flow/scene";

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
          class="absolute border border-chart-1"
          style={frameStyle(box(), props.camera.scaleView(), props.scene.frameZ())}
        >
          <View class="absolute left-0 top-0 h-full w-full bg-chart-1 opacity-10" />
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
