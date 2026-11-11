//! The canvas's wheel sensor: an invisible native component whose container
//! is the canvas's pointer surface. NSH hands its `wheel` callback the mouse
//! wheel and touchpad scrolls; it sends them to TSX, which zooms the camera.

use nsh_platform_windows::{ComponentContext, NativeComponent, Wheel};
use serde_json::json;

/// The component registered as `flow.wheel-surface`.
pub struct WheelSurface {
    context: ComponentContext,
}

impl WheelSurface {
    pub fn new(context: ComponentContext) -> Self {
        Self { context }
    }
}

impl NativeComponent for WheelSurface {
    fn set_prop(&mut self, _name: &str, _value: Option<&serde_json::Value>) {}

    fn wheel(&mut self, event: &Wheel) -> bool {
        if event.notches_y == 0.0 {
            return false;
        }
        self.context.emit(
            "flowWheel",
            json!({ "x": event.x, "y": event.y, "notchesY": event.notches_y }),
        );
        true
    }
}
