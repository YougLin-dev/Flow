import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "./data";
import { parseSettings } from "./node-kinds";
import { makeSession, until } from "./node-session-harness";
import { FlowScene } from "./scene";

test("runs the mock image provider and stores an immutable batch", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const settings = parseSettings(detail.node.kind, detail.node.settingsJson);
  await session.run(settings);

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  expect(after?.node.status).toBe("done");
  expect(after?.batch?.trigger).toBe("run");
  expect(after?.batch?.items.length).toBe(2);
  expect(after?.batch?.items.every((item) => item.kind === "image")).toBe(true);
  expect(after?.batch?.items[0]?.asset?.mime).toBe("image/svg+xml");
  const assetIds = new Set<string>();
  for (const item of after?.batch?.items ?? []) {
    if (item.assetId) assetIds.add(item.assetId);
  }
  for (const input of after?.inputs ?? []) {
    if (input.assetId) assetIds.add(input.assetId);
    if (input.item?.assetId) assetIds.add(input.item.assetId);
  }
  expect(assetIds.size).toBeGreaterThan(0);
  await until(() => [...assetIds].every((id) => assets.get(id) !== null));
  const firstUrls = session.assetUrls();
  const secondUrls = session.assetUrls();
  for (const id of assetIds) {
    const cached = assets.get(id);
    if (cached === null) throw new Error(`the asset URL for ${id} did not load`);
    expect(cached.startsWith("blob:")).toBe(true);
    expect(firstUrls[id]).toBe(cached);
    expect(secondUrls[id]).toBe(cached);
  }
  expect((await document.assetBytes(after?.batch?.items[0]?.assetId ?? "")).length).toBeGreaterThan(
    0,
  );

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a text run replaces the body and marks a downstream node stale", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  // Run the image first so it has an output that can become stale.
  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail() !== null);
  const image = session.detail();
  if (!image) throw new Error("the image composer did not open");
  await session.run(parseSettings(image.node.kind, image.node.settingsJson));

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const text = session.detail();
  if (!text) throw new Error("the text composer did not open");
  const settings = parseSettings(text.node.kind, text.node.settingsJson);
  await session.run(settings);

  const afterText = await document.nodeDetail(TEXT_NODE_ID);
  expect(afterText?.node.status).toBe("done");
  expect(afterText?.batch?.items[0]?.text).toContain("[Mock Text]");

  const afterImage = await document.nodeDetail(IMAGE_NODE_ID);
  expect(afterImage?.node.status).toBe("stale");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a manual body edit is an undoable text item", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.writeBody(TEXT_NODE_ID, "A new line");
  const changed = await document.nodeDetail(TEXT_NODE_ID);
  expect(changed?.node.body).toBe("A new line");
  expect(changed?.batch?.trigger).toBe("manual");
  expect(changed?.batch?.items[0]?.text).toBe("A new line");

  await document.undo();
  const restored = await document.nodeDetail(TEXT_NODE_ID);
  expect(restored?.node.body).not.toBe("A new line");
  expect(restored?.batch?.trigger).toBe("manual");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("copies a node beside it and selects the copy", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const scene = new FlowScene();
  scene.apply(await document.scene({ x: -1000, y: -1000, width: 4000, height: 4000 }, 0, 100));
  let selected: string | null = null;
  const { session, runner, assets } = makeSession(
    document,
    async () => [],
    scene,
    (nodeId) => {
      selected = nodeId;
    },
  );

  await session.copyNode(TEXT_NODE_ID);

  const copyId = selected;
  if (copyId === null) throw new Error("the copy was not selected");
  const source = scene.node(TEXT_NODE_ID);
  const copy = await document.getNode(copyId);
  if (!source || !copy) throw new Error("the copy was not inserted");
  expect(copy.id).not.toBe(source.id);
  expect(copy.kind).toBe(source.kind);
  expect(copy.title).toBe(source.title);
  expect(copy.body).toBe(source.body);
  expect(copy.settingsJson).toBe(source.settingsJson);
  expect(copy.x).toBe(source.x + 24);
  expect(copy.y).toBe(source.y + 24);
  // The copy carries no inputs, outputs or connectors of its own.
  expect(await document.count()).toBe(3);
  const after = await document.scene({ x: -1000, y: -1000, width: 4000, height: 4000 }, 0, 100);
  expect(after.edges.length).toBe(1);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("copies a node with an open composer's settings draft", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const scene = new FlowScene();
  scene.apply(await document.scene({ x: -1000, y: -1000, width: 4000, height: 4000 }, 0, 100));
  let selected: string | null = null;
  const { session, runner, assets } = makeSession(
    document,
    async () => [],
    scene,
    (nodeId) => {
      selected = nodeId;
    },
  );

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  await session.copyNodeWithDrafts(TEXT_NODE_ID, {
    version: 1,
    prompt: "Draft prompt",
    model: "mock-text",
  });

  const copyId = selected;
  if (copyId === null) throw new Error("the copy was not selected");
  const copy = await document.getNode(copyId);
  const source = await document.getNode(TEXT_NODE_ID);
  if (!copy || !source) throw new Error("the nodes were not read");
  // The draft prompt is written first, so the copy carries it; the body is
  // the seed's, since this composer never edits it.
  expect(copy.body).toBe(source.body);
  expect(copy.settingsJson).toContain("Draft prompt");
  expect(source.settingsJson).toContain("Draft prompt");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("deleting a node writes its settings draft so undo restores it", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const scene = new FlowScene();
  scene.apply(await document.scene({ x: -1000, y: -1000, width: 4000, height: 4000 }, 0, 100));
  const { session, runner, assets } = makeSession(document, async () => [], scene);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const before = await document.getNode(TEXT_NODE_ID);
  if (!before) throw new Error("the seed node is missing");
  await session.deleteNodeWithDrafts(TEXT_NODE_ID, {
    version: 1,
    prompt: "Draft prompt",
    model: "mock-text",
  });

  expect(await document.getNode(TEXT_NODE_ID)).toBe(null);
  // One undo restores the delete, carrying the draft the user saw.
  await document.undo();
  const restored = await document.getNode(TEXT_NODE_ID);
  if (!restored) throw new Error("the node did not come back");
  expect(restored.body).toBe(before.body);
  expect(restored.settingsJson).toContain("Draft prompt");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("uploads picked images as local inputs", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const { session, runner, assets } = makeSession(document, async () => [
    {
      file: {
        name: "cat.png",
        type: "image/png",
        arrayBuffer: async () => bytes.slice().buffer,
      } as unknown as File,
      size: { width: 2, height: 1 },
    },
  ]);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  await session.upload();

  const detail = await document.nodeDetail(IMAGE_NODE_ID);
  expect(detail?.inputs.length).toBe(2);
  const uploaded = detail?.inputs.find((input) => input.origin === "local");
  expect(uploaded?.kind).toBe("image");
  expect(uploaded?.portId).toBe("references");
  expect(uploaded?.asset?.name).toBe("cat.png");
  expect(uploaded?.metaJson).toBe('{"width":2,"height":1}');
  expect((await document.assetBytes(uploaded?.assetId ?? "")).length).toBe(bytes.length);

  // Removing the edge-contributed input leaves a position gap; the next
  // upload must append past the highest position, not collide with it.
  const edgeInput = detail?.inputs.find((input) => input.origin === "edge");
  expect(edgeInput).toBeDefined();
  await session.removeInput(edgeInput?.id ?? "");
  await until(() => session.detail()?.inputs.length === 1);
  await session.upload();
  await until(() => session.detail()?.inputs.length === 2);

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  expect(after?.inputs.map((input) => input.position)).toEqual([1, 2]);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("keeps the images that uploaded when another fails", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const { session, runner, assets } = makeSession(document, async () => [
    {
      file: {
        name: "cat.png",
        type: "image/png",
        arrayBuffer: async () => bytes.slice().buffer,
      } as unknown as File,
      size: { width: 1, height: 1 },
    },
    {
      file: {
        name: "broken.png",
        type: "image/png",
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          throw new Error("the picked file is unreadable");
        },
      } as unknown as File,
      size: { width: 1, height: 1 },
    },
  ]);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  await session.upload();

  const detail = await document.nodeDetail(IMAGE_NODE_ID);
  expect(detail?.inputs.length).toBe(2);
  expect(detail?.inputs.filter((input) => input.origin === "local").length).toBe(1);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("reorders and removes the composer's inputs", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const bytes = (last: number): Uint8Array => Uint8Array.from([137, 80, 78, last]);
  const picked = (name: string, last: number) => ({
    file: {
      name,
      type: "image/png",
      arrayBuffer: async () => bytes(last).buffer as ArrayBuffer,
    } as unknown as File,
    size: { width: 1, height: 1 },
  });
  const { session, runner, assets } = makeSession(document, async () => [
    picked("cat.png", 71),
    picked("dog.png", 72),
  ]);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  await session.upload();
  await until(() => session.detail()?.inputs.length === 3);

  const before = session.detail()?.inputs ?? [];
  const cat = before.find((input) => input.asset?.name === "cat.png");
  const dog = before.find((input) => input.asset?.name === "dog.png");
  if (!cat || !dog) throw new Error("the uploads did not appear");
  const edge = before.find((input) => input.origin === "edge");
  if (!edge) throw new Error("the edge input disappeared");

  await session.reorderInputs([dog.id, cat.id, edge.id]);
  await until(() => session.detail()?.inputs[0]?.id === dog.id);
  expect(session.detail()?.inputs.map((input) => input.id)).toEqual([dog.id, cat.id, edge.id]);

  await session.removeInput(cat.id);
  await until(() => session.detail()?.inputs.length === 2);
  expect(session.detail()?.inputs.some((input) => input.id === edge.id)).toBe(true);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("cancels a run and keeps the last output", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(IMAGE_NODE_ID));
  session.cancel();
  await pending;

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  if (!after) throw new Error("the image node disappeared");
  expect(after.node.status).toBe("cancelled");
  expect(after.batch).toBeNull();
  expect(after.latestBatch?.status).toBe("cancelled");
  expect(after.node.outputBatchId).toBeNull();

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("records an empty prompt as a failed run", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const settings = parseSettings(detail.node.kind, detail.node.settingsJson);
  await session.run({ ...settings, prompt: "  " });

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  if (!after) throw new Error("the image node disappeared");
  expect(after.node.status).toBe("failed");
  expect(after.batch).toBeNull();
  expect(after.latestBatch?.status).toBe("failed");
  expect(after.latestBatch?.error).toBe("Prompt cannot be empty");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("closes the composer when its node is removed", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.composerId() === TEXT_NODE_ID && session.detail() !== null);

  session.onChanges({
    rev: 1,
    changed: [],
    removed: [TEXT_NODE_ID],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(session.composerId()).toBeNull();
  expect(session.detail()).toBeNull();

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("copies an upload's output in one undoable step", async () => {
  const document = await Document.open(":memory:");
  const sourceId = "upload-source";
  await document.insertNodes([
    {
      id: sourceId,
      kind: "upload",
      title: "Upload",
      body: "",
      tags: ["upload"],
      x: 0,
      y: 0,
      width: 300,
      height: 220,
      z: 0,
      settingsJson: JSON.stringify({ version: 1, media: [] }),
    },
  ]);
  const scene = new FlowScene();
  scene.apply(await document.scene({ x: -1000, y: -1000, width: 4000, height: 4000 }, 0, 100));
  let selected: string | null = null;
  const { session, runner, assets } = makeSession(
    document,
    async () => [
      {
        file: {
          name: "cat.png",
          type: "image/png",
          arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
        } as unknown as File,
        size: { width: 2, height: 1 },
      },
    ],
    scene,
    (nodeId) => {
      selected = nodeId;
    },
  );
  await session.uploadSource(sourceId);
  await session.copyNode(sourceId);

  const copyId = selected;
  if (copyId === null) throw new Error("the copy was not selected");
  const copy = await document.nodeDetail(copyId);
  if (!copy) throw new Error("the copy was not inserted");
  expect(copy.node.settingsJson).toBe('{"version":1,"media":["image"]}');
  expect(copy.batch?.items.length).toBe(1);
  expect(copy.batch?.items[0]?.assetId).toBeTruthy();

  // One undo removes the whole copy; the source keeps its own output.
  await document.undo();
  expect(await document.getNode(copyId)).toBe(null);
  const source = await document.nodeDetail(sourceId);
  expect(source?.node.outputBatchId).not.toBe(null);
  expect(source?.batch?.items.length).toBe(1);

  // Redo brings the copy back complete, not as an empty upload card.
  await document.redo();
  const again = await document.nodeDetail(copyId);
  expect(again?.batch?.items.length).toBe(1);
  expect(again?.node.settingsJson).toBe('{"version":1,"media":["image"]}');

  runner.dispose();
  assets.dispose();
  document.dispose();
});
