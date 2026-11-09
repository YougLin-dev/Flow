/**
 * The marquee box, drawn in screen space. A selected card shows the same
 * rounded accent border it shows on hover, so this draws no card outline of
 * its own; resize handles are invisible hit targets in the controller.
 */
import { View } from "nsh";
import type { CanvasController } from "../flow/canvas-controller";

export interface SelectionOverlayProps {
  readonly controller: CanvasController;
}

export function SelectionOverlay(props: SelectionOverlayProps) {
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <If when={props.controller.marquee()}>
        {(box) => (
          <View
            class="absolute border border-chart-1"
            style={{
              left: box().x,
              top: box().y,
              width: box().width,
              height: box().height,
            }}
          >
            <View class="absolute left-0 top-0 h-full w-full bg-chart-1 opacity-10" />
          </View>
        )}
      </If>
    </View>
  );
}
