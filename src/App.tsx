import { isAvailable } from "nsh/desktop";
import { mount, View } from "nsh";
import { TitleBar } from "./components/TitleBar";
import { installWindowChrome } from "./lib/window-chrome";
import { FlowPage } from "./pages/FlowPage";
import { isPinned, togglePinned } from "./store";

/**
 * Flow — an infinite canvas built with NSH's native view tree.
 *
 * The shell owns the window chrome and composes the page; the workspace and
 * its interactions live in `pages/FlowPage.tsx`, and its shared state in
 * `store.ts`.
 */
function App() {
  // `currentWindow()` only answers while the app renders.
  installWindowChrome();
  return (
    <View class="flex-1 bg-background">
      {isAvailable && <TitleBar pinned={isPinned()} onTogglePinned={togglePinned} />}
      <FlowPage />
    </View>
  );
}

mount(App);
