import { expect, test } from "nsh/test";
import { CLOSE_FAILED_AFTER_STOP, shutdownWorkspace, type ShutdownPorts } from "./shutdown";

function ports(
  events: string[],
  view: ShutdownPorts["view"],
  finish: () => Promise<void> = async () => {},
): ShutdownPorts {
  return {
    runner: {
      stop: async () => {
        events.push("stop");
      },
    },
    document: {
      closeWithView: async (x, y, zoom) => {
        events.push(`closeWithView:${x},${y},${zoom}`);
        await finish();
      },
      close: async () => {
        events.push("close");
      },
      dispose: () => events.push("dispose"),
    },
    view,
    stopConsumers: () => events.push("consumers"),
  };
}

test("stops runs, saves the view and closes in that order", async () => {
  const events: string[] = [];
  const result = await shutdownWorkspace(ports(events, { x: 120, y: -40, zoom: 2.5 }));
  expect(events).toEqual(["stop", "consumers", "closeWithView:120,-40,2.5", "dispose"]);
  expect(result.closed).toBe(true);
});

test("closes without a view when no stage size arrived", async () => {
  const events: string[] = [];
  const result = await shutdownWorkspace(ports(events, null));
  expect(events).toEqual(["stop", "consumers", "close", "dispose"]);
  expect(result.closed).toBe(true);
});

test("disposes the handle even when the close fails", async () => {
  const events: string[] = [];
  const failing = ports(events, { x: 1, y: 2, zoom: 1 }, async () => {
    throw new Error("the package is busy");
  });
  const result = await shutdownWorkspace(failing);
  expect(events).toEqual(["stop", "consumers", "closeWithView:1,2,1", "dispose"]);
  expect(result.closed).toBe(false);
});

test("reports closed when the worker stopped despite a recovery warning", async () => {
  const events: string[] = [];
  const warned = ports(events, { x: 1, y: 2, zoom: 1 }, async () => {
    throw new Error(`${CLOSE_FAILED_AFTER_STOP}the write-ahead log is still busy`);
  });
  const result = await shutdownWorkspace(warned);
  expect(events).toEqual(["stop", "consumers", "closeWithView:1,2,1", "dispose"]);
  expect(result.closed).toBe(true);
  expect(CLOSE_FAILED_AFTER_STOP).toBe("the document closed with a recovery warning: ");
});

test("reports not closed when there was no document", async () => {
  const events: string[] = [];
  const result = await shutdownWorkspace({
    runner: null,
    document: null,
    view: null,
    stopConsumers: () => events.push("consumers"),
  });
  expect(events).toEqual(["consumers"]);
  expect(result.closed).toBe(false);
});
