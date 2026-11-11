import { platform, signal } from "nsh";
import { isAvailable } from "nsh/desktop";
import { mainWindow } from "./lib/window-chrome";

// The app's workspace state stays private: pages read it through the
// functions below and change it through their actions.
const zoom = signal<number | null>(null);
const selected = signal(0);
const pinned = signal(false);

/** The camera's scale in percent, or null before the first fit. */
export const zoomPercent = (): number | null => zoom();

/** How many cards are selected in the canvas. */
export const selectedCount = (): number => selected();

/** Whether the window is kept above normal windows. */
export const isPinned = (): boolean => pinned();

/** Publishes the camera's scale to the zoom label. */
export function setZoomPercent(value: number): void {
  zoom.set(value);
}

/** Publishes how many cards the canvas has selected. */
export function setSelectedCount(value: number): void {
  selected.set(value);
}

/** Keeps the window above normal windows, or lets it back down. */
export function togglePinned(): void {
  // NSH sets a window level on macOS and Windows only.
  if (!isAvailable || platform.os === "linux") return;
  const next = !pinned();
  pinned.set(next);
  mainWindow()?.set({ level: next ? "floating" : "normal" });
}
