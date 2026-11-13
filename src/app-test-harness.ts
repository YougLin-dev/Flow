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
