/**
 * What an open composer reloads from a change set and which assets its detail
 * shows. Pure policy beside `NodeSession`, which loads the detail and applies
 * it; keeping it here leaves the session to the document-facing commands.
 */
import type { InputItemSummary, NodeDetail, NodeSummary } from "@flow/native";

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

/** The asset IDs a detail's composer shows, matching its asset loading. */
export function detailAssetIds(detail: NodeDetail): Set<string> {
  const ids = new Set<string>();
  for (const item of detail.batch?.items ?? []) {
    if (item.assetId) ids.add(item.assetId);
  }
  for (const input of detail.inputs) {
    if (input.assetId) ids.add(input.assetId);
    if (input.item?.assetId) ids.add(input.item.assetId);
  }
  return ids;
}

/**
 * Whether an incoming summary differs from the open detail's node only in
 * the fields the composer does not render: its card bounds. Identical
 * summaries skip too. Every other field, including z and rev, is content.
 */
export function canSkipDetailReload(current: NodeSummary, incoming: NodeSummary): boolean {
  return (
    current.id === incoming.id &&
    current.kind === incoming.kind &&
    current.title === incoming.title &&
    current.body === incoming.body &&
    current.z === incoming.z &&
    current.rev === incoming.rev &&
    current.dataJson === incoming.dataJson &&
    current.settingsJson === incoming.settingsJson &&
    current.status === incoming.status &&
    (current.outputBatchId ?? null) === (incoming.outputBatchId ?? null)
  );
}
