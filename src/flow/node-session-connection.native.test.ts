/**
 * Typed-port connection batches through the node session: several pairs in
 * one undo step, whole-batch capacity rejection, and illegal pairs skipping.
 */
import { expect, test } from "nsh/test";
import { Document, type ChangeSet } from "@flow/native";
import { AssetUrls } from "./asset-urls";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "./data";
import { NodeRunner } from "./execution";
import { NodeSession, type NodeSessionHost } from "./node-session";
import { FlowScene } from "./scene";

function makeSession(
  document: Document,
  pickImages: NodeSessionHost["pickImages"],
  scene: FlowScene,
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
    applyChanges: (changes) => {
      // Mirror the page: the scene reflects every command before the session
      // hears of it.
      scene.applyChangeSet(changes);
      holder.session?.onChanges(changes);
    },
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => false,
  };
  const session = new NodeSession(host);
  holder.session = session;
  return { session, runner, assets };
}

async function openScene(document: Document): Promise<FlowScene> {
  const scene = new FlowScene();
  scene.apply(
    await document.scene({ x: -100_000, y: -100_000, width: 200_000, height: 200_000 }, 1000, 2000),
  );
  return scene;
}

test("connects several sources in one undo step", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const extra = "extra-text";
  const target = "group-target";
  const second = "group-target-2";
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
    {
      id: second,
      kind: "text",
      title: "Second target",
      body: "",
      tags: [],
      x: 520,
      y: 700,
      width: 300,
      height: 220,
      z: 0,
    },
  ]);
  const scene = await openScene(document);
  const { session, runner, assets } = makeSession(document, async () => [], scene);

  // A prompt accepts one edge, so each source fans out to its own target;
  // the batch is still one undo step.
  await session.connectNodes([
    {
      fromId: TEXT_NODE_ID,
      fromPort: "text",
      toId: target,
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
    {
      fromId: extra,
      fromPort: "text",
      toId: second,
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
  ]);

  // The seed edge plus the two group edges; the seeded text node contributes
  // one snapshotted input, the extra node none.
  expect(await document.edgeCount()).toBe(3);
  expect((await document.nodeDetail(target))?.inputs.length).toBe(1);
  expect((await document.nodeDetail(second))?.inputs.length).toBe(0);

  // One undo removes the whole group connection.
  await document.undo();
  expect(await document.edgeCount()).toBe(1);
  expect((await document.nodeDetail(target))?.inputs.length).toBe(0);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("rejects a whole group when one target port is full", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const extra = "full-extra";
  const target = "full-target";
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
  const scene = await openScene(document);
  const { session, runner, assets } = makeSession(document, async () => [], scene);

  // The seed edge already fills the image node's prompt; the second pair
  // would fit, but one full port rejects the batch before any write.
  await session.connectNodes([
    {
      fromId: extra,
      fromPort: "text",
      toId: IMAGE_NODE_ID,
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
    {
      fromId: TEXT_NODE_ID,
      fromPort: "text",
      toId: target,
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
  ]);

  expect(await document.edgeCount()).toBe(1);
  expect((await document.nodeDetail(target))?.inputs.length).toBe(0);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("skips mismatched and unknown port pairs", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const extra = "mismatch-extra";
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
  ]);
  const scene = await openScene(document);
  const { session, runner, assets } = makeSession(document, async () => [], scene);

  // A text output never enters an image input, and unknown ids connect nothing.
  await session.connectNodes([
    {
      fromId: extra,
      fromPort: "text",
      toId: IMAGE_NODE_ID,
      toPort: "references",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
    {
      fromId: extra,
      fromPort: "missing",
      toId: IMAGE_NODE_ID,
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
  ]);

  expect(await document.edgeCount()).toBe(1);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("reconnect rejects duplicate pairs, self connections and full ports", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const ids = ["reconnect-t1", "reconnect-t2", "reconnect-t3", "reconnect-t4", "reconnect-s"];
  await document.insertNodes(
    ids.map((id, index) => ({
      id,
      kind: "text",
      title: id,
      body: "",
      tags: [],
      x: -300 + (index % 3) * 500,
      y: 400 + Math.floor(index / 3) * 300,
      width: 300,
      height: 220,
      z: 0,
    })),
  );
  const scene = await openScene(document);
  const { session, runner, assets } = makeSession(document, async () => [], scene);
  const pair = (toId: string) => ({
    fromId: TEXT_NODE_ID,
    fromPort: "text",
    toId,
    toPort: "prompt",
    portKind: "text" as const,
    fromOffset: 46,
    toOffset: 46,
  });

  await session.connectNodes([pair("reconnect-t1"), pair("reconnect-t2")]);
  await session.connectNodes([
    {
      fromId: "reconnect-s",
      fromPort: "text",
      toId: "reconnect-t3",
      toPort: "prompt",
      portKind: "text",
      fromOffset: 46,
      toOffset: 46,
    },
  ]);
  expect(await document.edgeCount()).toBe(4);

  const first = scene
    .edges()
    .find((edge) => edge.fromId === TEXT_NODE_ID && edge.toId === "reconnect-t1");
  if (!first) throw new Error("the first edge is in the scene");

  // A pair that already exists is never rewritten.
  await session.reconnectEdge(first.id, pair("reconnect-t2"));
  expect(await document.edgeCount()).toBe(4);

  // A node cannot connect to itself.
  await session.reconnectEdge(first.id, pair(TEXT_NODE_ID));
  expect(await document.edgeCount()).toBe(4);

  // t3's single prompt slot is taken by another source: the reconnect is
  // rejected instead of overfilling the port.
  await session.reconnectEdge(first.id, pair("reconnect-t3"));
  expect(await document.edgeCount()).toBe(4);

  // A free target takes the edge in place.
  await session.reconnectEdge(first.id, pair("reconnect-t4"));
  expect(await document.edgeCount()).toBe(4);
  expect((await document.nodeDetail("reconnect-t4"))?.inputs.length).toBe(1);
  expect((await document.nodeDetail("reconnect-t1"))?.incoming.length).toBe(0);

  runner.dispose();
  assets.dispose();
  document.dispose();
});
