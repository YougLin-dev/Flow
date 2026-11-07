import { isAvailable, Window } from "nsh/desktop";

/** The height of the app-drawn title bar, in points. */
export const TITLEBAR_HEIGHT = 40;

/**
 * Hides the system title bar once, before the first frame. The system keeps
 * its window controls; the app draws the rest of the bar.
 *
 * Mobile and the web have no desktop window, so there is nothing to install.
 */
export function installWindowChrome(): void {
  if (!isAvailable) return;
  Window.setTitleBar({ style: "hidden", height: TITLEBAR_HEIGHT });
}
