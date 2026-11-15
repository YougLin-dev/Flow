import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { parseSettings } from "../../nodes";
import { makeSession, until } from "../test/node-session-harness";
import { FlowScene } from "../../canvas/model/scene/scene";

test("runs the mock image provider and stores an immutable batch", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const parsed = parseSettings(detail.node.kind, detail.node.settingsJson);
  if (parsed.version !== 1 || !("aspect" in parsed)) throw new Error("the image settings");
  // 2K asks for the longer side at 2048; the mock sizes its images by it.
  const settings = { ...parsed, resolution: "2K" as const };
  await session.run(settings);

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  expect(after?.node.status).toBe("done");
  expect(after?.batch?.trigger).toBe("run");
  expect(after?.batch?.items.length).toBe(2);
  expect(after?.batch?.items.every((item) => item.kind === "image")).toBe(true);
  expect(after?.batch?.items[0]?.asset?.mime).toBe("image/svg+xml");
  const meta = JSON.parse(after?.batch?.items[0]?.metaJson ?? "{}") as {
    width?: number;
    height?: number;
    resolution?: string;
  };
  expect(meta.width).toBe(2048);
  expect(meta.height).toBe(1152);
  expect(meta.resolution).toBe("2K");
  expect(after?.batch?.paramsJson).toContain('"resolution":"2K"');
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
  expect(afterText?.batch?.items[0]?.text).toContain("[DeepSeek V4.1 Flash]");

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

  // Removing the prompt edge leaves a gap on its port only; the next upload
  // appends to its own references port at the next free position.
  const edgeInput = detail?.inputs.find((input) => input.origin === "edge");
  expect(edgeInput).toBeDefined();
  await session.removeInput(edgeInput?.id ?? "");
  await until(() => session.detail()?.inputs.length === 1);
  await session.upload();
  await until(() => session.detail()?.inputs.length === 2);

  const after = await document.nodeDetail(IMAGE_NODE_ID);
  expect(after?.inputs.map((input) => input.portId)).toEqual(["references", "references"]);
  expect(after?.inputs.map((input) => input.position)).toEqual([0, 1]);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("keeps the images that uploaded when another fails", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  // The broken pick comes first so a regression that stops at the first
  // rejected import leaves no image behind and fails the assertions.
  const { session, runner, assets } = makeSession(document, async () => [
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
    {
      file: {
        name: "cat.png",
        type: "image/png",
        arrayBuffer: async () => bytes.slice().buffer,
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

test("uploads several images in picker order", async () => {
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
  await until(
    () => (session.detail()?.inputs.filter((input) => input.origin === "local").length ?? 0) === 2,
  );

  const references = ((await document.nodeDetail(IMAGE_NODE_ID))?.inputs ?? []).filter(
    (input) => input.origin === "local" && input.portId === "references",
  );
  expect(references.map((input) => input.asset?.name)).toEqual(["cat.png", "dog.png"]);
  expect(references.map((input) => input.position)).toEqual([0, 1]);

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

  // Positions are per port: reorder the image references group, and leave
  // the prompt edge where it is.
  await session.reorderInputs([dog.id, cat.id]);
  await until(
    () => session.detail()?.inputs.find((input) => input.portId === "references")?.id === dog.id,
  );
  const references = (session.detail()?.inputs ?? []).filter(
    (input) => input.portId === "references",
  );
  expect(references.map((input) => input.id)).toEqual([dog.id, cat.id]);

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

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const opened = session.detail();
  if (!opened) throw new Error("the composer did not open");
  await session.run(parseSettings(opened.node.kind, opened.node.settingsJson));
  const done = await document.nodeDetail(TEXT_NODE_ID);
  const output = done?.batch;
  if (!done || !output) throw new Error("the first run stored no output");
  expect(done.node.status).toBe("done");

  // A second run cancelled mid-flight records its batch but keeps the first
  // run's output, body and status line.
  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not reopen");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  session.cancel();
  await pending;

  const after = await document.nodeDetail(TEXT_NODE_ID);
  if (!after) throw new Error("the text node disappeared");
  expect(after.node.status).toBe("cancelled");
  expect(after.batch?.id).toBe(output.id);
  expect(after.node.outputBatchId).toBe(output.id);
  expect(after.node.body).toBe(done.node.body);
  expect(after.latestBatch?.status).toBe("cancelled");
  expect(after.latestBatch?.error).toBeNull();

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("disposing the runner mid-run leaves the batch for startup recovery", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  runner.dispose();
  await pending;

  // The app is closing, so the runner leaves the run open for the next open
  // to settle rather than writing through a database that may be gone.
  const abandoned = await document.nodeDetail(TEXT_NODE_ID);
  expect(abandoned?.node.status).toBe("running");
  expect(abandoned?.latestBatch?.status).toBe("running");

  expect(await document.recoverRuns()).toBeGreaterThan(0);
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.status).toBe("interrupted");
  expect(after?.latestBatch?.status).toBe("interrupted");

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
