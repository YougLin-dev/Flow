import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { parseSettings } from "../../nodes";
import { makeSession, until } from "../test/node-session-harness";

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
