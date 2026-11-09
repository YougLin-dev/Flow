/** The selection border and resize handles, drawn in screen space. */
import { View } from "nsh";
import type { CanvasController } from "../flow/canvas-controller";
import type { FlowScene } from "../flow/scene";
import { selectionHandles } from "../flow/selection";

export interface SelectionOverlayProps {
  readonly scene: FlowScene;
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
      <Each of={props.scene.selection()} key={(id) => id}>
        {(id) => (
          <If when={props.controller.screenRect(id())}>
            {(rect) => (
              <View
                class="absolute border border-chart-1"
                style={{
                  left: rect().x,
                  top: rect().y,
                  width: rect().width,
                  height: rect().height,
                }}
              />
            )}
          </If>
        )}
      </Each>
      <If when={props.controller.selectionRect()}>
        {(rect) => (
          <Each of={selectionHandles(rect())} key={(handle) => handle.side}>
            {(handle) => (
              <View
                class="absolute rounded-full border border-chart-1 bg-card"
                style={{
                  left: handle().x - 4.5,
                  top: handle().y - 4.5,
                  width: 9,
                  height: 9,
                }}
              />
            )}
          </Each>
        )}
      </If>
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
