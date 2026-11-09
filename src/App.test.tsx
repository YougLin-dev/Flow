import { type App, expect, open, test } from "nsh/test";
import { CONTENT } from "./flow/data";

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
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const probe = arrowProbe(percentOf(app.texts()) / 100, arrow);

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
  expect(app.texts().some((text) => text.includes("card selected"))).toBe(false);
};

test("adds a panel with N and deletes it with Backspace", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("n");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);

  // The new node's composer is open, so Delete is held back; Escape closes
  // the composer while keeping the node selected.
  await app.keyboard.press("escape");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("card selected")));
  expect(app.texts().some((text) => text.includes("card selected"))).toBe(false);

  // The badge clearing only proves the selection reset; search proves the
  // node is gone from the document and its full-text index.
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "New panel");
  await app.waitUntil(() => app.texts().includes("No cards match"));
  expect(app.texts()).toContain("No cards match");
});

test("adds an image node with I", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("i");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  await app.waitUntil(() => app.texts().includes("Model · Mock Image"));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);
});

test("clears the selection with Escape", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: 0, y: 20 });
  await app.keyboard.press("v");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("V to select")));

  await app.drag("id:flow-canvas", { x: -260 * scale, y: -100 * scale });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));

  // Selecting a card opens its composer; Escape closes the sheet first and
  // leaves the card selected, the second Escape clears the selection.
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().some((text) => text.includes("Esc to clear")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("card selected")));
});

test("pans in hand mode without selecting", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: -80, y: -40 });

  expect(app.texts().some((text) => text.includes("card selected"))).toBe(false);
});

test("zooms with the controls", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const fitted = percentOf(app.texts());

  await app.press("label:Zoom in");
  await app.waitUntil(() => percentOf(app.texts()) > fitted);
  const zoomed = percentOf(app.texts());
  expect(zoomed).toBeGreaterThan(fitted);

  await app.press("Fit");
  await app.waitUntil(() => percentOf(app.texts()) === fitted);
  expect(percentOf(app.texts())).toBe(fitted);
});

test("zooms with the keyboard", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const fitted = percentOf(app.texts());

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app.texts()) > fitted);
  const zoomed = percentOf(app.texts());
  expect(zoomed).toBeGreaterThan(fitted);
  // One press is 1.2×; a duplicate binding would pass 1.4×.
  expect(zoomed).toBeLessThan(fitted * 1.3);

  await app.keyboard.press("mod+-");
  await app.waitUntil(() => percentOf(app.texts()) === fitted);
  expect(percentOf(app.texts())).toBe(fitted);
});

test("fits with the keyboard", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const fitted = percentOf(app.texts());

  await app.keyboard.press("mod+=");
  await app.waitUntil(() => percentOf(app.texts()) > fitted);

  await app.keyboard.press("mod+0");
  await app.waitUntil(() => percentOf(app.texts()) === fitted);
  expect(percentOf(app.texts())).toBe(fitted);
});

test("switches to the hand tool with H", async () => {
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  await app.keyboard.press("h");
  await app.waitUntil(() => app.texts().some((text) => text.includes("V to select")));

  // The hand tool pans; the same drag in select would box-select a card.
  await app.drag("id:flow-canvas", { x: -260 * scale, y: -136 * scale });
  expect(app.texts().some((text) => text.includes("card selected"))).toBe(false);
});

test("switches back to the select tool with V", async () => {
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  await app.keyboard.press("h");
  await app.waitUntil(() => app.texts().some((text) => text.includes("V to select")));

  await app.keyboard.press("v");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("V to select")));

  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: 0, y: 20 });
  await app.keyboard.press("v");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("V to select")));
  await app.drag("id:flow-canvas", { x: -260 * scale, y: -100 * scale });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
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
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "Image");
  await app.waitUntil(() => app.shows("id:search-result-seed-image"));

  await app.submit("id:search-input");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.shows("id:search-input")).toBe(false);
});

test("closes the search palette with Escape", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.press("id:search-button");
  await app.waitUntil(() => app.shows("id:search-input"));

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:search-input"));
  expect(app.shows("id:search-input")).toBe(false);
});

test("selecting a text node opens its composer", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:node-composer"));
  expect(app.shows("id:composer-prompt")).toBe(true);
  expect(app.shows("id:composer-body")).toBe(true);
});

test("edits the prompt and runs with it", async () => {
  const app = await openTallApp();
  await app.waitUntil(() => percentOf(app.texts()) > 0);

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
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-run"));

  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().some((text) => text.includes("[Mock Text]")));
  expect(app.texts().some((text) => text.endsWith("Done"))).toBe(true);
});

test("removes an input from the composer", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));

  await app.press("label:Remove input");
  await app.waitUntil(() => app.texts().includes("Inputs · 0"));
  // The upstream group and its chip are gone; the text card keeps its body.
  expect(app.texts().some((text) => text.includes("From Text"))).toBe(false);
  expect(app.texts().some((text) => text.includes("清晨"))).toBe(true);
});

test("saves an edited text body from the composer", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

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
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Text", "id:search-result-seed-text");
  await app.waitUntil(() => app.shows("id:composer-body"));

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.texts().includes("Inputs · 1"));
  expect(app.shows("id:composer-body")).toBe(false);
  // The drafts reset to the image node's settings.
  await app.waitUntil(() => (app.value("id:composer-prompt") ?? "").includes("mountain lake"));
});

test("keeps a draft when the composer switches nodes", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

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
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await selectSeed(app, "Image", "id:search-result-seed-image");
  await app.waitUntil(() => app.shows("id:composer-run"));

  await app.clear("id:composer-prompt");
  await app.press("id:composer-run");
  await app.waitUntil(() => app.texts().includes("Prompt cannot be empty"));
});
