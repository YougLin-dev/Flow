/**
 * A local file upload as an upload node's output. The node is a source: it
 * has no inputs, and its output ports come from the media kinds it holds.
 * The bytes go through the document's content-addressed assets and become an
 * immutable result batch, so connecting, previews and downstream snapshots
 * reuse the provider run's path. One upload replaces the node's output.
 */
import type {
  ChangeSet,
  Document,
  NodeBounds,
  ResultBatchInput,
  ResultItemInput,
} from "@flow/native";
import type { PickedImage, PickImagesOptions } from "nsh";
import { serializeSettings, type UploadSettings } from "./node-kinds";

/** The document, picker and change sink an upload needs. */
export interface UploadSourceHost {
  document(): Document | null;
  /** Shows the platform's image picker; a test host can answer it. */
  pickImages(options: PickImagesOptions): Promise<PickedImage[]>;
  isDisposed(): boolean;
  applyChanges(changes: ChangeSet): void;
  schedulePreviews(): void;
}

/** At most this many images in one upload. */
const UPLOAD_LIMIT = 16;
/** Long side to which the picker scales a large photo. */
const UPLOAD_MAX_DIMENSION = 2048;
/** JPEG quality when the picker re-encodes. */
const UPLOAD_QUALITY = 0.9;
/** The body is the files' names, kept short enough to search and sync. */
const BODY_LIMIT = 2000;
/** The card fits the image in this box, so its shape matches the image. */
const CARD_BOX = 320;
/** The smallest card the image may shrink to, so its controls stay usable. */
const CARD_MIN_WIDTH = 220;
const CARD_MIN_HEIGHT = 120;

/**
 * Picks images and writes them as the node's output batch. A cancelled pick
 * writes nothing; a partial failure commits the images that did import, and
 * an upload where every image failed records a failed batch without moving
 * the node's previous output. `onSaving` hears only the import and write, so
 * the button does not say "Saving…" while the picker is still open.
 */
export async function uploadSource(
  host: UploadSourceHost,
  nodeId: string,
  onSaving?: (saving: boolean) => void,
): Promise<void> {
  const document = host.document();
  if (document === null || host.isDisposed()) return;
  const current = await document.nodeDetail(nodeId);
  if (host.isDisposed() || current === null || current.node.kind !== "upload") return;

  let picked: PickedImage[];
  try {
    picked = await host.pickImages({
      multiple: true,
      limit: UPLOAD_LIMIT,
      maxDimension: UPLOAD_MAX_DIMENSION,
      quality: UPLOAD_QUALITY,
    });
  } catch (error) {
    console.error("Flow could not open the image picker", error);
    return;
  }
  if (picked.length === 0 || host.isDisposed()) return;

  onSaving?.(true);
  try {
    // Import concurrently; each image succeeds or fails on its own, as the
    // composer's local inputs do.
    const imported = await Promise.allSettled(picked.map((image) => importImage(document, image)));
    const items: ResultItemInput[] = [];
    const names: string[] = [];
    let cardSize: { width: number; height: number } | null = null;
    for (const result of imported) {
      if (result.status === "fulfilled") {
        if (cardSize === null) {
          cardSize = uploadCardSize({ width: result.value.width, height: result.value.height });
        }
        items.push({
          id: `item-${crypto.randomUUID()}`,
          position: items.length,
          portId: "image",
          kind: "image",
          text: "",
          assetId: result.value.assetId,
          metaJson: result.value.metaJson,
        });
        names.push(result.value.name);
      } else {
        console.error("Flow could not import an uploaded image", result.reason);
      }
    }
    if (host.isDisposed()) return;
    if (items.length === 0) {
      await recordFailure(document, nodeId, "The images could not be read", host);
      return;
    }

    // The card is fitted to the image in the same write as its output, so a
    // single undo restores the previous image and rectangle together.
    const latest = await document.getNode(nodeId);
    if (host.isDisposed() || latest === null) return;
    const bounds = cardSize === null ? null : fittedBounds(latest, nodeId, cardSize);

    const settings: UploadSettings = { version: 1, media: ["image"] };
    try {
      const changes = await document.setManualUpload(
        nodeId,
        serializeSettings(settings),
        names.join("\n").slice(0, BODY_LIMIT),
        {
          id: `batch-${crypto.randomUUID()}`,
          nodeId,
          trigger: "upload",
          provider: "local",
          model: "",
          paramsJson: JSON.stringify({ files: items.length }),
          status: "done",
        },
        items,
        bounds,
      );
      if (host.isDisposed()) return;
      host.applyChanges(changes);
      host.schedulePreviews();
    } catch (error) {
      console.error("Flow could not record the uploaded images", error);
    }
  } finally {
    onSaving?.(false);
  }
}

