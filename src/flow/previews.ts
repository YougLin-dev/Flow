import type { Document } from "@flow/native";
import type { AssetUrls } from "./asset-urls";
import type { PreviewView } from "./scene";

export interface PreviewTarget {
  readonly id: string;
  readonly batchId: string;
}

/**
 * Reads the current items of the visible image nodes and turns their asset
 * bytes into URLs for the cards. Text nodes use their body instead.
 */
export async function loadPreviews(
  document: Document,
  assets: AssetUrls,
  targets: readonly PreviewTarget[],
): Promise<PreviewView[]> {
  if (targets.length === 0) return [];
  const previews = await document.previews(targets.map((target) => target.id));
  return Promise.all(
    previews.map(async (preview): Promise<PreviewView> => {
      const urls = await Promise.all(
        preview.items.map(async (item) => {
          if (item.kind !== "image" || !item.assetId || !item.asset) return null;
          return assets.url(item.assetId, item.asset.mime);
        }),
      );
      return {
        nodeId: preview.nodeId,
        urls: urls.filter((url): url is string => url !== null),
        count: preview.itemCount,
      };
    }),
  );
}
