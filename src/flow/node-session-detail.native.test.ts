/**
 * The composer's detail reads against the real document: a bounds-only
 * change keeps the loaded detail, content and connector changes reload it,
 * and a late asset URL notifies its readers once.
 */
import { expect, test } from "nsh/test";
import {
  Document,
  type ChangeSet,
  type NodeDetail,
  type NodeInput,
  type NodeSummary,
  type ResultBatchInput,
  type ResultItemInput,
} from "@flow/native";
import { AssetUrls } from "./asset-urls";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "./data";
import { NodeRunner } from "./execution";
import { parseSettings } from "./node-kinds";
import { NodeSession, type AssetUrlSource, type NodeSessionHost } from "./node-session";

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

/** Counts the detail reads `loadComposer` asks its host document for. */
class CountingNodeSession extends NodeSession {
  detailReads = 0;
  nodeDetailsCompleted = 0;

  protected override async nodeDetail(id: string): Promise<NodeDetail | null> {
    const detail = await super.nodeDetail(id);
    this.detailReads += 1;
    this.nodeDetailsCompleted += 1;
    return detail;
  }
}

function makeCountingSession(
  document: Document,
  assets: AssetUrlSource,
): { session: CountingNodeSession; runner: NodeRunner } {
  const holder: { session: CountingNodeSession | null } = { session: null };
  const runner = new NodeRunner(document, {
    onChange: (set: ChangeSet) => holder.session?.onChanges(set),
    onSettled: (nodeId: string) => holder.session?.onSettled(nodeId),
  });
  const host: NodeSessionHost = {
    document: () => document,
    scene: () => null,
    assets: () => assets,
    runner: () => runner,
    pickImages: async () => [],
    applyChanges: (set) => holder.session?.onChanges(set),
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => false,
  };
  const session = new CountingNodeSession(host);
  holder.session = session;
  return { session, runner };
}

interface DeferredUrl {
  readonly promise: Promise<string | null>;
  readonly resolve: (url: string | null) => void;
  readonly settled: () => boolean;
}

/** One explicit promise boundary the test resolves when it chooses. */
function deferredUrl(onResolve: (url: string | null) => void): DeferredUrl {
  let complete: (url: string | null) => void = () => undefined;
  let done = false;
  const promise = new Promise<string | null>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    settled: () => done,
    resolve: (url) => {
      if (done) return;
      done = true;
      onResolve(url);
      complete(url);
    },
  };
}

/** An asset URL cache whose reads complete only when the test says so. */
class DeferredAssetUrls implements AssetUrlSource {
  private readonly urls = new Map<string, string>();
  private readonly deferreds = new Map<string, DeferredUrl>();
  private readonly pendingCalls = new Map<string, number>();
  private readonly completions = new Map<string, number>();

  url(id: string, _mime: string): Promise<string | null> {
    this.pendingCalls.set(id, (this.pendingCalls.get(id) ?? 0) + 1);
    const cached = this.urls.get(id);
    if (cached !== undefined) return this.track(id, Promise.resolve(cached));
    const deferred = this.deferreds.get(id) ?? this.defer(id);
    return this.track(id, deferred.promise);
  }

  get(id: string): string | null {
    return this.urls.get(id) ?? null;
  }

  /** Whether `url` was asked for this id, proving a pending read started. */
  called(id: string): boolean {
    return (this.pendingCalls.get(id) ?? 0) > 0;
  }

  /** How many `url` promises for this id have completed. */
  completionsOf(id: string): number {
    return this.completions.get(id) ?? 0;
  }

  isPending(id: string): boolean {
    return this.deferreds.get(id)?.settled() === false;
  }

  hasPending(): boolean {
    return [...this.deferreds.values()].some((deferred) => !deferred.settled());
  }

  /** Records the URL and resolves the id's pending read once. */
  resolve(id: string, url: string | null): void {
    if (url !== null) this.urls.set(id, url);
    const deferred = this.deferreds.get(id);
    if (!deferred) throw new Error(`no URL was requested for ${id}`);
    deferred.resolve(url);
  }

  /** Resolves every still-pending read null, so cleanup cannot hang. */
  settlePending(): void {
    for (const deferred of this.deferreds.values()) deferred.resolve(null);
  }

  private defer(id: string): DeferredUrl {
    const deferred = deferredUrl((url) => {
      if (url !== null) this.urls.set(id, url);
    });
    this.deferreds.set(id, deferred);
    return deferred;
  }

  private track(id: string, promise: Promise<string | null>): Promise<string | null> {
    return promise.then((url) => {
      this.completions.set(id, (this.completions.get(id) ?? 0) + 1);
      return url;
    });
  }
}

