/**
 * The composer's input commands: removing and reordering an input and
 * importing the images the platform picker returned. They write through the
 * document and report changes to the session; they hold no state.
 */
import type { PickedImage, PickImagesOptions } from "nsh";
import type { ChangeSet, Document } from "../../shared";

/** The document and callbacks an input command needs. */
export interface InputCommandHost {
  document(): Document | null;
  pickImages(options: PickImagesOptions): Promise<PickedImage[]>;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
  isDisposed(): boolean;
}

/** Removes one input and refreshes the previews it fed. */
export async function removeInput(host: InputCommandHost, inputId: string): Promise<void> {
  const document = host.document();
  if (!document || host.isDisposed()) return;
  try {
    const changes = await document.removeInput(inputId);
    if (host.isDisposed()) return;
    host.applyChanges(changes);
    host.schedulePreviews();
  } catch (error) {
    console.error("Flow could not remove the input", error);
  }
}

/** Rewrites one node's input order. */
export async function reorderInputs(
  host: InputCommandHost,
  composerId: () => string | null,
  ids: string[],
): Promise<void> {
  const document = host.document();
  const id = composerId();
  if (!document || !id || host.isDisposed()) return;
  try {
    const changes = await document.reorderInputs(id, ids);
    if (host.isDisposed()) return;
    host.applyChanges(changes);
  } catch (error) {
    console.error("Flow could not reorder the inputs", error);
  }
}

/** Imports the picked images and appends them as the open card's inputs. */
export async function uploadInputs(
  host: InputCommandHost,
  composerId: () => string | null,
): Promise<void> {
  const document = host.document();
  const id = composerId();
  if (!document || !id || host.isDisposed()) return;
  try {
    const picked = await host.pickImages({
      multiple: true,
      limit: 4,
      maxDimension: 2048,
      quality: 0.9,
    });
    // Read and import concurrently, then append in picker order: the
    // document assigns each input the next position on its port, so the
    // worker order is the display order. A failed import or append is
    // isolated so the images that did import still commit.
    const imports = await Promise.allSettled(
      picked.map(async (image) => {
        const bytes = new Uint8Array(await image.file.arrayBuffer());
        const metaJson = JSON.stringify({
          width: image.size.width,
          height: image.size.height,
        });
        const asset = await document.importAsset({
          id: `asset-${crypto.randomUUID()}`,
          kind: "image",
          name: image.file.name || "image",
          mime: image.file.type || "image/jpeg",
          bytes,
          metaJson,
        });
        return { asset, metaJson };
      }),
    );
    if (host.isDisposed()) return;
    let appends = Promise.resolve();
    for (const result of imports) {
      if (result.status === "rejected") {
        console.error("Flow could not upload an image", result.reason);
        continue;
      }
      appends = appends.then(async () => {
        if (host.isDisposed()) return;
        try {
          const changes = await document.addInput({
            id: `input-${crypto.randomUUID()}`,
            nodeId: id,
            portId: "references",
            kind: "image",
            origin: "local",
            assetId: result.value.asset.id,
            text: "",
            metaJson: result.value.metaJson,
          });
          if (!host.isDisposed()) host.applyChanges(changes);
        } catch (error) {
          console.error("Flow could not upload an image", error);
        }
      });
    }
    await appends;
    if (host.isDisposed()) return;
    host.schedulePreviews();
  } catch (error) {
    console.error("Flow could not upload an image", error);
  }
}
