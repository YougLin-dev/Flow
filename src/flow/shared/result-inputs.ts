/**
 * The one place result batches and their items are shaped. Every writer
 * (seed, inline edit, run, upload, copy) goes through these factories, so a
 * new DTO field is a compile error at one literal. The factories are pure
 * document-input builders: `flow/execution` may use them without importing
 * `flow/document`, which the area matrix forbids.
 */
import type { ResultBatchInput, ResultItemInput } from "./native-types";

/** The batch fields a writer supplies; the shared defaults fill the rest. */
export interface ResultBatchFields {
  /** A caller that tracks the batch (a run) supplies the id it settled on. */
  readonly id?: string;
  readonly nodeId: string;
  readonly trigger: string;
  readonly provider: string;
  readonly status: string;
  readonly model?: string;
  readonly paramsJson?: string;
  readonly error?: string;
}

/** One result batch with the caller's id (or a fresh one) and shared defaults. */
export function resultBatch(fields: ResultBatchFields): ResultBatchInput {
  const batch: ResultBatchInput = {
    id: fields.id ?? `batch-${crypto.randomUUID()}`,
    nodeId: fields.nodeId,
    trigger: fields.trigger,
    provider: fields.provider,
    model: fields.model ?? "",
    paramsJson: fields.paramsJson ?? "{}",
    status: fields.status,
  };
  if (fields.error !== undefined) batch.error = fields.error;
  return batch;
}

/** The item fields a writer supplies; optional asset keys stay absent. */
export interface ResultItemFields {
  readonly position: number;
  readonly portId: string;
  readonly kind: string;
  readonly text: string;
  readonly assetId?: string | null;
  readonly metaJson?: string | null;
}

/** One result item with a fresh id; absent asset keys are not written. */
export function resultItem(fields: ResultItemFields): ResultItemInput {
  const item: ResultItemInput = {
    id: `item-${crypto.randomUUID()}`,
    position: fields.position,
    portId: fields.portId,
    kind: fields.kind,
    text: fields.text,
  };
  if (fields.assetId !== undefined) item.assetId = fields.assetId;
  if (fields.metaJson !== undefined) item.metaJson = fields.metaJson;
  return item;
}

/** One text item on the text port. */
export function textResultItem(position: number, text: string): ResultItemInput {
  return resultItem({ position, portId: "text", kind: "text", text });
}

/** One image item on the image port. v1 requires its asset. */
export function imageResultItem(
  position: number,
  assetId: string,
  metaJson: string | null,
): ResultItemInput {
  return resultItem({ position, portId: "image", kind: "image", text: "", assetId, metaJson });
}

/** A manual text write's batch and single item, as stored together. */
export interface ManualTextResult {
  readonly batch: ResultBatchInput;
  readonly item: ResultItemInput;
}

/** The batch and item one manual text write stores. */
export function manualTextResult(nodeId: string, text: string): ManualTextResult {
  return {
    batch: resultBatch({ nodeId, trigger: "manual", provider: "manual", status: "done" }),
    item: textResultItem(0, text),
  };
}