function extraTextNode(): NodeInput {
  return {
    id: "extra-source",
    kind: "text",
    title: "Extra",
    body: "",
    tags: [],
    x: 80,
    y: 400,
    width: 300,
    height: 220,
    z: 0,
  };
}

/** Gives a fresh text node an output, then connects it to `targetId`. */
async function connectWithOutput(
  document: Document,
  sourceId: string,
  targetId: string,
  edgeId: string,
): Promise<ChangeSet> {
  const batch: ResultBatchInput = {
    id: `batch-${crypto.randomUUID()}`,
    nodeId: sourceId,
    trigger: "manual",
    provider: "manual",
    model: "",
    paramsJson: "{}",
    status: "done",
  };
  const item: ResultItemInput = {
    id: `item-${crypto.randomUUID()}`,
    position: 0,
    portId: "text",
    kind: "text",
    text: "extra context",
  };
  await document.setManualText(sourceId, "extra context", batch, item);
  return document.connectEdge({
    id: edgeId,
    fromId: sourceId,
    toId: targetId,
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 110,
    toOffset: 110,
    kind: "flow",
  });
}

function changes(overrides: Partial<ChangeSet>): ChangeSet {
  return {
    rev: 1,
    changed: [],
    removed: [],
    edgesChanged: [],
    edgesRemoved: [],
    ...overrides,
  };
}

function movedOnly(summary: NodeSummary): NodeSummary {
  return { ...summary, x: summary.x + 12, y: summary.y + 8 };
}

