/**
 * The merged plus buttons on a multi-card selection frame: the left one is
 * the group's input handle, the right one its output handle. They rest on the
 * frame's side middle, follow the pointer in its side zone, and start a group
 * connection on press. Their views are never pressed: the controller reads
 * the frame's side zones.
 */
import { View } from "nsh";
import type { CanvasCamera } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import { type BoxGeometry, type Point, type PortSide, portButtonPoint } from "../flow/connection";
import type { FlowScene } from "../flow/scene";
import { SELECTION_FRAME_PADDING } from "../flow/selection";
import { PortPlus } from "./PortPlus";

export interface SelectionPlusesProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
}

export function SelectionPluses(props: SelectionPlusesProps) {
  const frame = (): BoxGeometry | null => {
    if (!props.controller.multiFrame()) return null;
    const bounds = props.scene.selectionBounds();
    if (!bounds) return null;
    const padding = SELECTION_FRAME_PADDING / props.camera.scaleView();
    return {
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    };
  };
  const follow = (side: PortSide): Point | null => {
    const plus = props.controller.framePlus();
    return plus !== null && plus.side === side ? plus.point : null;
  };

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: props.scene.framePlusZ(),
      }}
    >
      <If when={frame()}>
        {(box) => (
          <PortPlus
            accent="chart-1"
            base={() => portButtonPoint(box(), "in")}
            follow={() => follow("in")}
          />
        )}
      </If>
      <If when={frame()}>
        {(box) => (
          <PortPlus
            accent="chart-1"
            base={() => portButtonPoint(box(), "out")}
            follow={() => follow("out")}
          />
        )}
      </If>
    </View>
  );
}
