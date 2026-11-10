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

interface DeferredPreview {
  readonly ids: string[];
  readonly resolve: (previews: NodePreview[]) => void;
}

function stubDeferredDocument(deferreds: DeferredPreview[]): Document {
  const stub: DocumentStub = {
    previews: (ids) =>
      new Promise((resolve) => {
        deferreds.push({ ids: [...ids], resolve });
      }),
  };
  return stub as unknown as Document;
}

function stubMutableScene(initial: PreviewTarget[]): {
  scene: FlowScene;
  applied: PreviewView[][];
  setTargets: (targets: PreviewTarget[]) => void;
} {
  const applied: PreviewView[][] = [];
  let targets = initial;
  return {
    scene: stubScene(() => targets, applied),
    applied,
    setTargets: (next) => {
      targets = next;
    },
  };
}

function stubControlledHost(
  document: Document,
  scene: FlowScene,
): { host: PreviewHost; dispose: () => void } {
  let disposed = false;
  return {
    host: {
      document: () => document,
      assets: () => assets,
      scene: () => scene,
      isDisposed: () => disposed,
    },
    dispose: () => {
      disposed = true;
    },
  };
}

function loadedPreviews(ids: string[]): NodePreview[] {
  return ids.map((id) => ({ nodeId: id, itemCount: 0, items: [] }));
}

function take(deferreds: DeferredPreview[], index: number): DeferredPreview {
  const read = deferreds[index];
  if (!read) throw new Error(`Expected preview read ${index}, found ${deferreds.length}.`);
  return read;
}

/** Deferred previews settle through loadPreviews' two async layers. */
function settleTurns(turns: number): Promise<void> {
  return turns <= 0 ? Promise.resolve() : Promise.resolve().then(() => settleTurns(turns - 1));
}

function flushRead(): Promise<void> {
  return settleTurns(12);
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

test("refreshes during one pending preview read issue one follow-up with the newest targets", async () => {
  const reads: DeferredPreview[] = [];
  const scene = stubMutableScene([{ id: "a", batchId: "batch-a" }]);
  const { host } = stubControlledHost(stubDeferredDocument(reads), scene.scene);
  const loader = new PreviewLoader(host);
  try {
    const first = loader.refresh();
    expect(reads).toHaveLength(1);
    expect(take(reads, 0).ids).toEqual(["a"]);

    scene.setTargets([
      { id: "a", batchId: "batch-a" },
      { id: "b", batchId: "batch-b" },
    ]);
    let joinedSettled = false;
    const joined = loader.refresh().then(() => {
      joinedSettled = true;
    });

    scene.setTargets([
      { id: "a", batchId: "batch-a" },
      { id: "c", batchId: "batch-c" },
    ]);
    const later = loader.refresh();

    // The joins ask for one follow-up; they do not read on their own.
    expect(reads).toHaveLength(1);
    take(reads, 0).resolve(loadedPreviews(["a"]));
    await flushRead();

    expect(reads).toHaveLength(2);
    expect(take(reads, 1).ids).toEqual(["a", "c"]);
    expect(joinedSettled).toBe(false);

    take(reads, 1).resolve(loadedPreviews(["a", "c"]));
    await Promise.all([first, joined, later]);

    expect(joinedSettled).toBe(true);
    expect(reads).toHaveLength(2);
    expect(scene.applied).toHaveLength(2);
    expect(scene.applied[1]?.length).toBe(2);
  } finally {
    loader.dispose();
  }
});

test("an unchanged target list joins an active read without a follow-up", async () => {
  const reads: DeferredPreview[] = [];
  const scene = stubMutableScene([{ id: "a", batchId: "batch-a" }]);
  const { host } = stubControlledHost(stubDeferredDocument(reads), scene.scene);
  const loader = new PreviewLoader(host);
  try {
    const first = loader.refresh();
    let joinedSettled = false;
    const joined = loader.refresh().then(() => {
      joinedSettled = true;
    });

    expect(reads).toHaveLength(1);
    expect(joinedSettled).toBe(false);

    take(reads, 0).resolve(loadedPreviews(["a"]));
    await Promise.all([first, joined]);

    expect(joinedSettled).toBe(true);
    // The joined call shared the in-flight read instead of queuing another.
    expect(reads).toHaveLength(1);
    expect(scene.applied).toHaveLength(1);

    // With no drain active, an unchanged target list is still skipped before
    // any generation increment or read.
    await loader.refresh();
    expect(reads).toHaveLength(1);
  } finally {
    loader.dispose();
  }
});

test("disposing mid-drain settles the initial and joined refreshes without a follow-up read", async () => {
  const reads: DeferredPreview[] = [];
  const scene = stubMutableScene([{ id: "a", batchId: "batch-a" }]);
  const { host, dispose } = stubControlledHost(stubDeferredDocument(reads), scene.scene);
  const loader = new PreviewLoader(host);
  try {
    const first = loader.refresh();
    scene.setTargets([{ id: "b", batchId: "batch-b" }]);
    const joined = loader.refresh();

    dispose();
    loader.dispose();
    take(reads, 0).resolve(loadedPreviews(["a"]));
    await flushRead();

    expect(reads).toHaveLength(1);
    await Promise.all([first, joined]);
  } finally {
    loader.dispose();
  }
});
