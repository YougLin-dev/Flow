import { expect, test } from "nsh/test";
import type { Document, NodeSummary } from "@flow/native";
import type { FlowScene } from "./scene";
import { revealSearchHit, type RevealHost } from "./search-navigation";
import type { ViewportController } from "./viewport-controller";

function node(id: string): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: "",
    x: 10,
    y: 20,
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

interface Fixture {
  readonly host: RevealHost;
  readonly viewportCalls: string[];
  readonly sceneCalls: string[];
  readonly applied: NodeSummary[][];
}

function setup(found: NodeSummary | null, sceneIds: string[]): Fixture {
  const viewportCalls: string[] = [];
  const sceneCalls: string[] = [];
  const applied: NodeSummary[][] = [];
  const document = {
    getNode: async (id: string) => (found !== null && found.id === id ? found : null),
  } as unknown as Document;
  const scene = {
    nodes: () => sceneIds.map((id) => ({ id })),
    applyChangeSet: (changes: { changed: NodeSummary[] }) => applied.push(changes.changed),
    select: (ids: string[]) => sceneCalls.push(`select:${ids.join(",")}`),
  } as unknown as FlowScene;
  const viewport = {
    focusBounds: () => viewportCalls.push("focus"),
    refresh: async () => {
      viewportCalls.push("refresh");
    },
    schedule: () => viewportCalls.push("schedule"),
  } as unknown as ViewportController;
  return {
    host: {
      document,
      viewport,
      scene,
      isDisposed: () => false,
      openComposer: (id) => sceneCalls.push(`open:${id}`),
    },
    viewportCalls,
    sceneCalls,
    applied,
  };
}

test("reveals a hit's card, selects it and opens its composer", async () => {
  const fixture = setup(node("a"), []);

  await revealSearchHit(fixture.host, "a");

  // The scene read comes first; the card is inserted because the read did not
  // carry it, then the selection and the composer follow.
  expect(fixture.viewportCalls).toEqual(["focus", "refresh", "schedule"]);
  expect(fixture.applied).toEqual([[node("a")]]);
  expect(fixture.sceneCalls).toEqual(["select:a", "open:a"]);
});

test("does not insert a card the scene already holds", async () => {
  const fixture = setup(node("a"), ["a"]);

  await revealSearchHit(fixture.host, "a");

  expect(fixture.applied).toEqual([]);
  expect(fixture.sceneCalls).toEqual(["select:a", "open:a"]);
});

test("an unknown hit changes nothing", async () => {
  const fixture = setup(null, []);

  await revealSearchHit(fixture.host, "missing");

  expect(fixture.viewportCalls).toEqual([]);
  expect(fixture.sceneCalls).toEqual([]);
});
