/**
 * Execution orchestration. TSX owns the run lifecycle (status, cancellation,
 * provider calls); Rust stores the immutable batch and its items.
 */
import {
  imageResultItem,
  resultBatch,
  textResultItem,
  type ChangeSet,
  type Document,
  type NodeDetail,
  type ResultBatchFields,
  type ResultItemInput,
} from "../shared";
import type { ImageSettings, NodeSettings, TextSettings } from "../nodes";
import { CancelledError, isCancelled, mockImage, mockText } from "./providers";

export interface RunCallbacks {
  /** Applies a status or result change to the scene. */
  onChange: (changes: ChangeSet) => void;
  /** A run finished (or failed/was cancelled): reload the composer and previews. */
  onSettled: (nodeId: string) => void;
}

/** Starts and cancels node runs, at most one per node. */
export class NodeRunner {
  private readonly runs = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly document: Document,
    private readonly callbacks: RunCallbacks,
  ) {}

  isRunning(nodeId: string): boolean {
    return this.runs.has(nodeId);
  }

  cancel(nodeId: string): void {
    this.runs.get(nodeId)?.abort();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }

  async run(detail: NodeDetail, settings: NodeSettings): Promise<void> {
    const nodeId = detail.node.id;
    if (this.disposed || this.runs.has(nodeId)) return;
    // An upload node has no provider; its output comes from the local file.
    // The kind registry keeps one from reaching a run, but settle the caller
    // if it ever does rather than leaving its Run state busy.
    if (!("prompt" in settings)) {
      this.callbacks.onSettled(nodeId);
      return;
    }
    if (settings.prompt.trim() === "") {
      await this.settleFailure(nodeId, "Prompt cannot be empty", settings);
      this.callbacks.onSettled(nodeId);
      return;
    }

    const controller = new AbortController();
    this.runs.set(nodeId, controller);
    const batchId = `batch-${crypto.randomUUID()}`;
    const provider = detail.node.kind === "image" ? mockImage : mockText;
    let begun = false;

    try {
      // v1 runs start with a running batch on the node; the provider result
      // settles that same batch. A prompt failure before this point records
      // a failed batch in one call instead.
      this.apply(
        await this.document.beginRun(
          resultBatch({
            id: batchId,
            nodeId,
            trigger: "run",
            provider: "mock",
            model: settings.model,
            status: "running",
          }),
        ),
      );
      begun = true;
      const inputs = await this.document.syncInputs(nodeId);
      if (controller.signal.aborted) throw new CancelledError();
      const result = await provider({
        nodeId,
        prompt: settings.prompt,
        inputs,
        settings,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new CancelledError();

      const items = await Promise.all(
        result.items.map(async (item, position): Promise<ResultItemInput> => {
          if (item.kind === "text") return textResultItem(position, item.text);
          const asset = await this.document.importAsset({
            id: `asset-${crypto.randomUUID()}`,
            kind: "image",
            name: item.name,
            mime: item.mime,
            bytes: item.bytes,
            metaJson: item.metaJson,
          });
          return imageResultItem(position, asset.id, item.metaJson);
        }),
      );

      if (controller.signal.aborted) throw new CancelledError();
      const batch = resultBatch({
        id: batchId,
        nodeId,
        trigger: "run",
        provider: result.provider,
        model: result.model,
        paramsJson: result.paramsJson,
        status: "done",
      });
      this.apply(await this.document.settleRun(batch, items));
    } catch (error) {
      // The app is closing: the database is gone and startup recovery will
      // mark the abandoned run interrupted.
      if (this.disposed) return;
      if (isCancelled(error)) {
        if (begun) {
          await this.settleRunning(nodeId, batchId, "cancelled", "", settings);
        } else {
          await this.settleFailure(nodeId, "the run was cancelled", settings);
        }
      } else {
        console.error("Flow could not run a node", error);
        if (begun) {
          await this.settleRunning(nodeId, batchId, "failed", messageOf(error), settings);
        } else {
          await this.settleFailure(nodeId, messageOf(error), settings);
        }
      }
    } finally {
      this.runs.delete(nodeId);
      this.callbacks.onSettled(nodeId);
    }
  }

  /** Closes the running batch a provider call started. */
  private async settleRunning(
    nodeId: string,
    batchId: string,
    status: "failed" | "cancelled",
    error: string,
    settings: TextSettings | ImageSettings,
  ): Promise<void> {
    try {
      const fields: ResultBatchFields = {
        id: batchId,
        nodeId,
        trigger: "run",
        provider: `mock-${settings.model.replace(/^mock-/, "")}`,
        model: settings.model,
        paramsJson: JSON.stringify({ prompt: settings.prompt }),
        status,
        ...(error === "" ? {} : { error }),
      };
      this.apply(await this.document.settleRun(resultBatch(fields), []));
    } catch (settleError) {
      console.error("Flow could not settle a run", settleError);
    }
  }

  private async settleFailure(
    nodeId: string,
    error: string,
    settings: TextSettings | ImageSettings,
    batchId = `batch-${crypto.randomUUID()}`,
  ): Promise<void> {
    await this.settle(nodeId, batchId, "failed", error, settings, "mock");
  }

  private async settle(
    nodeId: string,
    batchId: string,
    status: "failed" | "cancelled",
    error: string,
    settings: TextSettings | ImageSettings,
    provider: string,
  ): Promise<void> {
    try {
      this.apply(
        await this.document.saveRun(
          resultBatch({
            id: batchId,
            nodeId,
            trigger: "run",
            provider: `${provider}-${settings.model.replace(/^mock-/, "")}`,
            model: settings.model,
            paramsJson: JSON.stringify({ prompt: settings.prompt }),
            status,
            error,
          }),
          [],
        ),
      );
    } catch (saveError) {
      console.error("Flow could not record a failed run", saveError);
    }
  }

  private apply(changes: ChangeSet): void {
    this.callbacks.onChange(changes);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
