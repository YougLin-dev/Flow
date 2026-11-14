/**
 * The typed group ports of a multi-card selection frame: one per distinct
 * input type on its left and one per distinct output type on its right.
 * They are static handles on the frame; the controller reads their hit
 * zones, so the views themselves are never pressed.
 */
import { computed, View } from "nsh";
import type { CanvasController } from "../flow/canvas/interaction/canvas-controller";
import { groupPorts, type CanvasCamera, type FlowScene, type GroupPort } from "../flow/canvas";
import { selectionFrame } from "../flow/canvas/interaction/frame-surface";
import type { InputPort, OutputPort } from "../flow/nodes";
import type { BoxGeometry } from "../flow/shared";
import { portVisual } from "./canvas/port-visuals";
import { Port } from "./canvas/world/Port";

export interface SelectionPortsProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
}

export function SelectionPorts(props: SelectionPortsProps) {
  const frame = (): BoxGeometry | null => {
    if (!props.controller.multiFrame()) return null;
    const bounds = props.scene.selectionBounds();
    if (!bounds) return null;
    return selectionFrame(bounds, props.camera.scaleView());
  };
  // The list follows the selection and its connectors, so a removed card or
  // a newly full input retires or dims its group port.
  const ports = computed((): readonly GroupPort[] => {
    const box = frame();
    return box === null ? [] : groupPorts(props.scene, box);
  });

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: props.scene.selectionPortsZ(),
      }}
    >
      <Each of={ports()} key={(group) => `${group.side}-${group.portKind}`}>
        {(group) => (
          <Port
            port={descriptor(group())}
            center={() => group().center}
            enabled={() => group().enabled}
            follow={() => {
              const current = group();
              if (
                props.controller.hoveredGroupKey() !== `${current.side}\u0000${current.portKind}`
              ) {
                return null;
              }
              const hover = props.controller.hoveredGroup();
              return hover !== null &&
                hover.side === current.side &&
                hover.portKind === current.portKind
                ? hover.point
                : null;
            }}
          />
        )}
      </Each>
    </View>
  );
}

/** The schema-like descriptor a group port renders through `Port`. */
function descriptor(group: GroupPort): InputPort | OutputPort {
  const label = portVisual(group.portKind).label;
  const name = group.side === "in" ? `${label} inputs` : `${label} outputs`;
  return group.side === "in"
    ? { id: group.portKind, name, kind: group.portKind, capacity: group.remaining }
    : { id: group.portKind, name, kind: group.portKind };
}
