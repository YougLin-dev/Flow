/**
 * The composer's detail read across teardown: a failure is reported while the
 * session lives and stays quiet once the host is disposed, because the quit
 * path closes the document under in-flight reads.
 */
import { expect, test } from "nsh/test";
import { Document, type NodeDetail } from "@flow/native";
import { AssetUrls } from "../assets/asset-urls";
import { TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { NodeSession, type NodeSessionHost } from "./node-session";

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

test("a failed detail read is reported only while the session is live", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const assets = new AssetUrls(document);
  let disposed = false;
  let attempts = 0;
  let logged = 0;
  let rejectRead: (error: Error) => void = () => undefined;
  const originalError = console.error;
  class FailingSession extends NodeSession {
    protected override nodeDetail(): Promise<NodeDetail | null> {
      attempts += 1;
      return new Promise<NodeDetail | null>((_resolve, reject) => {
        rejectRead = reject;
      });
    }
  }
  const host: NodeSessionHost = {
    document: () => document,
    scene: () => null,
    assets: () => assets,
    runner: () => null,
    pickImages: async () => [],
    applyChanges: () => undefined,
    schedulePreviews: () => undefined,
    activateNode: () => undefined,
    isDisposed: () => disposed,
  };
  const session = new FailingSession(host);
  console.error = () => {
    logged += 1;
  };
  try {
    session.openComposer(TEXT_NODE_ID);
    await until(() => attempts === 1);
    rejectRead(new Error("the read failed while the session was live"));
    await until(() => logged === 1);

    // A read already in flight when the session is disposed must stay quiet:
    // the composer is gone with it, so the failure is expected.
    logged = 0;
    session.closeComposer();
    session.openComposer(TEXT_NODE_ID);
    await until(() => attempts === 2);
    disposed = true;
    rejectRead(new Error("the database is closed"));
    // One event-loop turn lets the rejected read reach its catch.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(logged).toBe(0);
  } finally {
    console.error = originalError;
    assets.dispose();
    document.dispose();
  }
});
