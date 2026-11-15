/**
 * The 100k real-host smoke, driven by `scripts/smoke-100k.mjs` after it seeds
 * the fixture and points `FLOW_DB_PATH` at it. Every other run skips it: the
 * gate is the bench database path, so `bun run test` and `bun run test:host`
 * open no 100k package.
 *
 * It checks the interaction path a user takes on a large board: pan, zoom,
 * search a far card, reveal it, then Fit and zoom again. The probes are the
 * app's own (`flowZoomProbe`/`flowSelectionProbe`), so the waits read state,
 * not painted text.
 */
import { expect, test, type App } from "nsh/test";
import { openApp, percentOf, selectedOf } from "./test-support/app";

const isBenchRun = (): boolean => (process.env.FLOW_DB_PATH ?? "").includes("flow-100k");

/** Presses a key `count` times, each landing before the next. */
const pressRepeatedly = async (app: App, key: string, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- input events are ordered
    await app.keyboard.press(key);
  }
};

test("the 100k fixture pans, zooms, searches, reveals and fits", async () => {
  if (!isBenchRun()) return;
  const app = await openApp({ width: 1280, height: 900 });
  await app.waitUntil(() => percentOf(app) > 0, { timeout: 60_000 });

  await pressRepeatedly(app, "right", 8);
  await pressRepeatedly(app, "up", 3);

  const before = percentOf(app);
  await app.keyboard.press("mod+=");
  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app) > before, { timeout: 30_000 });

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"), { timeout: 30_000 });
  await app.type("id:search-input", "Node 99999");
  await app.waitUntil(() => app.shows("id:search-result-n99999"), { timeout: 60_000 });
  // Enter opens the active result: the host can lose the palette's first
  // synthetic pointer press in a window taller than the display.
  await app.submit("id:search-input");
  await app.waitUntil(() => selectedOf(app) === 1, { timeout: 60_000 });
  await app.screenshot(".nsh/bench/flow-100k-reveal.png");

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.shows("label:Fit"), { timeout: 30_000 });
  await app.press("label:Fit");
  await app.waitUntil(() => percentOf(app) === 5, { timeout: 60_000 });

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app) > 5, { timeout: 60_000 });
  await app.screenshot(".nsh/bench/flow-100k-overview.png");
  expect(percentOf(app)).toBeGreaterThan(5);
});
