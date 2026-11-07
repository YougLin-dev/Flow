import { Button } from "nsh/base";
import { colorScheme, Image, Text, View } from "nsh";
import { titleBar } from "nsh/desktop";
import { TITLEBAR_HEIGHT } from "../lib/window-chrome";
import appIcon from "../assets/icons/32x32.png";
import pinLight from "../assets/pin-light.png";
import pinDark from "../assets/pin-dark.png";
import pinActive from "../assets/pin-active.png";

export interface TitleBarProps {
  /** Whether the window stays above the others. */
  pinned: boolean;
  /** The user asked to pin or unpin the window. */
  onTogglePinned: () => void;
}

/**
 * The app-drawn title bar. The system keeps its window controls (traffic
 * lights on macOS, caption buttons on Windows and GTK); `titleBar()` reports
 * the room they take so nothing is laid out underneath them. The bar drags
 * the window, and its pin button keeps the window above the others.
 */
export function TitleBar(props: TitleBarProps) {
  return (
    <View
      desktop={{ windowDrag: true }}
      class="shrink-0 flex-row items-center border-b border-border bg-card"
      style={{
        height: titleBar().height || TITLEBAR_HEIGHT,
        paddingLeft: titleBar().left + 8,
        // Where the system controls are on the right (Windows, GTK), the pin
        // lane ends exactly where they begin, so it reads as part of them. On
        // macOS they are on the left, and the bar keeps its usual margin.
        paddingRight: titleBar().right || 8,
      }}
    >
      <Image src={appIcon} style={{ width: 18, height: 18 }} />
      <Text class="ml-2 text-sm font-semibold text-card-foreground">Flow</Text>
      <Text class="ml-2 text-xs text-muted-foreground">Leafer engine · NSH</Text>
      <View class="flex-1" />
      <Button
        accessibilityLabel={props.pinned ? "Unpin window" : "Pin window on top"}
        selected={props.pinned}
        onPress={() => props.onTogglePinned()}
        class="items-center justify-center hover:bg-titlebar-hover active:bg-titlebar-active"
        classList={{ "bg-titlebar-pinned": props.pinned }}
        // 46 points is the width of one Windows caption button, so the pin
        // lane reads as part of the system controls.
        style={{ width: 46, height: "100%" }}
      >
        <Image
          src={props.pinned ? pinActive : colorScheme() === "dark" ? pinLight : pinDark}
          style={{ width: 15, height: 13, objectFit: "contain", objectPosition: "center" }}
        />
      </Button>
    </View>
  );
}
