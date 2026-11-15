import { expect, test } from "nsh/test";
import { ComposerState } from "../../../flow/composer";
import type { NodeSettings } from "../../../flow/nodes";
import type { NodeDetail, NodeSummary } from "../../../flow/shared";
import { saveOpenDrafts, type DraftSession } from "./save-drafts";

function detail(): NodeDetail {
  const node: NodeSummary = {
    id: "n",
    kind: "text",
    title: "n",
    body: "",
    x: 0,
    y: 0,
    width: 300,
    height: 220,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: '{"version":1,"prompt":"old","model":"mock-text"}',
    status: "idle",
    outputBatchId: null,
  };
  return { node, batch: null, latestBatch: null, inputs: [], incoming: [] };
}

function promptOf(settings: NodeSettings): string {
  return settings.version === 1 && "prompt" in settings ? settings.prompt : "";
}

test("saves the composer draft, closes it, then waits for the inline write", async () => {
  const calls: string[] = [];
  let releaseInline: () => void = () => {};
  const session: DraftSession = {
    detail,
    saveSettings: async (id, settings) => {
      calls.push(`save ${id} ${promptOf(settings)}`);
    },
    closeComposer: () => calls.push("close"),
    commitInline: () =>
      new Promise<void>((resolve) => {
        calls.push("inline");
        releaseInline = resolve;
      }),
  };
  const state = new ComposerState();
  state.sync(detail());
  state.setPrompt("typed");

  let settled = false;
  const done = saveOpenDrafts(session, state).then(() => {
    settled = true;
  });
  expect(calls).toEqual(["save n typed", "close", "inline"]);
  expect(settled).toBe(false);
  expect(state.settings()).toBe(null);

  releaseInline();
  await done;
  expect(settled).toBe(true);
});

test("a close before the document opened saves nothing", async () => {
  const state = new ComposerState();
  await saveOpenDrafts(null, state);
  expect(state.settings()).toBe(null);
});
