import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { makeSession, until } from "../test/node-session-harness";
import { FlowScene } from "../../canvas/model/scene/scene";

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
