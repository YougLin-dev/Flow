import { expect, test } from "nsh/test";
import { Document, type ChangeSet } from "@flow/native";
import { AssetUrls } from "./asset-urls";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "./data";
import { NodeRunner } from "./execution";
import { parseSettings } from "./node-kinds";
import { NodeSession, type NodeSessionHost } from "./node-session";
import { FlowScene } from "./scene";

/** Polls native async work: `app.waitUntil` only exists in an app test. */
function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) {
        resolve();
      } else if (Date.now() - started > timeout) {
        reject(new Error("the condition never held"));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

function makeSession(
  document: Document,
  pickImages: NodeSessionHost["pickImages"] = async () => [],
  scene: FlowScene | null = null,
): {
  session: NodeSession;
  runner: NodeRunner;
  assets: AssetUrls;
} {
  const assets = new AssetUrls(document);
  const holder: { session: NodeSession | null } = { session: null };
  const runner = new NodeRunner(document, {
    onChange: (changes: ChangeSet) => holder.session?.onChanges(changes),
    onSettled: (nodeId: string) => holder.session?.onSettled(nodeId),
  });
  const host: NodeSessionHost = {
    document: () => document,
    scene: () => scene,
    assets: () => assets,
    runner: () => runner,
    pickImages,
    applyChanges: (changes) => holder.session?.onChanges(changes),
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => false,
  };
  const session = new NodeSession(host);
  holder.session = session;
  return { session, runner, assets };
}

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
  await until(() => Object.keys(session.assetUrls()).length > 0);
  expect(Object.keys(session.assetUrls()).length).toBeGreaterThan(0);
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

  await session.commitBody(TEXT_NODE_ID, "A new line");
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

test("edits a text node inline and closes the editor on save", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  expect(session.inlineText()).toBe((await document.getNode(TEXT_NODE_ID))?.body);

  await session.commitBody(TEXT_NODE_ID, "An inline edit");
  expect(session.inlineId()).toBeNull();
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.body).toBe("An inline edit");
  expect(after?.batch?.items[0]?.text).toBe("An inline edit");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("double-clicking a non-text node opens its composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(IMAGE_NODE_ID);
  await until(() => session.composerId() === IMAGE_NODE_ID && session.detail() !== null);
  expect(session.inlineId()).toBeNull();
  expect(session.detail()?.node.kind).toBe("image");

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

test("connects several sources in one undo step", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const extra = "extra-text";
  const target = "group-target";
  await document.insertNodes([
    {
      id: extra,
      kind: "text",
      title: "Extra",
      body: "",
      tags: [],
      x: 80,
      y: 400,
      width: 300,
      height: 220,
      z: 0,
    },
    {
      id: target,
      kind: "text",
      title: "Target",
      body: "",
      tags: [],
      x: 520,
      y: 400,
      width: 300,
      height: 220,
      z: 0,
    },
  ]);
  const scene = new FlowScene();
  scene.apply(
    await document.scene({ x: -100_000, y: -100_000, width: 200_000, height: 200_000 }, 1000),
  );
  const { session, runner, assets } = makeSession(document, async () => [], scene);

  await session.connectNodes([
    { fromId: TEXT_NODE_ID, toId: target },
    { fromId: extra, toId: target },
  ]);

  // The seed edge plus the two group edges; the seeded text node contributes
  // one snapshotted input, the extra node none.
  expect(await document.edgeCount()).toBe(3);
  expect((await document.nodeDetail(target))?.inputs.length).toBe(1);

  // One undo removes the whole group connection.
  await document.undo();
  expect(await document.edgeCount()).toBe(1);
  expect((await document.nodeDetail(target))?.inputs.length).toBe(0);

  runner.dispose();
  assets.dispose();
  document.dispose();
});