test("a bounds-only change keeps the open composer's loaded detail", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the text composer did not open");
  const reads = session.detailReads;
  const version = session.assetVersion();

  session.onChanges(changes({ rev: 2, changed: [movedOnly(detail.node)] }));
  // A wrongly started reload would have queued its read before this barrier
  // read; both run on the document's serialized worker.
  await document.nodeDetail(TEXT_NODE_ID);
  expect(session.detailReads).toBe(reads);
  expect(session.detail()).toBe(detail);
  expect(session.assetVersion()).toBe(version);

  // An identical summary is safe too, without invalidating the detail.
  session.onChanges(changes({ rev: 3, changed: [{ ...detail.node }] }));
  await document.nodeDetail(TEXT_NODE_ID);
  expect(session.detailReads).toBe(reads);
  expect(session.detail()).toBe(detail);
  expect(session.assetVersion()).toBe(version);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a content change reloads the open composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the text composer did not open");
  const reads = session.detailReads;

  session.onChanges(
    changes({
      rev: 2,
      changed: [{ ...detail.node, body: `${detail.node.body} edited` }],
    }),
  );
  await until(() => session.detailReads === reads + 1);
  await until(() => session.detail() !== detail);
  expect(session.detail()?.node.id).toBe(TEXT_NODE_ID);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a revision-only change reloads the open composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the text composer did not open");
  const reads = session.detailReads;

  session.onChanges(
    changes({
      rev: 2,
      changed: [{ ...detail.node, rev: detail.node.rev + 1 }],
    }),
  );
  await until(() => session.detailReads === reads + 1);
  await until(() => session.detail() !== detail);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a connector touching the open card reloads its composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the image composer did not open");
  expect(detail.inputs.length).toBe(1);

  // A second upstream source, connected after the detail was read: the
  // change set's edge touches the open card, so it must reload.
  await document.insertNodes([extraTextNode()]);
  const connection = await connectWithOutput(
    document,
    "extra-source",
    IMAGE_NODE_ID,
    "extra-source-image",
  );
  expect(connection.edgesChanged.length).toBe(1);

  const reads = session.detailReads;
  session.onChanges(
    changes({
      rev: connection.rev,
      changed: [movedOnly(detail.node)],
      edgesChanged: connection.edgesChanged,
    }),
  );
  await until(() => session.detailReads === reads + 1);
  await until(() => session.detail()?.inputs.length === 2);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("an unrelated connector change keeps the open composer's detail", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail() !== null);
  const detail = session.detail();
  if (!detail) throw new Error("the text composer did not open");

  await document.insertNodes([
    extraTextNode(),
    {
      id: "unrelated-target",
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
  const connection = await document.connectEdge({
    id: "unrelated-edge",
    fromId: "extra-source",
    toId: "unrelated-target",
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 110,
    toOffset: 110,
    kind: "flow",
  });

  const reads = session.detailReads;
  session.onChanges(
    changes({
      rev: connection.rev,
      changed: [movedOnly(detail.node)],
      edgesChanged: connection.edgesChanged,
    }),
  );
  await document.nodeDetail(TEXT_NODE_ID);
  expect(session.detailReads).toBe(reads);
  expect(session.detail()).toBe(detail);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a removed connector reloads the open composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  const { session, runner } = makeCountingSession(document, assets);

  await document.insertNodes([extraTextNode()]);
  await connectWithOutput(document, "extra-source", IMAGE_NODE_ID, "extra-source-image");
  session.openComposer(IMAGE_NODE_ID);
  await until(() => session.detail()?.inputs.length === 2);
  const detail = session.detail();
  if (!detail) throw new Error("the image composer did not open");

  const removal = await document.deleteEdges(["extra-source-image"]);
  expect(removal.edgesRemoved).toEqual(["extra-source-image"]);
  const reads = session.detailReads;
  session.onChanges(
    changes({
      rev: removal.rev,
      changed: [movedOnly(detail.node)],
      edgesRemoved: ["extra-source-image"],
    }),
  );
  await until(() => session.detailReads === reads + 1);
  await until(() => session.detail()?.inputs.length === 1);

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("an asset URL that resolves after a reload notifies once", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const fake = new DeferredAssetUrls();
  const { session, runner } = makeCountingSession(document, fake);
  try {
    session.openComposer(IMAGE_NODE_ID);
    await until(() => session.detail()?.node.id === IMAGE_NODE_ID);
    const opened = session.detail();
    if (!opened) throw new Error("the image composer did not open");
    const settings = parseSettings(opened.node.kind, opened.node.settingsJson);
    if (settings.version !== 1 || !("aspect" in settings)) {
      throw new Error("the image settings are missing");
    }
    await session.run({ ...settings, count: 1 });
    await until(() => session.detail()?.batch?.items[0]?.asset?.mime === "image/svg+xml");

    const assetId = session.detail()?.batch?.items[0]?.assetId ?? null;
    if (assetId === null) throw new Error("the run produced no image asset");
    await until(() => fake.called(assetId));
    const oldVersion = session.assetVersion();
    const firstDetail = session.detail();
    if (!firstDetail) throw new Error("the run's detail disappeared");
    const completedBefore = session.nodeDetailsCompleted;

    // Two explicit content changes, one detail read each; the asset read
    // they both await stays pending until the test resolves it.
    session.onChanges(
      changes({
        rev: firstDetail.node.rev + 1,
        changed: [{ ...firstDetail.node, body: "late asset one" }],
      }),
    );
    await until(() => session.nodeDetailsCompleted === completedBefore + 1);
    const secondDetail = session.detail();
    if (!secondDetail || secondDetail === firstDetail) {
      throw new Error("the first content reload did not install its detail");
    }

    session.onChanges(
      changes({
        rev: secondDetail.node.rev + 1,
        changed: [{ ...secondDetail.node, body: "late asset two" }],
      }),
    );
    await until(() => session.nodeDetailsCompleted === completedBefore + 2);
    const thirdDetail = session.detail();
    if (!thirdDetail || thirdDetail === secondDetail) {
      throw new Error("the second content reload did not install its detail");
    }

    // The read was really requested and was pending before it resolves.
    expect(fake.called(assetId)).toBe(true);
    expect(fake.isPending(assetId)).toBe(true);
    expect(session.assetVersion()).toBe(oldVersion);

    fake.resolve(assetId, "blob:test-late");
    await until(() => session.assetVersion() === oldVersion + 1);
    expect(session.assetVersion()).toBe(oldVersion + 1);
    expect(session.assetUrls()[assetId]).toBe("blob:test-late");
    expect(fake.get(assetId)).toBe("blob:test-late");
    expect(session.detail()).toBe(thirdDetail);

    // A later load is served from the cache: its URL read completes but
    // must not notify a new version.
    const completionsBefore = fake.completionsOf(assetId);
    const completedBeforeCached = session.nodeDetailsCompleted;
    const thirdNode = thirdDetail.node;
    session.onChanges(
      changes({
        rev: thirdNode.rev + 1,
        changed: [{ ...thirdNode, body: "late asset three" }],
      }),
    );
    await until(() => session.nodeDetailsCompleted === completedBeforeCached + 1);
    await until(() => fake.completionsOf(assetId) > completionsBefore);
    expect(session.assetVersion()).toBe(oldVersion + 1);
    expect(fake.isPending(assetId)).toBe(false);
    expect(fake.hasPending()).toBe(false);
  } finally {
    fake.settlePending();
    runner.dispose();
    document.dispose();
  }
});
