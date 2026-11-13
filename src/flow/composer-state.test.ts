import { expect, test } from "nsh/test";
import { effect, signal } from "nsh";
import type { NodeDetail, NodeSummary } from "@flow/native";
import { ComposerState, type ComposerSaver } from "./composer-state";
import type { NodeSettings } from "./node-kinds";

function detail(id: string, kind: string, settingsJson: string): NodeDetail {
  const node: NodeSummary = {
    id,
    kind,
    title: id,
    body: "body",
    x: 0,
    y: 0,
    width: 300,
    height: 220,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson,
    status: "idle",
    outputBatchId: null,
  };
  return { node, batch: null, latestBatch: null, inputs: [], incoming: [] };
}

const IMAGE_JSON =
  '{"version":1,"prompt":"mountain lake","model":"mock-image","aspect":"16:9","count":2}';
const TEXT_JSON = '{"version":1,"prompt":"write","model":"mock-text"}';

interface Write {
  readonly id: string;
  readonly settings: NodeSettings;
}

function saver(writes: Write[]): ComposerSaver {
  return {
    saveSettings: async (id, settings) => {
      writes.push({ id, settings });
    },
  };
}

test("loads the draft from the node detail", () => {
  const state = new ComposerState();
  state.sync(detail("image", "image", IMAGE_JSON));

  expect(state.prompt()).toBe("mountain lake");
  expect(state.aspect()).toBe("16:9");
  expect(state.count()).toBe(2);
});

test("keeps edits on the same node and reloads on another", () => {
  const state = new ComposerState();
  const first = detail("image", "image", IMAGE_JSON);
  state.sync(first);
  state.setPrompt("dusk");

  // A detail refresh for the same node keeps the user's draft.
  state.sync(first);
  expect(state.prompt()).toBe("dusk");

  state.sync(detail("text", "text", TEXT_JSON));
  expect(state.prompt()).toBe("write");
});

test("syncing inside an effect settles instead of re-arming itself", () => {
  const state = new ComposerState();
  const detailSignal = signal<NodeDetail | null>(detail("text", "text", TEXT_JSON));
  let runs = 0;
  effect(() => {
    runs += 1;
    state.sync(detailSignal());
  });
  expect(runs).toBe(1);
  expect(state.prompt()).toBe("write");

  detailSignal.set(detail("text", "text", '{"version":1,"prompt":"after","model":"mock-text"}'));
  expect(runs).toBe(2);
  expect(state.prompt()).toBe("after");
});

test("adopts external settings until the user edits them", () => {
  const state = new ComposerState();
  const external = (prompt: string): string =>
    JSON.stringify({ version: 1, prompt, model: "mock-text" });

  state.sync(detail("text", "text", external("old")));
  state.sync(detail("text", "text", external("new")));
  expect(state.prompt()).toBe("new");

  state.setPrompt("mine");
  state.sync(detail("text", "text", external("another")));
  expect(state.prompt()).toBe("mine");
});

test("resets when the composer closes", () => {
  const state = new ComposerState();
  state.sync(detail("image", "image", IMAGE_JSON));
  state.reset();

  expect(state.settings()).toBeNull();
  expect(state.prompt()).toBe("");
});

test("clamps the image count and changes the aspect", () => {
  const state = new ComposerState();
  state.sync(detail("image", "image", IMAGE_JSON));

  state.setCount(1);
  expect(state.count()).toBe(3);
  state.setCount(1);
  expect(state.count()).toBe(4);
  state.setCount(1);
  expect(state.count()).toBe(4);
  state.setCount(-10);
  expect(state.count()).toBe(1);

  state.setAspect("9:16");
  expect(state.aspect()).toBe("9:16");
});

test("text nodes keep the default aspect and count", () => {
  const state = new ComposerState();
  state.sync(detail("text", "text", TEXT_JSON));

  expect(state.aspect()).toBe("1:1");
  expect(state.count()).toBe(1);
  state.setAspect("16:9");
  state.setCount(1);
  expect(state.aspect()).toBe("1:1");
  expect(state.count()).toBe(1);
});

test("saves the settings draft", () => {
  const state = new ComposerState();
  const current = detail("image", "image", IMAGE_JSON);
  const writes: Write[] = [];
  state.sync(current);
  state.setPrompt("A quiet lake");
  state.setAspect("9:16");
  state.setCount(1);

  state.save(saver(writes), current);
  expect(writes).toEqual([
    {
      id: "image",
      settings: {
        version: 1,
        prompt: "A quiet lake",
        model: "mock-image",
        aspect: "9:16",
        count: 3,
      },
    },
  ]);
});

test("saves nothing without a session or a detail", () => {
  const state = new ComposerState();
  state.sync(detail("image", "image", IMAGE_JSON));
  state.setPrompt("draft");
  const writes: Write[] = [];

  state.save(null, detail("image", "image", IMAGE_JSON));
  state.save(saver(writes), null);
  expect(writes).toEqual([]);
});
