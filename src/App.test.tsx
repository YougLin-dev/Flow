import { type App, expect, open, type OpenOptions, test } from "nsh/test";
import { CONTENT, seedNodes } from "./flow/data";

/** Opens the composer of a seed node through search. */
const selectSeed = async (app: App, query: string, testId: string): Promise<void> => {
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", query);
  await app.waitUntil(() => app.shows(testId));
  await app.press(testId);
};

/** Centres a seed card through search, then opens its own context menu. */
const openNodeMenu = async (app: App, query: string, testId: string): Promise<void> => {
  await selectSeed(app, query, testId);
  await app.waitUntil(() => app.shows("id:composer-body"));
  // The reveal centres the card, so the canvas's middle presses it.
  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));
};

/** Opens the app with the probe a test reads the camera scale from. */
const openApp = (options: OpenOptions = {}): Promise<App> =>
  open("./App.tsx", {
    ...options,
    host: {
      ...options.host,
      params: { ...options.host?.params, flowZoomProbe: 1, flowSelectionProbe: 1 },
    },
  });

/**
 * The composer always sits directly below its card and a revealed card is
 * centered, so its full sheet needs a stage taller than the default phone.
 */
const openTallApp = (): Promise<App> => openApp({ width: 900, height: 1300 });

const percentOf = (app: App): number => {
  const value = app.value("id:zoom-probe");
  return value ? Number(value) : Number.NaN;
};

const canvasState = (app: App): { selected: number; composing: boolean } => {
  const [selected = "0", composing = "0"] = (app.value("id:canvas-probe") ?? "").split(";");
  return { selected: Number(selected), composing: composing === "1" };
};

const selectedOf = (app: App): number => canvasState(app).selected;

/** Half the flow's size in world coordinates. */
const HALF_WIDTH = CONTENT.width / 2;
const HALF_HEIGHT = CONTENT.height / 2;

/** How far one arrow press moves the camera, in screen points. */
const ARROW_STEP = 40;

/** Arrow travel that carries a card past the canvas centre at any fit. */
const ARROW_TRAVEL = 320;

type Arrow = "down" | "left" | "right" | "up";

interface ArrowProbe {
  /** How many presses it takes to travel `ARROW_TRAVEL`. */
  presses: number;
  /** A box-select drag that only finds empty canvas after the arrow's pan. */
  drag: { x: number; y: number };
}

/**
 * The presses and box-select for an arrow test: after the flow has moved
 * `ARROW_TRAVEL` points the arrow's way, the box covers the strip it would
 * have entered had the arrow moved it the other way (or not moved it at all).
 */
const arrowProbe = (scale: number, arrow: Arrow): ArrowProbe => {
  const presses = Math.ceil((ARROW_TRAVEL * scale) / ARROW_STEP);
  const travel = presses * ARROW_STEP;
  if (arrow === "up" || arrow === "down") {
    const reach = travel - HALF_HEIGHT * scale + 20;
    return { presses, drag: { x: -HALF_WIDTH * scale, y: arrow === "down" ? reach : -reach } };
  }
  const reach = travel - HALF_WIDTH * scale + 20;
  return { presses, drag: { x: arrow === "right" ? reach : -reach, y: -HALF_HEIGHT * scale } };
};

/** Presses `arrow` and proves the flow moved the arrow's way. */
const expectArrowPan = async (arrow: Arrow): Promise<void> => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const probe = arrowProbe(percentOf(app) / 100, arrow);

  // Each press is its own keydown/keyup, so they are sent one at a time.
  const pressRepeatedly = async (remaining: number): Promise<void> => {
    if (remaining === 0) return;
    await app.keyboard.press(arrow);
    await pressRepeatedly(remaining - 1);
  };
  await pressRepeatedly(probe.presses);
  await app.drag("id:flow-canvas", probe.drag);

  // Empty canvas here means the flow moved the arrow's way; had it moved the
  // other way (or not moved), the box would have hit a card.
  expect(selectedOf(app)).toBe(0);
};

test("adds a panel with the toolbar and deletes it with Backspace", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await app.press("id:add-text-node");
  await app.waitUntil(() => selectedOf(app) === 1);
  expect(selectedOf(app)).toBe(1);

  // The new node's composer is open, so Delete is held back; Escape closes
  // the composer while keeping the node selected.
  await app.keyboard.press("escape");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => selectedOf(app) === 0);
  expect(selectedOf(app)).toBe(0);

  // The selection probe clearing only proves the selection reset; search
  // proves the node is gone from the document and its full-text index.
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "New panel");
  await app.waitUntil(() => app.texts().includes("No cards match"));
  expect(app.texts()).toContain("No cards match");
});

test("adds an image node from the toolbar", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await app.press("id:add-image-node");
  await app.waitUntil(() => selectedOf(app) === 1);
  await app.waitUntil(() => app.texts().includes("Model · Mock Image"));
  expect(selectedOf(app)).toBe(1);
});

