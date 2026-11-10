import { currentWindow, isAvailable, type WindowRef } from "nsh/desktop";

/** The height of the app-drawn title bar, in points. */
export const TITLEBAR_HEIGHT = 40;

/** The main window, kept from the render that installed the chrome. */
let main: WindowRef | null = null;

/**
 * Hides the system title bar once, while the app renders: `currentWindow()`
 * only works there. The system keeps its window controls; the app draws the
 * rest of the bar.
 *
 * Mobile and the web have no desktop window, so there is nothing to install.
 */
export function installWindowChrome(): void {
  if (!isAvailable) return;
  main = currentWindow();
  main.set({ titleBar: { style: "hidden", height: TITLEBAR_HEIGHT } });
}

/**
 * The main window the app drew its title bar in, or null off the desktops
 * and before the first render. A window of its own can change its level
 * outside a render through this ref.
 */
export function mainWindow(): WindowRef | null {
  return main;
}
