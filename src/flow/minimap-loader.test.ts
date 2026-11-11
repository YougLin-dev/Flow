import { expect, test } from "nsh/test";
import type { ChangeSet, Document, NodeSummary, Overview, OverviewCard } from "@flow/native";
import { MinimapLoader, type MinimapHost, type MinimapScheduler } from "./minimap-loader";

interface DeferredOverview {
  readonly resolve: (overview: Overview) => void;
}

function overview(rev: number, cards: OverviewCard[] = []): Overview {
  return {
    rev,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    cards,
  };
}

function card(id: string, x: number): OverviewCard {
  return { id, x, y: 0, width: 200, height: 84 };
}

function node(id: string, x: number): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: "",
    x,
    y: 0,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
  };
}

function change(rev: number, changed: NodeSummary[], removed: string[] = []): ChangeSet {
  return { rev, changed, removed, edgesChanged: [], edgesRemoved: [] };
}

function stubDocument(deferreds: DeferredOverview[]): Document {
  const stub = {
    overview: (): Promise<Overview> =>
      new Promise((resolve) => {
        deferreds.push({ resolve });
      }),
  };
  return stub as unknown as Document;
}

function stubHost(document: Document): { host: MinimapHost; dispose: () => void } {
  let disposed = false;
  return {
    host: { document: () => document, isDisposed: () => disposed },
    dispose: () => {
      disposed = true;
    },
  };
}

class FakeScheduler implements MinimapScheduler {
  delay: number | null = null;
  setTimeouts = 0;
  private callbacks = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(callback: () => void, delay: number): number {
    this.setTimeouts += 1;
    this.delay = delay;
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.callbacks.delete(id);
  }

  get armed(): number {
    return this.callbacks.size;
  }

  runDue(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

async function flushRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function publish(
  loader: MinimapLoader,
  deferreds: DeferredOverview[],
  rev: number,
  cards: OverviewCard[],
): Promise<void> {
  const read = loader.refresh();
  deferreds[deferreds.length - 1]?.resolve(overview(rev, cards));
  await read;
}

test("refresh publishes the document overview", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host } = stubHost(document);
  const loader = new MinimapLoader(host);

  expect(loader.overview()).toBe(null);
  const read = loader.refresh();
  expect(deferreds).toHaveLength(1);

  const cards = [card("a", 10)];
  deferreds[0]?.resolve(overview(3, cards));
  await read;

  expect(loader.overview()?.rev).toBe(3);
  expect(loader.overview()?.cards).toEqual(cards);
});

test("a change during a read drops the stale overview and reads once more", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host } = stubHost(document);
  const loader = new MinimapLoader(host);

  const first = loader.refresh();
  expect(deferreds).toHaveLength(1);

  // A command lands while the read is pending; the stale result is dropped
  // and the joined request causes exactly one follow-up read.
  loader.noteRev(2);
  const joined = loader.refresh();
  deferreds[0]?.resolve(overview(1));
  await flushRead();

  expect(deferreds).toHaveLength(2);
  expect(loader.overview()).toBe(null);

  deferreds[1]?.resolve(overview(2));
  await Promise.all([first, joined]);

  expect(loader.overview()?.rev).toBe(2);
  expect(deferreds).toHaveLength(2);
});

test("an unchanged overview is not published again", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host } = stubHost(document);
  const loader = new MinimapLoader(host);

  await publish(loader, deferreds, 1, [card("a", 10)]);
  const first = loader.overview();
  expect(first?.rev).toBe(1);

  // A title or status edit bumps the revision but draws the same map.
  await publish(loader, deferreds, 2, [{ ...card("a", 10) }]);

  expect(loader.overview()).toBe(first);
});

test("only a change that can move a silhouette schedules a read", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host } = stubHost(document);
  const scheduler = new FakeScheduler();
  const loader = new MinimapLoader(host, scheduler);
  await publish(loader, deferreds, 1, [card("a", 10)]);

  // Status and edge-only changes leave the silhouettes where they were.
  loader.noteChanges(change(2, [node("a", 10)]));
  loader.noteChanges(change(3, []));
  expect(scheduler.setTimeouts).toBe(0);

  // A moved card and a removed card both change the map.
  loader.noteChanges(change(4, [node("a", 40)]));
  expect(scheduler.setTimeouts).toBe(1);
  loader.noteChanges(change(5, [], ["a"]));
  expect(scheduler.setTimeouts).toBe(2);
  expect(scheduler.armed).toBe(1);
});

test("dispose drops a read that is still in flight", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host, dispose } = stubHost(document);
  const loader = new MinimapLoader(host);

  const read = loader.refresh();
  dispose();
  loader.dispose();

  deferreds[0]?.resolve(overview(1));
  await read;

  expect(loader.overview()).toBe(null);
});

test("schedule coalesces a burst of changes into one read", async () => {
  const deferreds: DeferredOverview[] = [];
  const document = stubDocument(deferreds);
  const { host } = stubHost(document);
  const scheduler = new FakeScheduler();
  const loader = new MinimapLoader(host, scheduler);

  loader.schedule();
  loader.schedule();
  loader.schedule();
  // A trailing debounce re-arms the one timer instead of adding another.
  expect(scheduler.setTimeouts).toBe(3);
  expect(scheduler.armed).toBe(1);
  expect(scheduler.delay).toBe(150);

  scheduler.runDue();
  expect(deferreds).toHaveLength(1);
  deferreds[0]?.resolve(overview(1, [card("a", 0)]));
  await flushRead();

  expect(loader.overview()?.rev).toBe(1);
});

test("a failed first read does not spin", async () => {
  const document = {
    overview: async (): Promise<Overview> => {
      throw new Error("the worker is unavailable");
    },
  } as unknown as Document;
  const { host } = stubHost(document);
  const scheduler = new FakeScheduler();
  const loader = new MinimapLoader(host, scheduler);

  await loader.refresh();

  expect(loader.overview()).toBe(null);
  expect(scheduler.armed).toBe(0);
});