test("clears the selection with Escape", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const scale = percentOf(app) / 100;

  // Move the flow off the canvas centre so the marquee starts on empty
  // canvas instead of the connector between the two cards.
  await app.keyboard.press("down");

  await app.drag("id:flow-canvas", { x: -260 * scale, y: -100 * scale });
  await app.waitUntil(() => selectedOf(app) === 1);

  // Selecting a card opens its composer; Escape closes the sheet first and
  // leaves the card selected, the second Escape clears the selection.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:node-composer"));
  expect(selectedOf(app)).toBe(1);

  await app.keyboard.press("escape");
  await app.waitUntil(() => selectedOf(app) === 0);
});

test("zooms with the controls", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const fitted = percentOf(app);

  await app.press("label:Zoom in");
  await app.waitUntil(() => percentOf(app) > fitted);
  const zoomed = percentOf(app);
  expect(zoomed).toBeGreaterThan(fitted);

  await app.press("id:zoom-fit");
  await app.waitUntil(() => percentOf(app) === fitted);
  expect(percentOf(app)).toBe(fitted);
});

test("hides and shows the minimap", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);
  expect(app.shows("id:flow-minimap")).toBe(true);

  await app.press("id:minimap-toggle");
  await app.waitUntil(() => !app.shows("id:flow-minimap"));
  expect(app.shows("label:Show minimap")).toBe(true);

  await app.press("id:minimap-toggle");
  await app.waitUntil(() => app.shows("id:flow-minimap"));
  expect(app.shows("label:Hide minimap")).toBe(true);
});

test("zooms with the keyboard", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const fitted = percentOf(app);

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app) > fitted);
  const zoomed = percentOf(app);
  expect(zoomed).toBeGreaterThan(fitted);
  // One press is 1.2×; a duplicate binding would pass 1.4×.
  expect(zoomed).toBeLessThan(fitted * 1.3);

  await app.keyboard.press("mod+-");
  await app.waitUntil(() => percentOf(app) === fitted);
  expect(percentOf(app)).toBe(fitted);
});

test("fits with the keyboard", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const fitted = percentOf(app);

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app) > fitted);

  await app.keyboard.press("mod+0");
  await app.waitUntil(() => percentOf(app) === fitted);
  expect(percentOf(app)).toBe(fitted);
});

test("pans right with the right arrow", async () => {
  await expectArrowPan("right");
});

test("pans left with the left arrow", async () => {
  await expectArrowPan("left");
});

test("pans up with the up arrow", async () => {
  await expectArrowPan("up");
});

test("pans down with the down arrow", async () => {
  await expectArrowPan("down");
});

test("opens a search result with Enter", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "Image");
  await app.waitUntil(() => app.shows("id:search-result-seed-image"));

  await app.submit("id:search-input");
  await app.waitUntil(() => selectedOf(app) === 1);
  expect(app.shows("id:search-input")).toBe(false);
});

test("closes the search palette with Escape", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await app.press("id:search-button");
  await app.waitUntil(() => app.shows("id:search-input"));

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:search-input"));
  expect(app.shows("id:search-input")).toBe(false);
});

test("selecting a text node opens its composer", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:node-composer"));
  expect(app.shows("id:composer-prompt")).toBe(true);
  expect(app.shows("id:composer-body")).toBe(true);
});

test("keeps the composer mounted while its selected card is clicked", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));
  expect(selectedOf(app)).toBe(1);

  await app.clear("id:composer-body");
  await app.type("id:composer-body", "fresh click draft");
  expect(app.value("id:composer-body")).toBe("fresh click draft");

  // The search reveal centers the selected card, so a press at the canvas
  // centre lands on it; the pointer stays down while the screen is read.
  await app.dragAndHold("id:flow-canvas", { x: 0, y: 0 });
  expect(app.shows("id:node-composer")).toBe(true);
  expect(app.shows("id:composer-body")).toBe(true);
  expect(app.value("id:composer-body")).toBe("fresh click draft");

  await app.drop();
  await app.waitFor("id:composer-body");
  await app.type("id:composer-body", " suffix");
  const value = app.value("id:composer-body") ?? "";
  expect(value).toContain("fresh click draft");
  expect(value).toContain("suffix");
});

test("edits the prompt and runs with it", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-run"));
  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "A quiet lake at dusk");
  await app.press("id:composer-run");
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes("[Mock Text] A quiet lake at dusk")),
  );
});

test("runs the selected text node with the mock provider", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-run"));

  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().some((text) => text.includes("[Mock Text]")));
  expect(app.texts().some((text) => text.endsWith("Done"))).toBe(true);
});

test("removes an input from the composer", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));

  await app.press("label:Remove input");
  await app.waitUntil(() => app.texts().includes("Inputs · 0"));
  // The upstream group and its chip are gone; the text card keeps its body.
  expect(app.texts().some((text) => text.includes("From Text"))).toBe(false);
  expect(app.texts().some((text) => text.includes("清晨"))).toBe(true);
});

