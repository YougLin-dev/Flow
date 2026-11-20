import { Button } from "nsh/base";
import { colorScheme, computed, Image, platform, signal, Text, View } from "nsh";
import {
  currentWindow,
  isAvailable,
  Menu as DesktopMenu,
  titleBar,
  type MenuItem,
  type TitleBarArea,
} from "nsh/desktop";
import appIcon from "../../assets/icons/32x32.png";
import pinLight from "../../assets/pin-light.png";
import pinDark from "../../assets/pin-dark.png";
import pinActive from "../../assets/pin-active.png";

/**
 * The app bar's height when the platform reports none: `nsh.json`'s
 * `window.titleBar.height` gives the real one, close to the system caption's.
 */
const TITLEBAR_HEIGHT = 32;

export interface TitleBarProps {
  /** The open project's name; absent on the projects screen and legacy path. */
  title?: (() => string | undefined) | undefined;
  /** Shows the Projects window, when the app has a managed root. */
  onOpenProjects?: (() => void) | undefined;
  /** Creates a project from anywhere in the app. */
  onNewProject?: (() => void) | undefined;
  /** Shows the Settings window. */
  onOpenSettings?: (() => void) | undefined;
}

/**
 * The app-drawn title bar, one per window. `nsh.json` hides the system bar
 * before the first frame; the system keeps its window controls (traffic
 * lights on macOS, caption buttons on Windows and GTK), and `titleBar()`
 * reports the room they take so nothing is laid out underneath them. The bar
 * drags the window, its pin button keeps that window above the others, and
 * its `⋯` opens the app's small menu.
 */
export function TitleBar(props: TitleBarProps) {
  // Per window, as the level it sets is: one project's pin does not lift
  // another's window.
  const pinned = signal(false);
  // NSH sets a window level on macOS and Windows, not on Linux; do not offer
  // a control whose state the window manager would not honor.
  const pinnable = platform.os !== "linux";
  // Off the desktops (a phone, the web page) `<Window>` degrades to its
  // content in the one surface; there is no window to ask about.
  const win = isAvailable ? currentWindow() : null;
  // A component body reads a signal once (a bar made before the platform
  // reported the area would keep its first value), so the read is a
  // `computed` that the style below reads: it reports the app's bar while
  // it is hidden, and the style follows it, full screen included.
  const area = computed<TitleBarArea>(() =>
    win ? titleBar() : { height: TITLEBAR_HEIGHT, left: 0, right: 0 },
  );
  // The window API only answers while rendering; the core sends the level
  // once and again only when it changes.
  win?.set({ level: pinned() ? "floating" : "normal" });

  const togglePinned = (): void => {
    if (!pinnable) return;
    const next = !pinned();
    pinned.set(next);
    win?.set({ level: next ? "floating" : "normal" });
  };

  const openMenu = (): void => {
    const items: MenuItem[] = [];
    if (props.onNewProject) {
      items.push({
        label: "New Project…",
        shortcut: "mod+n",
        onSelect: props.onNewProject,
      });
    }
    if (props.onOpenProjects) {
      items.push({
        label: "Open Projects",
        shortcut: "mod+shift+o",
        onSelect: props.onOpenProjects,
      });
    }
    if (props.onOpenSettings) {
      items.push({ label: "Settings…", shortcut: "mod+,", onSelect: props.onOpenSettings });
    }
    items.push({ type: "separator" }, { role: "quit" });
    void DesktopMenu.popup(items);
  };

  return (
    <View
      testID="title-bar"
      desktop={{ windowDrag: true }}
      class="shrink-0 flex-row items-center border-b border-border bg-card"
      style={{
        height: area().height || TITLEBAR_HEIGHT,
        paddingLeft: area().left + 8,
        // Where the system controls are on the right (Windows, GTK), the
        // controls lane ends exactly where they begin, so it reads as part of
        // them. On macOS they are on the left, and the bar keeps its usual
        // margin.
        paddingRight: area().right || 8,
      }}
    >
      <View class="min-w-0 flex-1 flex-row items-center overflow-hidden">
        <Image class="shrink-0" src={appIcon} style={{ width: 18, height: 18 }} />
        <Text class="ml-2 shrink-0 text-sm font-semibold text-card-foreground">Flow</Text>
        <Text
          class="ml-2 min-w-0 text-xs text-muted-foreground"
          style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
        >
          {props.title?.() ?? "Native canvas · NSH"}
        </Text>
      </View>
      {pinnable && (
        <Button
          testID="pin-window"
          accessibilityLabel={pinned() ? "Unpin window" : "Pin window on top"}
          selected={pinned()}
          onPress={togglePinned}
          class="items-center justify-center hover:bg-titlebar-hover active:bg-titlebar-active focus-visible:bg-accent"
          classList={{ "bg-titlebar-pinned": pinned() }}
          // 46 points is the width of one Windows caption button, so the pin
          // lane reads as part of the system controls.
          style={{ width: 46, height: "100%" }}
        >
          <Image
            src={pinned() ? pinActive : colorScheme() === "dark" ? pinLight : pinDark}
            style={{ width: 15, height: 13, objectFit: "contain", objectPosition: "center" }}
          />
        </Button>
      )}
      <Button
        testID="window-menu"
        accessibilityLabel="Window menu"
        onPress={openMenu}
        class="items-center justify-center hover:bg-titlebar-hover active:bg-titlebar-active focus-visible:bg-accent"
        style={{ width: 46, height: "100%" }}
      >
        <Text class="text-base text-card-foreground">⋯</Text>
      </Button>
    </View>
  );
}
