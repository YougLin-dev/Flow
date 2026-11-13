/**
 * The shared host for the node-session native tests: a document, the asset
 * URL cache, the runner and a session wired the way the page wires them.
 */
import type { ChangeSet, Document } from "@flow/native";
import { AssetUrls } from "./asset-urls";
import { NodeRunner } from "./execution";
import { NodeSession, type NodeSessionHost } from "./node-session";
import type { FlowScene } from "./scene";

/** Polls native async work: `app.waitUntil` only exists in an app test. */
export function until(check: () => boolean, timeout = 5000): Promise<void> {
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

/** A session over `document`, with the picker and scene a test supplies. */
export function makeSession(
  document: Document,
  pickImages: NodeSessionHost["pickImages"] = async () => [],
  scene: FlowScene | null = null,
  activated?: (nodeId: string) => void,
): {
  session: NodeSession;
  runner: NodeRunner;
  assets: AssetUrls;
} {
  const assets = new AssetUrls(document);
  const holder: { session: NodeSession | null } = { session: null };
  const runner = new NodeRunner(document, {
    onChange: (changes: ChangeSet) => holder.session?.onChanges(changes),
    onSettled: (nodeId: string) => holder.session?.onSettled(nodeId),
  });
  const host: NodeSessionHost = {
    document: () => document,
    scene: () => scene,
    assets: () => assets,
    runner: () => runner,
    pickImages,
    applyChanges: (changes) => {
      holder.session?.onChanges(changes);
      scene?.applyChangeSet(changes);
    },
    schedulePreviews: () => undefined,
    activateNode: (nodeId) => activated?.(nodeId),
    isDisposed: () => false,
  };
  const session = new NodeSession(host);
  holder.session = session;
  return { session, runner, assets };
}
