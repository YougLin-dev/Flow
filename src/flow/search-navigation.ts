/** Opening a search hit: fit its card, load it into the scene, select it. */
import type { Document } from "@flow/native";
import type { FlowScene } from "./scene";
import type { ViewportController } from "./viewport-controller";

export interface RevealHost {
  readonly document: Document | null;
  readonly viewport: ViewportController;
  readonly scene: FlowScene;
  readonly isDisposed: () => boolean;
  readonly openComposer: (id: string) => void;
}

/** Fits the card behind a search hit, then selects it and opens it. */
export async function revealSearchHit(host: RevealHost, id: string): Promise<void> {
  const document = host.document;
  if (!document || host.isDisposed()) return;
  try {
    const node = await document.getNode(id);
    if (!node || host.isDisposed()) return;
    const { viewport, scene } = host;
    viewport.focusBounds({ x: node.x, y: node.y, width: node.width, height: node.height });
    await viewport.refresh();
    if (host.isDisposed()) return;
    // The read may land before the scene does; the hit's card must exist.
    if (!scene.nodes().some((candidate) => candidate.id === id)) {
      scene.applyChangeSet({
        changed: [node],
        removed: [],
        edgesChanged: [],
        edgesRemoved: [],
      });
    }
    scene.select([id]);
    host.openComposer(id);
    viewport.schedule();
  } catch (error) {
    console.error("Flow could not reveal the search result", error);
  }
}
