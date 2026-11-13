import { type App, expect, test } from "nsh/test";
import {
  openApp,
  openNodeMenu,
  percentOf,
  PNG_1X1,
  selectSeed,
  selectedOf,
} from "./app-test-harness";

/**
 * The composer always sits directly below its card and a revealed card is
 * centered, so its full sheet needs a stage taller than the default phone.
 */
const openTallApp = (): Promise<App> => openApp({ width: 900, height: 1300 });

test("selecting a text node opens its chat composer", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:node-composer"));
  expect(app.shows("id:composer-prompt")).toBe(true);
  expect(app.shows("id:composer-image-button")).toBe(true);
  // The sheet is prompt-only: the card owns the generated text.
  expect(app.shows("id:composer-body")).toBe(false);
});

test("edits a text card in place with Mod+Enter", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));

  await app.keyboard.press("mod+enter");
  await app.waitUntil(() => app.shows("id:inline-text-input"));
  // The card's own body is the editor; the composer steps aside.
  await app.waitUntil(() => !app.shows("id:composer-prompt"));

  await app.clear("id:inline-text-input");
  await app.type("id:inline-text-input", "Edited in place");
  // Moving on to another card (here the toolbar's add) writes the draft and
  // closes the editor rather than leaving a stale edit behind.
  await app.press("id:add-text-node");
  await app.waitUntil(() => !app.shows("id:inline-text-input"));
  await app.waitUntil(() => app.texts().some((text) => text.includes("Edited in place")));
});

test("opens the in-place editor from a text card's menu", async () => {
  const app = await openApp({ platform: "windows" });
  await app.waitUntil(() => percentOf(app) > 0);

  await openNodeMenu(app, "Text", "id:search-result-seed-text");
  expect(app.shows("id:context-edit-text")).toBe(true);
  await app.press("id:context-edit-text");
  await app.waitUntil(() => app.shows("id:inline-text-input"));
  await app.waitUntil(() => !app.shows("id:canvas-menu"));

  // Other cards have no body to edit: their menu offers Copy and Delete only.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:inline-text-input"));
  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:node-composer"));
  await app.rightClick("id:flow-canvas");
  await app.waitUntil(() => app.shows("id:context-copy-node"));
  expect(app.shows("id:context-edit-text")).toBe(false);
});

test("keeps the composer mounted while its selected card is clicked", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  expect(selectedOf(app)).toBe(1);

  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "fresh click draft");
  expect(app.value("id:composer-prompt")).toBe("fresh click draft");

  // The search reveal centers the selected card, so a press at the canvas
  // centre lands on it; the pointer stays down while the screen is read.
  await app.dragAndHold("id:flow-canvas", { x: 0, y: 0 });
  expect(app.shows("id:node-composer")).toBe(true);
  expect(app.shows("id:composer-prompt")).toBe(true);
  expect(app.value("id:composer-prompt")).toBe("fresh click draft");

  await app.drop();
  await app.waitFor("id:composer-prompt");
  await app.type("id:composer-prompt", " suffix");
  const value = app.value("id:composer-prompt") ?? "";
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

test("counts the composer prompt's characters", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));

  await app.clear("id:composer-prompt");
  await app.type("id:composer-prompt", "Hello");
  await app.waitUntil(() => app.texts().includes("5/10000"));
  expect(app.texts()).toContain("5/10000");
});

test("attaches and removes an image in the text composer", async () => {
  const app = await openApp({ width: 900 });
  await app.waitUntil(() => percentOf(app) > 0);
  app.onPick(() => [{ name: "ref.png", type: "image/png", data: PNG_1X1 }]);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-image-button"));

  await app.press("id:composer-image-button");
  await app.waitUntil(() => app.shows("label:Remove image input"));
  expect(app.shows("label:Remove image input")).toBe(true);

  await app.press("label:Remove image input");
  await app.waitUntil(() => !app.shows("label:Remove image input"));
  expect(app.shows("label:Remove image input")).toBe(false);
});

test("switches the composer to another node", async () => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-prompt"));

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));
  // The chat sheet belongs to text nodes; the image node keeps its own panel.
  expect(app.shows("id:composer-image-button")).toBe(false);
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
