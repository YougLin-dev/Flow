import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { IMAGE_NODE_ID, seedDocument } from "../lifecycle/seed";
import { makeSession, until } from "../test/node-session-harness";

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
