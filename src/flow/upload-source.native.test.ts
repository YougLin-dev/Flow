import { expect, test } from "nsh/test";
import type { PickedImage } from "nsh";
import { Document } from "@flow/native";
import { defaultSettings, serializeSettings } from "./node-kinds";
import { makeSession, until } from "./node-session-harness";
import { uploadCardSize } from "./upload-source";

test("fits an upload card to the image's aspect ratio", () => {
  expect(uploadCardSize({ width: 2, height: 3 })).toEqual({ width: 220, height: 320 });
  expect(uploadCardSize({ width: 16, height: 9 })).toEqual({ width: 320, height: 180 });
  expect(uploadCardSize({ width: 1, height: 1 })).toEqual({ width: 320, height: 320 });
  // An extreme ratio stops at the floor: the long side stays in the 320 box
  // and the image is contained in the card instead of stretching it.
  expect(uploadCardSize({ width: 4000, height: 100 })).toEqual({ width: 320, height: 120 });
  expect(uploadCardSize({ width: 100, height: 4000 })).toEqual({ width: 220, height: 320 });
});

test("uploads a picked image as an upload node's output", async () => {
  const document = await Document.open(":memory:");
  const nodeId = "upload-source";
  await document.insertNodes([
    {
      id: nodeId,
      kind: "upload",
      title: "Upload",
      body: "",
      tags: ["upload"],
      x: 0,
      y: 0,
      width: 300,
      height: 220,
      z: 0,
      settingsJson: serializeSettings(defaultSettings("upload")),
    },
  ]);
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

  await session.uploadSource(nodeId);
  expect(session.uploadingNode()).toBe(null);

  const detail = await document.nodeDetail(nodeId);
  expect(detail?.node.settingsJson).toBe('{"version":1,"media":["image"]}');
  expect(detail?.node.body).toBe("cat.png");
  expect(detail?.node.status).toBe("done");
  // The 2×1 image makes a 320×160 card, centered where the 300×220 card was.
  expect(detail?.node.width).toBe(320);
  expect(detail?.node.height).toBe(160);
  expect(detail?.node.x).toBe(-10);
  expect(detail?.node.y).toBe(30);
  expect(detail?.batch?.trigger).toBe("upload");
  expect(detail?.batch?.provider).toBe("local");
  const item = detail?.batch?.items[0];
  expect(item?.portId).toBe("image");
  expect(item?.kind).toBe("image");
  expect(item?.asset?.name).toBe("cat.png");
  expect(item?.metaJson).toBe('{"width":2,"height":1}');
  expect((await document.assetBytes(item?.assetId ?? "")).length).toBe(bytes.length);

  // One undo removes the output and restores the card's rectangle together.
  await document.undo();
  const undone = await document.nodeDetail(nodeId);
  expect(undone?.node.settingsJson).toBe('{"version":1,"media":[]}');
  expect(undone?.node.outputBatchId).toBe(null);
  expect(undone?.node.width).toBe(300);
  expect(undone?.node.height).toBe(220);
  expect(undone?.node.x).toBe(0);
  expect(undone?.node.y).toBe(0);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("keeps an upload node's output when every new image fails", async () => {
  const document = await Document.open(":memory:");
  const nodeId = "upload-replace";
  await document.insertNodes([
    {
      id: nodeId,
      kind: "upload",
      title: "Upload",
      body: "",
      tags: ["upload"],
      x: 0,
      y: 0,
      width: 300,
      height: 220,
      z: 0,
      settingsJson: serializeSettings(defaultSettings("upload")),
    },
  ]);
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const good = async () => [
    {
      file: {
        name: "cat.png",
        type: "image/png",
        arrayBuffer: async () => bytes.slice().buffer,
      } as unknown as File,
      size: { width: 2, height: 1 },
    },
  ];
  const { session, runner, assets } = makeSession(document, good);
  await session.uploadSource(nodeId);
  const before = await document.nodeDetail(nodeId);
  const batchId = before?.batch?.id;

  // The next pick's only image cannot be read.
  const broken = makeSession(document, async () => [
    {
      file: {
        name: "broken.png",
        type: "image/png",
        arrayBuffer: async () => {
          throw new Error("the bytes are gone");
        },
      } as unknown as File,
      size: { width: 1, height: 1 },
    },
  ]);
  await broken.session.uploadSource(nodeId);

  const after = await document.nodeDetail(nodeId);
  expect(after?.node.status).toBe("failed");
  expect(after?.batch?.id).toBe(batchId);

  broken.runner.dispose();
  broken.assets.dispose();
  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("keeps the button out of Saving while the picker is open", async () => {
  const document = await Document.open(":memory:");
  const nodeId = "upload-picking";
  await document.insertNodes([
    {
      id: nodeId,
      kind: "upload",
      title: "Upload",
      body: "",
      tags: ["upload"],
      x: 0,
      y: 0,
      width: 300,
      height: 220,
      z: 0,
      settingsJson: serializeSettings(defaultSettings("upload")),
    },
  ]);
  let picking = false;
  let resolvePick: (picked: PickedImage[]) => void = () => undefined;
  const picked = new Promise<PickedImage[]>((resolve) => {
    resolvePick = resolve;
  });
  let reading = false;
  let resolveBytes: (buffer: ArrayBuffer) => void = () => undefined;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    resolveBytes = resolve;
  });
  const { session, runner, assets } = makeSession(document, () => {
    picking = true;
    return picked;
  });

  const uploading = session.uploadSource(nodeId);
  await until(() => picking);
  // The picker is open: nothing is being saved, so the button is not busy.
  expect(session.uploadingNode()).toBe(null);

  resolvePick([
    {
      file: {
        name: "cat.png",
        type: "image/png",
        arrayBuffer: () => {
          reading = true;
          return bytes;
        },
      } as unknown as File,
      size: { width: 1, height: 1 },
    },
  ]);
  await until(() => reading);
  // Picked and importing: now the button can say it is saving.
  expect(session.uploadingNode()).toBe(nodeId);

  resolveBytes(Uint8Array.from([137, 80, 78, 71]).buffer);
  await uploading;
  expect(session.uploadingNode()).toBe(null);

  runner.dispose();
  assets.dispose();
  document.dispose();
});
