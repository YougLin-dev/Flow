import { expect, open, test } from "nsh/test";

const percentOf = (texts: string[]): number => {
  const text = texts.find((value) => /^\d+%$/.test(value));
  return text ? Number(text.slice(0, -1)) : Number.NaN;
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

test("follows the system appearance", async () => {
  const app = await open("./App.tsx");
  await app.waitUntil(() => percentOf(app.texts()) > 0);

  // Repaints the Leafer scene through the same effect a user's system uses.
  await app.setColorScheme("dark");
  await app.setColorScheme("light");

  expect(percentOf(app.texts())).toBeGreaterThan(0);
  expect(app.texts()).toContain("Flow");
});
