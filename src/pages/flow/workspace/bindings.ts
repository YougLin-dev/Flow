import { keymap } from "nsh";
import { FIT_KEY, ZOOM_IN_KEY, ZOOM_OUT_KEY } from "../../../flow/shared";

export interface FlowKeyActions {
  readonly setZoom: (factor: number) => void;
  readonly fit: () => void;
  readonly deleteSelected: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly toggleSearch: () => void;
  readonly dismiss: () => void;
}

/** The canvas' global shortcuts. */
export function bindFlowKeys(actions: FlowKeyActions): void {
  keymap.bind({
    [ZOOM_IN_KEY]: () => actions.setZoom(1.2),
    [ZOOM_OUT_KEY]: () => actions.setZoom(1 / 1.2),
    [FIT_KEY]: actions.fit,
    backspace: actions.deleteSelected,
    delete: actions.deleteSelected,
    "mod+z": actions.undo,
    "mod+shift+z": actions.redo,
    "mod+y": actions.redo,
    up: () => actions.panBy(0, 40),
    down: () => actions.panBy(0, -40),
    left: () => actions.panBy(40, 0),
    right: () => actions.panBy(-40, 0),
  });
  keymap.bind("mod+k", actions.toggleSearch, { when: "always" });
  keymap.bind("escape", actions.dismiss, { when: "always" });
}
