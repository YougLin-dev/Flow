import { expect, test } from "nsh/test";
import { shutdownWorkspace, type ShutdownPorts } from "./shutdown";

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
  await shutdownWorkspace(ports(events, { x: 120, y: -40, zoom: 2.5 }));
  expect(events).toEqual(["stop", "consumers", "closeWithView:120,-40,2.5", "dispose"]);
});

test("closes without a view when no stage size arrived", async () => {
  const events: string[] = [];
  await shutdownWorkspace(ports(events, null));
  expect(events).toEqual(["stop", "consumers", "close", "dispose"]);
});

test("disposes the handle even when the close fails", async () => {
  const events: string[] = [];
  const failing = ports(events, { x: 1, y: 2, zoom: 1 }, async () => {
    throw new Error("the package is busy");
  });
  await shutdownWorkspace(failing);
  expect(events).toEqual(["stop", "consumers", "closeWithView:1,2,1", "dispose"]);
});
