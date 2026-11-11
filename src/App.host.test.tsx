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
  // selects the edge. Moving the flow with an arrow leaves the box-select on
  // empty canvas.
  await app.keyboard.press("down");

  await app.drag("id:flow-canvas", {
    x: -260 * scale,
    y: -100 * scale,
  });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);
  // One card is a normal selection: no group frame around it.
  expect(app.shows("id:selection-frame")).toBe(false);
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

test("drags a card through the canvas pointer surface", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Reveal and centre the seed text card, then close its composer so the
  // press lands on the card itself.
  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:node-composer"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:node-composer"));

  // The revealed card sits at the canvas centre. Drag it far enough that the
  // old centre is empty: pressing there afterwards must select nothing, so
  // the move went through the native pointer surface and committed.
  await app.drag("id:flow-canvas", { x: 400, y: 260 });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  // The press that started the drag landed on the selected card, which opens
  // its composer again; close the sheet so the canvas takes the next press.
  await app.waitUntil(() => app.texts().some((text) => text.includes("Esc to close")));
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().some((text) => text.includes("Esc to clear")));
  // A click on the now-empty centre clears the selection; the canvas's
  // pointer surface listens to touch and mouse events, not to `onPress`.
  await app.drag("id:flow-canvas", { x: 0, y: 0 });
  await app.waitUntil(() => !app.texts().some((text) => text.includes("card selected")));
});

test("searches cards and reveals the chosen one", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Move the flow off screen first: revealing the hit must pan back to it.
  // Each press is its own keydown/keyup, so they are sent one at a time.
  const panRight = async (remaining: number): Promise<void> => {
    if (remaining === 0) return;
    await app.keyboard.press("right");
    await panRight(remaining - 1);
  };
  await panRight(15);

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

test("opens the canvas menu after a click on the canvas", async () => {
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // The click's touch end (NSH reports a mouse press to `onTouch` listeners
  // too) must not swallow the secondary press that follows it.
  await app.drag("id:flow-canvas", { x: 0, y: 0 });
  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
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

test("loads a blob image through the asset cache", async () => {
  const app = await open("./App.tsx", {
    width: 900,
    height: 1300,
    platform: "windows",
    host: { params: { flowImageLoadProbe: 1 } },
  });
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitFor("id:composer-run");

  // Headless never loads images (no onLoad comes), so its run only proves
  // the probe exists and reported nothing; the Windows host proves the load.
  // A headless app still reports a desktop title bar for `platform:
  // "windows"`, so the missing screenshot platform is what tells the two
  // apart before the run: only a real platform draws the window.
  const picture = await app.screenshot().then(
    (png) => png,
    () => null,
  );
  if (picture === null) {
    expect(app.shows("id:composer-run")).toBe(true);
    await app.waitFor("id:image-load-probe");
    expect(app.value("id:image-load-probe")).toBe("");
    return;
  }
  expect(picture.length).toBeGreaterThan(0);

  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("Done")));
  await app.waitUntil(
    () => {
      const parts = (app.value("id:image-load-probe") ?? "").split(";");
      return (
        parts[0] === "load" &&
        parts[1] === "seed-image" &&
        (parts[2] ?? "").startsWith("blob:") &&
        Number(parts[3]) > 0 &&
        Number(parts[4]) > 0
      );
    },
    { timeout: 15000 },
  );

  const report = app.value("id:image-load-probe") ?? "";
  expect(report).not.toMatch(/^error;/);
  expect(report).not.toContain("error;seed-image");
  const parts = report.split(";");
  expect(parts).toHaveLength(6);
  expect(parts[0]).toBe("load");
  expect(parts[1]).toBe("seed-image");
  expect(new URL(parts[2] ?? "").protocol).toBe("blob:");
  expect(Number.isFinite(Number(parts[3]))).toBe(true);
  expect(Number.isFinite(Number(parts[4]))).toBe(true);
  expect(Number(parts[3])).toBeGreaterThan(0);
  expect(Number(parts[4])).toBeGreaterThan(0);
});
