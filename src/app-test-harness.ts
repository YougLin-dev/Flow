/**
 * The shared host for the app-level tests: open the entry with the probes
 * tests read the camera and selection from, then select a seed card through
 * search.
 */
import { type App, open, type OpenOptions } from "nsh/test";

/** Opens the app with the probes a test reads the camera and selection from. */
export const openApp = (options: OpenOptions = {}): Promise<App> =>
  open("./App.tsx", {
    ...options,
    host: {
      ...options.host,
      params: { ...options.host?.params, flowZoomProbe: 1, flowSelectionProbe: 1 },
    },
  });

/** The zoom probe's camera scale, in whole percent. */
export const percentOf = (app: App): number => {
  const value = app.value("id:zoom-probe");
  return value ? Number(value) : Number.NaN;
};

/** The selection probe's state. */
export const canvasState = (app: App): { selected: number; composing: boolean } => {
  const [selected = "0", composing = "0"] = (app.value("id:canvas-probe") ?? "").split(";");
  return { selected: Number(selected), composing: composing === "1" };
};

export const selectedOf = (app: App): number => canvasState(app).selected;

/** Opens the composer of a seed node through search. */
export const selectSeed = async (app: App, query: string, testId: string): Promise<void> => {
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", query);
  await app.waitUntil(() => app.shows(testId));
  await app.press(testId);
};

/** Centres a seed card through search, then opens its own context menu. */
export const openNodeMenu = async (app: App, query: string, testId: string): Promise<void> => {
  await selectSeed(app, query, testId);
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  // The reveal centres the card, so the canvas's middle presses it.
  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));
};

/** A 1×1 transparent PNG, so the headless picker reads a real size. */
export const PNG_1X1 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133,
  1, 128, 132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
