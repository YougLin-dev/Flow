/**
 * Platform tests: the window, native input, real rendering and desktop APIs.
 * These run headless in `bun run test` and on this machine's desktop host in
 * `bun run test:host`; every other test file is headless-only.
 */
import { type App, expect, open, test } from "nsh/test";

/** Opens the composer of a seed node through search. */
const selectSeed = async (app: App, query: string, testId: string): Promise<void> => {
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", query);
  await app.waitUntil(() => app.shows(testId));
  await app.press(testId);
};

/**
 * The composer always sits directly below its card and a revealed card is
 * centered, so its full sheet needs a stage taller than the default phone.
 */
const openTallApp = (): Promise<App> => open("./App.tsx", { width: 900, height: 1300 });

const percentOf = (texts: string[]): number => {
  const text = texts.find((value) => /^\d+%$/.test(value));
  return text ? Number(text.slice(0, -1)) : Number.NaN;
};

test("shows the flow canvas", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  expect(app.shows("id:flow-canvas")).toBe(true);
  const texts = app.texts();
  expect(texts).toContain("Flow");
  expect(texts).toContain("Native canvas · NSH");
  expect(texts).toContain("Fit");
});

test("box-selects a card", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  // Start off the connector that sits between the two cards: a press on it
  // selects the edge. A small pan leaves the box-select on empty canvas.
  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: 0, y: 20 });
  await app.keyboard.press("v");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("V to select")));

  await app.drag("id:flow-canvas", {
    x: -260 * scale,
    y: -100 * scale,
  });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);
  // The released marquee keeps a frame around the cards it selected.
  expect(app.shows("id:selection-frame")).toBe(true);
});

test("zooms with the platform modifier", async () => {
  // The headless default is Apple, where `mod` is Command; this is the
  // Windows/Linux Control mapping through the same binding.
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const fitted = percentOf(app.texts());

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app.texts()) > fitted);
  expect(percentOf(app.texts())).toBeGreaterThan(fitted);
});

test("searches cards and reveals the chosen one", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Move the flow off screen first: revealing the hit must pan back to it.
  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: 600, y: 0 });

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "Image");
  await app.waitUntil(() => app.shows("id:search-result-seed-image"));

  await app.press("id:search-filter-image");
  await app.waitUntil(() => app.shows("id:search-result-seed-image"));

  await app.press("id:search-result-seed-image");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.shows("id:search-input")).toBe(false);
});

test("shows the desktop title bar instead of the brand card", async () => {
  // Headless iOS has no window; the desktop targets mount the title bar. The
  // Linux host has a title bar too, but no pin control (NSH cannot set a
  // window level there), so branch on the bar itself, not the pin label.
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  if (app.shows("id:title-bar")) {
    expect(app.shows("id:brand-card")).toBe(false);
    // One wordmark: the title bar replaced the floating brand card.
    expect(app.count("text:Flow")).toBe(1);

    // The bar survives the narrowest phone-sized and a wide desktop window.
    await app.setViewport(360, 640);
    expect(app.shows("id:title-bar")).toBe(true);
    await app.setViewport(1200, 800);
    expect(app.shows("id:title-bar")).toBe(true);
  } else {
    expect(app.shows("id:brand-card")).toBe(true);
  }
});

test("pins and unpins the desktop window", async () => {
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const pin = "label:Pin window on top";

  // A web host owns the window; the app has no pin control there.
  if (!app.shows(pin)) return;

  await app.press(pin);
  await app.waitUntil(() => app.shows("label:Unpin window"));
  expect(app.shows(pin)).toBe(false);

  await app.press("label:Unpin window");
  await app.waitUntil(() => app.shows(pin));
});

test("repaints when the system appearance changes", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Repaints the native scene through the same effect a user's system uses.
  await app.setColorScheme("dark");
  await app.setColorScheme("light");

  expect(percentOf(app.texts())).toBeGreaterThan(0);
  expect(app.texts()).toContain("Flow");
});

test("opens the canvas menu with a secondary click", async () => {
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-text");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
});

test("runs the seeded image node and records its mock batch", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:composer-run"));

  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("Done")));
  expect(app.texts().some((text) => text.endsWith("Done"))).toBe(true);
});
