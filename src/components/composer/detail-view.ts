/**
 * The composer's view helpers: the failed run's error line and the asset URL
 * an input item shows. The reload policy lives in
 * `flow/document/session/composer-detail.ts`; these helpers stay with the
 * composer views.
 */
import type { InputItemSummary, NodeDetail } from "../../flow/shared";

/** The failed run's error line for a detail, empty when it has none. */
export function errorOf(detail: NodeDetail): string {
  if (detail.node.status !== "failed") return "";
  return detail.latestBatch?.status === "failed" ? detail.latestBatch.error : "";
}

/** The asset URL an input item shows: its own asset, or its source item's. */
export function inputUrl(
  input: InputItemSummary,
  assetUrls: Readonly<Record<string, string>>,
): string | null {
  const assetId = input.assetId ?? input.item?.assetId;
  return assetId ? (assetUrls[assetId] ?? null) : null;
}
