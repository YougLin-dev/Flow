import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import type { NodeSummary } from "@flow/native";
import { CardContent } from "./card-content";

function node(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "a",
    kind: "text",
    title: "Text",
    body: "First output",
    x: 40,
    y: 40,
    width: 300,
    height: 220,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
    ...overrides,
  };
}

interface Runs {
  readonly title: () => number;
  readonly body: () => number;
  readonly status: () => number;
  readonly statusText: () => number;
  readonly accent: () => number;
  readonly image: () => number;
}

/** Counts how often an effect reading each value runs (once at the start). */
function wakes(content: CardContent): Runs {
  const counts = { title: 0, body: 0, status: 0, statusText: 0, accent: 0, image: 0 };
  effect(() => {
    content.title();
    counts.title += 1;
  });
  effect(() => {
    content.body();
    counts.body += 1;
  });
  effect(() => {
    content.status();
    counts.status += 1;
  });
  effect(() => {
    content.statusText();
    counts.statusText += 1;
  });
  effect(() => {
    content.accent();
    counts.accent += 1;
  });
  effect(() => {
    content.image();
    counts.image += 1;
  });
  return {
    title: () => counts.title,
    body: () => counts.body,
    status: () => counts.status,
    statusText: () => counts.statusText,
    accent: () => counts.accent,
    image: () => counts.image,
  };
}

test("a read that carries the same fields wakes nothing", () => {
  const source = signal(node());
  const content = new CardContent(() => source());
  const runs = wakes(content);

  // A viewport read delivers fresh records with the same content.
  source.set(node());
  source.set(node({ x: 400, y: 90 }));

  expect(runs.title()).toBe(1);
  expect(runs.body()).toBe(1);
  expect(runs.status()).toBe(1);
  expect(runs.statusText()).toBe(1);
  expect(runs.accent()).toBe(1);
  expect(runs.image()).toBe(1);
});

test("a new title wakes only the title", () => {
  const source = signal(node());
  const content = new CardContent(() => source());
  const runs = wakes(content);

  source.set(node({ title: "Renamed" }));

  expect(runs.title()).toBe(2);
  expect(runs.body()).toBe(1);
  expect(runs.status()).toBe(1);
  expect(runs.accent()).toBe(1);
  expect(content.title()).toBe("Renamed");
});

test("a new body wakes only the body", () => {
  const source = signal(node());
  const content = new CardContent(() => source());
  const runs = wakes(content);

  source.set(node({ body: "  Second output  " }));

  expect(runs.body()).toBe(2);
  expect(runs.title()).toBe(1);
  expect(content.body()).toBe("Second output");
});

test("a completed run wakes the status and its label", () => {
  const source = signal(node());
  const content = new CardContent(() => source());
  const runs = wakes(content);

  source.set(node({ status: "done" }));

  expect(runs.status()).toBe(2);
  expect(runs.statusText()).toBe(2);
  expect(runs.title()).toBe(1);
  expect(content.status()).toBe("done");
  expect(content.statusText()).toBe("Done");
});

test("another kind wakes the accent and the image check", () => {
  const source = signal(node());
  const content = new CardContent(() => source());
  const runs = wakes(content);

  source.set(node({ kind: "image" }));

  expect(runs.accent()).toBe(2);
  expect(runs.image()).toBe(2);
  expect(runs.title()).toBe(1);
  expect(content.accent()).toBe("chart-1");
  expect(content.image()).toBe(true);
});
