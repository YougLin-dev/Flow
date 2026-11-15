import { expect, test } from "nsh/test";
import { openFlowDocument } from "./document-session";

test("opens, seeds and reports a new package as clean", async () => {
  const opened = await openFlowDocument(":memory:");
  const { document, info } = opened;
  try {
    expect(info.openedClean).toBe(true);
    expect(info.demoSeeded).toBe(true);
    expect(info.nodeCount).toBe(2);
    expect(info.cameraX).toBe(0);
    expect(info.cameraY).toBe(0);
    expect(info.cameraZoom).toBe(1);
    expect(await document.count()).toBe(2);
  } finally {
    await document.close();
    document.dispose();
  }
});
