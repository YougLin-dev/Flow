import { type App, expect, test } from "nsh/test";
import {
  canvasState,
  openApp,
  openNodeMenu,
  percentOf,
  PNG_1X1,
  selectSeed,
  selectedOf,
} from "./app-test-harness";
import { seedNodes } from "./flow/data";

/** Rests the pointer on a canvas control and proves its tooltip shows `label`. */
const expectTooltip = async (app: App, testID: string, label: string): Promise<void> => {
  await app.hover(`id:${testID}`);
  await app.waitUntil(() => app.shows(`text:${label}`));
  expect(app.shows(`text:${label}`)).toBe(true);
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

test("adds an upload node and uploads from its card", async () => {
  // A headless screen lays views out without the canvas transform, so a card
  // at the canvas centre sits at its world point: a phone-width window cuts
  // the card's bottom-right button off even though the camera shows it.
  const app = await openApp({ width: 900 });
  await app.waitUntil(() => percentOf(app) > 0);
  app.onPick(() => [{ name: "cat.png", type: "image/png", data: PNG_1X1 }]);

  await app.press("id:add-upload-node");
  await app.waitUntil(() => selectedOf(app) === 1);
  await app.waitFor("id:upload-node-button");

  await app.press("id:upload-node-button");
  await app.waitFor("text:Replace");
  expect(app.shows("label:Replace the image")).toBe(true);
  // An upload card is its own control: it never opens a composer.
  expect(canvasState(app).composing).toBe(false);
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

test("names the canvas controls in tooltips", async () => {
  const app = await openApp({ platform: "macos" });
  await app.waitUntil(() => percentOf(app) > 0);

  // The controls share one column: resting on each shows its hint above it.
  await expectTooltip(app, "zoom-in", "Zoom in");
  await expectTooltip(app, "zoom-out", "Zoom out");
  await expectTooltip(app, "zoom-fit", "Fit");
  await expectTooltip(app, "minimap-toggle", "Hide minimap");
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

test("opens the canvas menu on a right click and adds a text node", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-text");

  await app.waitUntil(() => selectedOf(app) === 1);
  await app.waitFor("id:composer-image-button");
});

test("adds an image node from the canvas menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-image");

  await app.waitUntil(() => app.texts().includes("Model · Mock Image"));
});

test("adds an upload node from the canvas menu", async () => {
  const app = await openApp({ width: 900, platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:canvas-menu"));
  await app.press("id:context-add-upload");

  await app.waitUntil(() => app.shows("id:upload-node-button"));
  // An upload card is its own control: selecting it opens no composer.
  expect(canvasState(app).composing).toBe(false);
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

test("deletes a connection from its menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  // The seed connector's curve passes just above the fitted centre. Zooming
  // in shortens the keyboard's 40-point pan to less than the edge hit
  // distance in world points, so one Up press brings the curve under the
  // canvas's middle for the right click. One extra press absorbs the zoom
  // probe's whole-percent rounding.
  const zoomPresses = Math.ceil(Math.log(1.6 / (percentOf(app) / 100)) / Math.log(1.2)) + 1;
  const zoomIn = async (remaining: number): Promise<void> => {
    if (remaining === 0) return;
    await app.keyboard.press("mod+=");
    await zoomIn(remaining - 1);
  };
  await zoomIn(zoomPresses);
  await app.waitUntil(() => percentOf(app) >= 160);
  await app.keyboard.press("up");

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-delete-edge"));
  expect(app.shows("id:context-delete-node")).toBe(false);
  await app.press("id:context-delete-edge");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));

  // Both cards remain, but the image card's prompt input lost its source.
  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 0"));
});

test("copies a node with its unsaved prompt", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "Draft prompt");

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));
  await app.press("id:context-copy-node");
  await app.waitUntil(() => !app.shows("id:canvas-menu"));

  // The copy is selected and carries the prompt the user was editing, not
  // the source's committed settings.
  await app.waitUntil(() => (app.value("id:composer-prompt") ?? "").includes("Draft prompt"));
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

test("deletes a node with its unsaved prompt", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "Keep this prompt");

  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-delete-node"));
  await app.press("id:context-delete-node");
  await app.waitUntil(() => selectedOf(app) === 0);

  // Undo restores the card with the prompt the user typed, not the old one.
  await app.keyboard.press("mod+z");
  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => (app.value("id:composer-prompt") ?? "").includes("Keep this prompt"));
});

test("toggles a card with a shift click", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:node-composer"));

  // The reveal centred the text card, so a still drag at the canvas's middle
  // is a click on it. The pointer surface has no `onPress` (it hears the
  // press down and up), so the pointer is driven through a zero drag.
  await app.keyboard.down("shift");
  await app.drag("id:flow-canvas", { x: 0, y: 0 });
  await app.keyboard.up("shift");

  await app.waitUntil(() => selectedOf(app) === 0);
});
