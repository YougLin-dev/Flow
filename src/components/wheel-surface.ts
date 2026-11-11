/** The canvas's wheel sensor, registered by the Rust crate (`wheel_surface.rs`). */
import { nativeComponent } from "nsh";

export interface FlowWheelEvent {
  readonly x: number;
  readonly y: number;
  readonly notchesY: number;
}

interface WheelProps {
  /** The sensor takes no props of its own. */
  readonly noProps?: never;
}

/**
 * A native component that draws nothing and takes no pointer: presses reach
 * the view's handlers as on any view, and NSH hands it the mouse wheel and
 * touchpad scrolls over it. Where the component is not registered (the
 * headless engine), it renders an empty view and the pointer handlers still
 * work.
 */
export const WheelSurface = nativeComponent<WheelProps, { flowWheel: FlowWheelEvent }>(
  "flow.wheel-surface",
  {
    props: [],
    events: ["flowWheel"],
  },
);
