/**
 * The composer uploads images concurrently but appends them in picker order,
 * because the document assigns the next position on the port as each append
 * lands. One failed import must not stop the images picked after it.
 */
import { expect, test } from "nsh/test";
import type { PickedImage } from "nsh";
import type { ChangeSet, Document } from "@flow/native";
import type { NodeSessionHost } from "./node-session";
import { NodeSession } from "./node-session";

const EMPTY: ChangeSet = {
  rev: 0,
  changed: [],
  removed: [],
  edgesChanged: [],
  edgesRemoved: [],
};

function pick(name: string): PickedImage {
  return {
    file: {
      name,
      type: "image/png",
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    } as unknown as File,
    size: { width: 1, height: 1 },
  };
}

function host(document: Document, picks: readonly PickedImage[]): NodeSessionHost {
  return {
    document: () => document,
    scene: () => null,
    assets: () => null,
    runner: () => null,
    pickImages: async () => [...picks],
    applyChanges: () => undefined,
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => false,
  };
}

test("appends uploads in picker order when a later image imports first", async () => {
  const appended: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondImported: () => void = () => undefined;
  const secondDone = new Promise<void>((resolve) => {
    secondImported = resolve;
  });
  const document = {
    async importAsset(input: { name: string }): Promise<{ id: string }> {
      if (input.name === "first.png") {
        await firstGate;
      } else {
        secondImported();
      }
      return { id: `asset-${input.name}` };
    },
    async addInput(input: { assetId?: string | null }): Promise<ChangeSet> {
      appended.push(input.assetId ?? "");
      return EMPTY;
    },
  } as unknown as Document;

  const session = new NodeSession(host(document, [pick("first.png"), pick("second.png")]));
  session.composerId.set("image");

  const uploading = session.upload();
  await secondDone;
  releaseFirst();
  await uploading;

  expect(appended).toEqual(["asset-first.png", "asset-second.png"]);
});

test("keeps appending the images picked after a failed import", async () => {
  const appended: string[] = [];
  const document = {
    async importAsset(input: { name: string }): Promise<{ id: string }> {
      if (input.name === "broken.png") throw new Error("unreadable");
      return { id: `asset-${input.name}` };
    },
    async addInput(input: { assetId?: string | null }): Promise<ChangeSet> {
      appended.push(input.assetId ?? "");
      return EMPTY;
    },
  } as unknown as Document;

  const session = new NodeSession(
    host(document, [pick("cat.png"), pick("broken.png"), pick("dog.png")]),
  );
  session.composerId.set("image");

  await session.upload();

  expect(appended).toEqual(["asset-cat.png", "asset-dog.png"]);
});