test("reopens the image composer with its run results", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:composer-run"));
  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().some((text) => text.endsWith("Done")));

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:node-composer"));

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:composer-run"));
  expect(app.texts().some((text) => text.endsWith("Done"))).toBe(true);
  expect(app.value("id:composer-prompt") ?? "").toContain("mountain lake");
});

test("publishes an empty image-load probe while headless", async () => {
  const app = await openApp({
    width: 900,
    height: 1300,
    platform: "windows",
    host: { params: { flowImageLoadProbe: 1 } },
  });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitFor("id:composer-run");
  await app.waitFor("id:image-load-probe");
  expect(app.value("id:image-load-probe")).toBe("");
});

test("saves an edited text body from the composer", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));

  await app.clear("id:composer-body");
  await app.type("id:composer-body", "A fresh line");
  await app.press("id:composer-save-body");
  await app.waitUntil(
    () =>
      app.texts().includes("A fresh line") && !app.texts().some((text) => text.includes("清晨")),
  );
});

test("switches the composer to another node", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));
  expect(app.shows("id:composer-body")).toBe(false);
  // The drafts reset to the image node's settings.
  await app.waitUntil(() => (app.value("id:composer-prompt") ?? "").includes("mountain lake"));
});

test("keeps a draft when the composer switches nodes", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "Keep this draft");

  // A search result selects another node directly; the text node's draft
  // must be written before its detail is replaced.
  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => (app.value("id:composer-prompt") ?? "").includes("Keep this draft"));
});

test("shows why an empty-prompt run failed", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:composer-run"));

  await app.clear("id:composer-prompt");
  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().includes("Prompt cannot be empty"));
});

test("opens the canvas menu on a right click and adds a text node", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-text");

  await app.waitUntil(() => selectedOf(app) === 1);
  await app.waitUntil(() => app.texts().includes("Model · Mock Text"));
});

test("adds an image node from the canvas menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-image");

  await app.waitUntil(() => app.texts().includes("Model · Mock Image"));
});

test("closes the canvas menu with Escape", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));
});

test("opens a node's own menu instead of the canvas menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");

  expect(app.shows("id:context-add-text")).toBe(false);
  expect(app.shows("id:context-add-image")).toBe(false);
  expect(app.shows("id:context-delete-node")).toBe(true);
});

test("selects a card when its menu opens without opening its composer", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  // A toolbar add lands at the canvas's middle; clear its selection but
  // leave the card there for the right click.
  await app.press("id:add-text-node");
  await app.waitUntil(() => selectedOf(app) === 1);
  await app.waitUntil(() => app.shows("id:node-composer"));
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.waitUntil(() => selectedOf(app) === 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));

  expect(selectedOf(app)).toBe(1);
  expect(app.shows("id:node-composer")).toBe(false);
});

test("copies a node from its menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");
  await app.press("id:context-copy-node");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));
  // The copy must reach the canvas, not only the document: close the copy's
  // composer and look for the seed body on two cards.
  await app.keyboard.press("escape");
  const body = seedNodes()[0]?.body ?? "";
  await app.waitUntil(
    () => body !== "" && app.texts().filter((text) => text === body).length === 2,
  );
});

test("deletes a node from its menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");
  await app.press("id:context-delete-node");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));
  await app.waitUntil(() => selectedOf(app) === 0);

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "Text");
  await app.waitUntil(() => app.texts().includes("No cards match"));
});

test("copies a node with its unsaved composer text", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));
  await app.clear("id:composer-body");
  await app.type("id:composer-body", "Draft body");

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));
  await app.press("id:context-copy-node");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));

  // Both cards must show the draft the user was looking at, not the text the
  // source had before the edit.
  await app.waitUntil(() => app.texts().filter((text) => text === "Draft body").length >= 2);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().filter((text) => text === "Draft body").length === 2);
});

test("closes a node's menu when the camera moves", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");
  const zoom = percentOf(app);
  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app) !== zoom);
  await app.waitUntil(() => !app.shows("id:canvas-menu"));
});

test("closes a node's menu when undo removes its card", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  // The toolbar adds at the canvas's middle, so the card lands under the
  // right click.
  await app.press("id:add-text-node");
  await app.waitUntil(() => selectedOf(app) === 1);
  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-delete-node"));

  await app.keyboard.press("mod+z");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));
});

test("closes a node's menu with Escape and keeps its card selected", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));

  expect(selectedOf(app)).toBe(1);
});

test("deletes a node with its unsaved composer text", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));
  await app.clear("id:composer-body");
  await app.type("id:composer-body", "Draft body");

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-delete-node"));
  await app.press("id:context-delete-node");
  await app.waitUntil(() => selectedOf(app) === 0);

  // Undo restores the card with the text the user typed, not the old body.
  await app.keyboard.press("mod+z");
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "Draft body");
  await app.waitUntil(() => app.texts().includes("1 result"));
});
