import { Button } from "nsh/base";
import { colorScheme, Image, platform, Text, View } from "nsh";
import { currentWindow, titleBar } from "nsh/desktop";
import appIcon from "../assets/icons/32x32.png";
import pinLight from "../assets/pin-light.png";
import pinDark from "../assets/pin-dark.png";
import pinActive from "../assets/pin-active.png";

/**
 * The app bar's height when the platform reports none: `nsh.json`'s
 * `window.titleBar.height` gives the real one, close to the system caption's.
 */
const TITLEBAR_HEIGHT = 32;

export interface TitleBarProps {
  /** Whether the window stays above the others. */
  pinned: boolean;
  /** The user asked to pin or unpin the window. */
  onTogglePinned: () => void;
}

/**
 * The app-drawn title bar. `nsh.json` hides the system bar before the first
 * frame; the system keeps its window controls (traffic lights on macOS,
 * caption buttons on Windows and GTK), and `titleBar()` reports the room they
 * take so nothing is laid out underneath them. The bar drags the window, and
 * its pin button keeps the window above the others.
 */
export function TitleBar(props: TitleBarProps) {
  // NSH sets a window level on macOS and Windows, not on Linux; do not offer
  // a control whose state the window manager would not honor.
  const pinnable = platform.os !== "linux";
  // One reactive read: `titleBar()` reports the app's bar while it is hidden.
  const area = titleBar();
  if (pinnable) {
    // The window API only answers while rendering; the core sends the level
    // once and again only when it changes.
    currentWindow().set({ level: props.pinned ? "floating" : "normal" });
  }
  return (
    <View
      testID="title-bar"
      desktop={{ windowDrag: true }}
      class="shrink-0 flex-row items-center border-b border-border bg-card"
      style={{
        height: area.height || TITLEBAR_HEIGHT,
        paddingLeft: area.left + 8,
        // Where the system controls are on the right (Windows, GTK), the pin
        // lane ends exactly where they begin, so it reads as part of them. On
        // macOS they are on the left, and the bar keeps its usual margin.
        paddingRight: area.right || 8,
      }}
    >
      <View class="min-w-0 flex-1 flex-row items-center overflow-hidden">
        <Image class="shrink-0" src={appIcon} style={{ width: 18, height: 18 }} />
        <Text class="ml-2 shrink-0 text-sm font-semibold text-card-foreground">Flow</Text>
        <Text
          class="ml-2 min-w-0 text-xs text-muted-foreground"
          style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
        >
          Native canvas · NSH
        </Text>
      </View>
      {pinnable && (
        <Button
          accessibilityLabel={props.pinned ? "Unpin window" : "Pin window on top"}
          selected={props.pinned}
          onPress={() => props.onTogglePinned()}
          class="items-center justify-center hover:bg-titlebar-hover active:bg-titlebar-active focus:bg-accent"
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
      )}
    </View>
  );
}
