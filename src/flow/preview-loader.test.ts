import { expect, test } from "nsh/test";
import type { Document, NodePreview } from "@flow/native";
import type { AssetUrls } from "./asset-urls";
import { PreviewLoader, sameTargets, type PreviewHost } from "./preview-loader";
import type { PreviewTarget } from "./previews";
import type { FlowScene, PreviewView } from "./scene";

interface DocumentStub {
  previews(ids: string[]): Promise<NodePreview[]>;
}

interface SceneStub {
  previewTargets(): PreviewTarget[];
  applyPreviews(previews: readonly PreviewView[]): void;
}

/** An asset resolver that fails the test if a preview ever loads a URL. */
const assets = {
  url: async (): Promise<string | null> => {
    throw new Error("a preview with no image items must not resolve a URL");
  },
} as unknown as AssetUrls;

function stubDocument(reads: string[][]): Document {
  const stub: DocumentStub = {
    previews: async (ids) => {
      reads.push([...ids]);
      return ids.map((id) => ({ nodeId: id, itemCount: 0, items: [] }));
    },
  };
  return stub as unknown as Document;
}

function stubScene(targets: () => PreviewTarget[], applied: PreviewView[][]): FlowScene {
  const stub: SceneStub = {
    previewTargets: targets,
    applyPreviews: (previews) => applied.push([...previews]),
  };
  return stub as unknown as FlowScene;
}

function stubHost(document: Document, scene: FlowScene): PreviewHost {
  return {
    document: () => document,
    assets: () => assets,
    scene: () => scene,
    isDisposed: () => false,
  };
}

test("sameTargets compares length, order and batch ids", () => {
  const a = { id: "a", batchId: "batch-a" };
  const b = { id: "b", batchId: "batch-b" };

  expect(sameTargets(null, [])).toBe(false);
  expect(sameTargets([], [])).toBe(true);
  expect(sameTargets([a, b], [a, b])).toBe(true);
  expect(sameTargets([a, b], [b, a])).toBe(false);
  expect(sameTargets([a], [{ id: "a", batchId: "batch-b" }])).toBe(false);
});

test("an unchanged target list does not reload previews", async () => {
  const reads: string[][] = [];
  const applied: PreviewView[][] = [];
  const loader = new PreviewLoader(
    stubHost(
      stubDocument(reads),
      stubScene(() => [{ id: "a", batchId: "batch-a" }], applied),
    ),
  );

  await loader.refresh();
  await loader.refresh();

  // The second refresh bails out at the target comparison, before the load.
  expect(reads).toHaveLength(1);
  expect(applied).toHaveLength(1);
  expect(applied[0]?.length).toBe(1);
});

test("a changed target list reloads", async () => {
  const reads: string[][] = [];
  const applied: PreviewView[][] = [];
  let call = 0;
  const scene = stubScene(() => {
    call += 1;
    return call === 1
      ? [{ id: "a", batchId: "batch-a" }]
      : [
          { id: "a", batchId: "batch-a" },
          { id: "b", batchId: "batch-b" },
        ];
  }, applied);
  const loader = new PreviewLoader(stubHost(stubDocument(reads), scene));

  await loader.refresh();
  await loader.refresh();

  expect(reads).toHaveLength(2);
  expect(applied).toHaveLength(2);
  expect(applied[1]?.length).toBe(2);
});

test("an empty target list is its own early-out", async () => {
  const reads: string[][] = [];
  const applied: PreviewView[][] = [];
  const loader = new PreviewLoader(
    stubHost(
      stubDocument(reads),
      stubScene(() => [], applied),
    ),
  );

  await loader.refresh();

  // Nothing to load and nothing to publish on a cold start.
  expect(reads).toHaveLength(0);
  expect(applied).toHaveLength(0);
});

test("an emptied target list clears the previous previews", async () => {
  const reads: string[][] = [];
  const applied: PreviewView[][] = [];
  let call = 0;
  const scene = stubScene(() => {
    call += 1;
    return call === 1 ? [{ id: "a", batchId: "batch-a" }] : [];
  }, applied);
  const loader = new PreviewLoader(stubHost(stubDocument(reads), scene));

  await loader.refresh();
  await loader.refresh();

  // The batch went away: no new read, but the stale thumbnails are cleared.
  expect(reads).toHaveLength(1);
  expect(applied).toHaveLength(2);
  expect(applied[1]?.length).toBe(0);
});
