/**
 * The settings save tells Rust which port ids the new settings declare, so a
 * setting that removes a port can remove the edges that used it in the same
 * undo step. The open detail names the kind; a draft saved without one falls
 * back to the settings shape.
 */
import { expect, test } from "nsh/test";
import type { ChangeSet, Document, NodeDetail, NodeSummary } from "@flow/native";
import type { NodeSessionHost } from "./node-session";
import { NodeSession } from "./node-session";

interface Write {
  readonly id: string;
  readonly json: string;
  readonly ports: readonly string[] | null;
}

const EMPTY: ChangeSet = {
  rev: 0,
  changed: [],
  removed: [],
  edgesChanged: [],
  edgesRemoved: [],
};

class RecordingDocument {
  readonly writes: Write[] = [];

  async setNodeSettings(id: string, json: string, ports?: string[] | null): Promise<ChangeSet> {
    this.writes.push({ id, json, ports: ports ? [...ports] : null });
    return EMPTY;
  }
}

function host(document: Document): NodeSessionHost {
  return {
    document: () => document,
    scene: () => null,
    assets: () => null,
    runner: () => null,
    pickImages: async () => [],
    applyChanges: () => undefined,
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => false,
  };
}

function detail(id: string, kind: string, settingsJson: string): NodeDetail {
  const node: NodeSummary = {
    id,
    kind,
    title: id,
    body: "",
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

function session(recorder: RecordingDocument): NodeSession {
  return new NodeSession(host(recorder as unknown as Document));
}

test("sends the input and output ports of the new text settings", async () => {
  const recorder = new RecordingDocument();
  const nodeSession = session(recorder);
  nodeSession.detail.set(detail("n", "text", '{"version":1,"prompt":"old","model":"mock-text"}'));

  await nodeSession.saveSettings("n", {
    version: 1,
    prompt: "new",
    model: "mock-text",
  });

  expect(recorder.writes).toHaveLength(1);
  expect(recorder.writes[0].ports).toEqual(["prompt", "references", "text"]);
});

test("sends the ports of an image draft without an open detail", async () => {
  const recorder = new RecordingDocument();
  const nodeSession = session(recorder);

  await nodeSession.saveSettings("n", {
    version: 1,
    prompt: "new",
    model: "mock-image",
    aspect: "1:1",
    resolution: "1K",
    count: 1,
  });

  expect(recorder.writes[0].ports).toEqual(["prompt", "references", "image"]);
});

test("an upload draft sends only the media it declares", async () => {
  const recorder = new RecordingDocument();
  const nodeSession = session(recorder);

  await nodeSession.saveSettings("n", { version: 1, media: ["image"] });

  expect(recorder.writes[0].ports).toEqual(["image"]);
});

test("a kind this build does not know sends no port list", async () => {
  const recorder = new RecordingDocument();
  const nodeSession = session(recorder);
  nodeSession.detail.set(
    detail("n", "future-kind", '{"version":1,"prompt":"old","model":"mock-text"}'),
  );

  await nodeSession.saveSettings("n", {
    version: 1,
    prompt: "new",
    model: "mock-text",
  });

  expect(recorder.writes[0].ports).toBeNull();
});

test("an unchanged settings draft writes nothing", async () => {
  const recorder = new RecordingDocument();
  const nodeSession = session(recorder);
  const json = '{"version":1,"prompt":"same","model":"mock-text"}';
  nodeSession.detail.set(detail("n", "text", json));

  await nodeSession.saveSettings("n", {
    version: 1,
    prompt: "same",
    model: "mock-text",
  });

  expect(recorder.writes).toHaveLength(0);
});
