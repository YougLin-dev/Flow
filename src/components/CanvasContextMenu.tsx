/**
 * The canvas context menu: a native popup opened by a secondary-button press.
 * Its backdrop closes it on a primary press; a right drag on the same overlay
 * is forwarded to the page, which drops the menu and pans the canvas.
 */
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { CONTEXT_MENU_WIDTH } from "../flow/context-menu";

export interface CanvasContextMenuProps {
  readonly left: number;
  readonly top: number;
  readonly onClose: () => void;
  readonly onAddText: () => void;
  readonly onAddImage: () => void;
  /** A mouse move with a button held (the page may start a pan). */
  readonly onMove: (x: number, y: number, held: boolean) => void;
  /** A secondary press on the open menu re-anchors it, in overlay points. */
  readonly onPress: (x: number, y: number) => void;
  /** A mouse button was released over the overlay (only a tracked secondary
   * press acts). */
  readonly onRelease: () => void;
}

export function CanvasContextMenu(props: CanvasContextMenuProps) {
  return (
    <View
      class="absolute z-50"
      style={{ left: 0, top: 0, width: "100%", height: "100%" }}
      onMouseMove={(event) =>
        props.onMove(event.position.x, event.position.y, event.pressedButton !== null)
      }
      // The controller only releases a secondary press it tracks, so any
      // button's release is reported: a macOS Control-click releases left.
      onMouseUp={() => props.onRelease()}
      onContextMenu={(event) => props.onPress(event.position.x, event.position.y)}
    >
      <View
        testID="canvas-menu-backdrop"
        focusable={false}
        style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
        onPressDown={props.onClose}
      />
      <View
        testID="canvas-menu"
        accessibilityLabel="Canvas menu"
        class="absolute gap-0.5 rounded-(--radius) border border-border bg-popover p-1 shadow-lg"
        style={{ left: props.left, top: props.top, width: CONTEXT_MENU_WIDTH }}
        onPressDown={() => undefined}
      >
        <Button
          testID="context-add-text"
          onPress={props.onAddText}
          class="w-full rounded-md px-2 py-1.5 active:bg-accent focus:bg-accent hover:bg-muted"
        >
          <Text class="text-sm text-popover-foreground">Add text node</Text>
        </Button>
        <Button
          testID="context-add-image"
          onPress={props.onAddImage}
          class="w-full rounded-md px-2 py-1.5 active:bg-accent focus:bg-accent hover:bg-muted"
        >
          <Text class="text-sm text-popover-foreground">Add image node</Text>
        </Button>
      </View>
    </View>
  );
}
