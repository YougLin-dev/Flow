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
import type { FlowScene } from "../flow/scene";
import { SELECTION_FRAME_PADDING } from "../flow/selection";

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
          style={{
            // The frame rides the world's scale: its padding and border are
            // divided by the camera's scale to stay one screen point wide.
            left: box().x - SELECTION_FRAME_PADDING / props.camera.scale,
            top: box().y - SELECTION_FRAME_PADDING / props.camera.scale,
            width: box().width + (SELECTION_FRAME_PADDING * 2) / props.camera.scale,
            height: box().height + (SELECTION_FRAME_PADDING * 2) / props.camera.scale,
            borderWidth: 1 / props.camera.scale,
            zIndex: props.scene.frameZ(),
          }}
        >
          <View class="absolute left-0 top-0 h-full w-full bg-chart-1 opacity-10" />
        </View>
      )}
    </If>
  );
}
