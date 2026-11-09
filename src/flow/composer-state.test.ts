import { expect, test } from "nsh/test";
import { effect, signal } from "nsh";
import type { NodeDetail, NodeSummary } from "@flow/native";
import { ComposerState, type ComposerSaver } from "./composer-state";
import type { NodeSettings } from "./node-kinds";

function detail(id: string, kind: string, settingsJson: string, body = "body"): NodeDetail {
  const node: NodeSummary = {
    id,
    kind,
    title: id,
    body,
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
  return { node, batch: null, latestBatch: null, inputs: [] };
}

const IMAGE_JSON =
  '{"version":1,"prompt":"mountain lake","model":"mock-image","aspect":"16:9","count":2}';
const TEXT_JSON = '{"version":1,"prompt":"write","model":"mock-text"}';

interface Write {
  readonly kind: "settings" | "body";
  readonly id: string;
  readonly settings?: NodeSettings;
  readonly text?: string;
}

function saver(writes: Write[]): ComposerSaver {
  return {
    saveSettings: async (nodeId, settings) => {
      writes.push({ kind: "settings", id: nodeId, settings });
    },
    commitBody: async (nodeId, text) => {
      writes.push({ kind: "body", id: nodeId, text });
    },
  };
}

test("loads the drafts from the node detail", () => {
  const state = new ComposerState();
  state.sync(detail("image", "image", IMAGE_JSON, "清晨"));

  expect(state.prompt()).toBe("mountain lake");
  expect(state.aspect()).toBe("16:9");
  expect(state.count()).toBe(2);
  expect(state.body()).toBe("清晨");
});

test("keeps edits on the same node and reloads on another", () => {
  const state = new ComposerState();
  const first = detail("image", "image", IMAGE_JSON, "清晨");
  state.sync(first);
  state.setPrompt("dusk");
  state.setBody("changed");

  // A detail refresh for the same node keeps the user's drafts.
  state.sync(first);
  expect(state.prompt()).toBe("dusk");
  expect(state.body()).toBe("changed");

  state.sync(detail("text", "text", '{"version":1,"prompt":"write","model":"mock-text"}', "fresh"));
  expect(state.prompt()).toBe("write");
  expect(state.body()).toBe("fresh");
});

test("adopts a run's body while the draft is untouched", () => {
  const state = new ComposerState();
  state.sync(detail("text", "text", TEXT_JSON, "before"));
  state.sync(detail("text", "text", TEXT_JSON, "after"));

  expect(state.body()).toBe("after");
});

test("syncing inside an effect settles instead of re-arming itself", () => {
  const state = new ComposerState();
  const detailSignal = signal<NodeDetail | null>(detail("text", "text", TEXT_JSON, "before"));
  let runs = 0;
  effect(() => {
    runs += 1;
    state.sync(detailSignal());
  });
  expect(runs).toBe(1);
  expect(state.body()).toBe("before");

  detailSignal.set(detail("text", "text", TEXT_JSON, "after"));
  expect(runs).toBe(2);
  expect(state.body()).toBe("after");
});

test("keeps a user-edited body across a detail refresh", () => {
  const state = new ComposerState();
  state.sync(detail("text", "text", TEXT_JSON, "before"));
  state.setBody("my draft");
  state.sync(detail("text", "text", TEXT_JSON, "after"));

  expect(state.body()).toBe("my draft");
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
  expect(state.body()).toBe("");
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
  state.sync(detail("text", "text", '{"version":1,"prompt":"write","model":"mock-text"}'));

  expect(state.aspect()).toBe("1:1");
  expect(state.count()).toBe(1);
  state.setAspect("16:9");
  state.setCount(1);
  expect(state.aspect()).toBe("1:1");
  expect(state.count()).toBe(1);
});

test("saves the settings and only a changed body", () => {
  const state = new ComposerState();
  const current = detail("image", "image", IMAGE_JSON, "body");
  const writes: Write[] = [];
  state.sync(current);
  state.setPrompt("A quiet lake");
  state.setAspect("9:16");
  state.setCount(1);

  state.save(saver(writes), current);
  expect(writes).toEqual([
    {
      kind: "settings",
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

  state.setBody("changed");
  state.save(saver(writes), current);
  expect(writes.slice(1)).toEqual([
    {
      kind: "settings",
      id: "image",
      settings: {
        version: 1,
        prompt: "A quiet lake",
        model: "mock-image",
        aspect: "9:16",
        count: 3,
      },
    },
    { kind: "body", id: "image", text: "changed" },
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