/**
 * The node size that shows the image whole: its aspect ratio in a
 * CARD_BOX-point box, with a floor that keeps the card's controls usable. A
 * ratio too extreme for both (a 20:1 panorama) stops at the floor, so the
 * long side stays in the box and the image is contained rather than
 * cropped. The card keeps its center when it resizes.
 */
export function uploadCardSize(size: { readonly width: number; readonly height: number }): {
  width: number;
  height: number;
} {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const fit = Math.min(CARD_BOX / width, CARD_BOX / height);
  let cardWidth = width * fit;
  let cardHeight = height * fit;
  if (cardWidth < CARD_MIN_WIDTH) {
    cardHeight = Math.min(CARD_BOX, cardHeight * (CARD_MIN_WIDTH / cardWidth));
    cardWidth = CARD_MIN_WIDTH;
  }
  if (cardHeight < CARD_MIN_HEIGHT) {
    cardWidth = Math.min(CARD_BOX, cardWidth * (CARD_MIN_HEIGHT / cardHeight));
    cardHeight = CARD_MIN_HEIGHT;
  }
  return {
    width: Math.max(1, Math.round(cardWidth)),
    height: Math.max(1, Math.round(cardHeight)),
  };
}

/** The centered rectangle for the fitted size, or null when it is the same. */
function fittedBounds(
  node: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  nodeId: string,
  size: { readonly width: number; readonly height: number },
): NodeBounds | null {
  if (Math.abs(node.width - size.width) < 0.5 && Math.abs(node.height - size.height) < 0.5) {
    return null;
  }
  return {
    id: nodeId,
    x: Math.round(node.x + node.width / 2 - size.width / 2),
    y: Math.round(node.y + node.height / 2 - size.height / 2),
    width: size.width,
    height: size.height,
  };
}

interface ImportedImage {
  readonly name: string;
  readonly assetId: string;
  readonly metaJson: string;
  readonly width: number;
  readonly height: number;
}

async function importImage(document: Document, image: PickedImage): Promise<ImportedImage> {
  const bytes = new Uint8Array(await image.file.arrayBuffer());
  const metaJson = JSON.stringify({
    width: image.size.width,
    height: image.size.height,
  });
  const name = image.file.name || "image";
  const asset = await document.importAsset({
    id: `asset-${crypto.randomUUID()}`,
    kind: "image",
    name,
    mime: image.file.type || "image/jpeg",
    bytes,
    metaJson,
  });
  return {
    name,
    assetId: asset.id,
    metaJson,
    width: image.size.width,
    height: image.size.height,
  };
}

/** Records a failed upload's batch; the node keeps its previous output. */
async function recordFailure(
  document: Document,
  nodeId: string,
  error: string,
  host: UploadSourceHost,
): Promise<void> {
  const batch: ResultBatchInput = {
    id: `batch-${crypto.randomUUID()}`,
    nodeId,
    trigger: "upload",
    provider: "local",
    model: "",
    paramsJson: "{}",
    status: "failed",
    error,
  };
  try {
    const changes = await document.saveRun(batch, []);
    if (!host.isDisposed()) host.applyChanges(changes);
  } catch (saveError) {
    console.error("Flow could not record an upload failure", saveError);
  }
}
