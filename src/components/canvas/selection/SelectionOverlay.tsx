/**
 * The marquee box, drawn in screen space above the cards: its neutral outline
 * and wash stay on top of the swept content. A selected card draws its own
 * ring outside the card, so this draws no card outline of its own; resize
 * handles are invisible hit targets in the controller.
 */
import { View } from "nsh";
import type { CanvasController } from "../../../flow/canvas/interaction/canvas-controller";
import { SELECTION_OUTLINE, SELECTION_WASH } from "./selection-visuals";

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
            class={SELECTION_OUTLINE}
            style={{
              left: box().x,
              top: box().y,
              width: box().width,
              height: box().height,
            }}
          >
            <View class={SELECTION_WASH} />
          </View>
        )}
      </If>
    </View>
  );
}
