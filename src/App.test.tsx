import { expect, open, test } from "nsh/test";
import { CONTENT } from "./flow/data";

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

test("shows the flow canvas", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const texts = app.texts();
  expect(texts).toContain("Flow");
  expect(texts).toContain("Leafer engine · NSH");
  expect(texts).toContain("Fit");
});

test("box-selects a card", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  // The canvas is fitted around the flow; its middle is the flow's middle.
  await app.drag("id:flow-canvas", {
    x: -260 * scale,
    y: -136 * scale,
  });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);
});

test("adds a panel with N and deletes it with Backspace", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("n");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);

  await app.keyboard.press("backspace");
  await app.waitUntil(() => !app.texts().some((text) => text.includes("card selected")));
  expect(app.texts().some((text) => text.includes("card selected"))).toBe(false);
});

test("drags a new panel and undoes the move", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("n");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));

  // The new panel is at the canvas centre, so this drag lands on it. Undo
  // should reverse the move, not the insert: the panel stays selected.
  await app.drag("id:flow-canvas", { x: 30, y: 20 });
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.texts().some((text) => text.includes("1 card selected"))).toBe(true);
});

test("clears the selection with Escape", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);
  const scale = percentOf(app.texts()) / 100;

  await app.drag("id:flow-canvas", { x: -260 * scale, y: -136 * scale });
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));

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

  await app.press("+");
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

  await app.drag("id:flow-canvas", { x: -260 * scale, y: -136 * scale });
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

test("searches cards and reveals the chosen one", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Move the flow off screen first: revealing the hit must pan back to it.
  await app.press("Hand");
  await app.drag("id:flow-canvas", { x: 600, y: 0 });

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "schema");
  await app.waitUntil(() => app.shows("id:search-result-validate"));

  await app.press("id:search-filter-panel");
  await app.waitUntil(() => app.shows("id:search-result-validate"));

  await app.press("id:search-result-validate");
  await app.waitUntil(() => app.texts().some((text) => text.includes("1 card selected")));
  expect(app.shows("id:search-input")).toBe(false);
});

test("opens a search result with Enter", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.shows("id:search-input"));
  await app.type("id:search-input", "deliver");
  await app.waitUntil(() => app.shows("id:search-result-deliver"));

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

test("shows the desktop title bar instead of the brand card", async () => {
  // Headless iOS has no window; opening as a desktop mounts the title bar.
  // A browser host keeps its own window, where the brand card stands in.
  const app = await open("./App.tsx", { platform: "windows" });
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  if (app.shows("label:Pin window on top")) {
    expect(app.shows("id:brand-card")).toBe(false);
    // One wordmark: the title bar replaced the floating brand card.
    expect(app.count("text:Flow")).toBe(1);

    // The bar survives the narrowest phone-sized and a wide desktop window.
    await app.setViewport(360, 640);
    expect(app.shows("label:Pin window on top")).toBe(true);
    await app.setViewport(1200, 800);
    expect(app.shows("label:Pin window on top")).toBe(true);
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

test("follows the system appearance", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Repaints the Leafer scene through the same effect a user's system uses.
  await app.setColorScheme("dark");
  await app.setColorScheme("light");

  expect(percentOf(app.texts())).toBeGreaterThan(0);
  expect(app.texts()).toContain("Flow");
});
