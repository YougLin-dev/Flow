/**
 * Execution orchestration. TSX owns the run lifecycle (status, cancellation,
 * provider calls); Rust stores the immutable batch and its items.
 */
import { token } from "nsh";
import type {
  ChangeSet,
  Document,
  InputItemSummary,
  NodeDetail,
  ResultBatchInput,
  ResultItemInput,
} from "@flow/native";
import type { ImageSettings, NodeSettings, TextSettings } from "./node-kinds";

export interface ProviderRequest {
  readonly nodeId: string;
  readonly prompt: string;
  readonly inputs: readonly InputItemSummary[];
  readonly signal: AbortSignal;
}

export type ProviderItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly bytes: Uint8Array;
      readonly mime: string;
      readonly name: string;
      readonly metaJson: string;
    };

export interface ProviderResult {
  readonly provider: string;
  readonly model: string;
  readonly paramsJson: string;
  readonly items: readonly ProviderItem[];
}

interface ProviderRequestWithSettings extends ProviderRequest {
  readonly settings: NodeSettings;
}

type Provider = (request: ProviderRequestWithSettings) => Promise<ProviderResult>;

export interface RunCallbacks {
  /** Applies a status or result change to the scene. */
  onChange: (changes: ChangeSet) => void;
  /** A run finished (or failed/was cancelled): reload the composer and previews. */
  onSettled: (nodeId: string) => void;
}

export class CancelledError extends Error {
  constructor() {
    super("the run was cancelled");
    this.name = "CancelledError";
  }
}

const TEXT_DELAY_MS = 650;
const IMAGE_DELAY_MS = 950;

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === "AbortError");
}

/** Wait for `ms`, rejecting as cancelled when the run is aborted first. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const mockText: Provider = async (request) => {
  const settings = asTextSettings(request.settings);
  await wait(TEXT_DELAY_MS, request.signal);
  const contexts = request.inputs
    .filter((input) => input.kind === "text")
    .map((input) => input.item?.text ?? input.text)
    .filter((text) => text.trim() !== "");
  const images = request.inputs.filter((input) => input.kind === "image").length;
  const parts = [`[Mock Text] ${request.prompt}`];
  if (contexts.length > 0) parts.push("", ...contexts);
  if (images > 0) {
    parts.push("", `Reference images: ${images}`);
  }
  return {
    provider: "mock-text",
    model: settings.model,
    paramsJson: JSON.stringify({ prompt: request.prompt, contexts: contexts.length, images }),
    items: [{ kind: "text", text: parts.join("\n") }],
  };
};

const mockImage: Provider = async (request) => {
  const settings = asImageSettings(request.settings);
  await wait(IMAGE_DELAY_MS, request.signal);
  const dimensions = aspectDimensions(settings.aspect);
  const items: ProviderItem[] = [];
  for (let index = 0; index < settings.count; index += 1) {
    const svg = mockSvg(request, settings, dimensions, index);
    items.push({
      kind: "image",
      bytes: new TextEncoder().encode(svg),
      mime: "image/svg+xml",
      name: `mock-${index + 1}.svg`,
      metaJson: JSON.stringify({
        width: dimensions.width,
        height: dimensions.height,
        aspect: settings.aspect,
        index,
      }),
    });
  }
  return {
    provider: "mock-image",
    model: settings.model,
    paramsJson: JSON.stringify({
      prompt: request.prompt,
      aspect: settings.aspect,
      count: settings.count,
      images: request.inputs.filter((input) => input.kind === "image").length,
    }),
    items,
  };
};

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
    if (settings.prompt.trim() === "") {
      await this.settleFailure(nodeId, "Prompt cannot be empty", settings);
      this.callbacks.onSettled(nodeId);
      return;
    }

    const controller = new AbortController();
    this.runs.set(nodeId, controller);
    const batchId = `batch-${crypto.randomUUID()}`;
    const provider = detail.node.kind === "image" ? mockImage : mockText;

    try {
      this.apply(await this.document.setNodeStatus(nodeId, "running"));
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
          if (item.kind === "text") {
            return {
              id: `item-${crypto.randomUUID()}`,
              position,
              portId: "text",
              kind: "text",
              text: item.text,
            };
          }
          const asset = await this.document.importAsset({
            id: `asset-${crypto.randomUUID()}`,
            kind: "image",
            name: item.name,
            mime: item.mime,
            bytes: item.bytes,
            metaJson: item.metaJson,
          });
          return {
            id: `item-${crypto.randomUUID()}`,
            position,
            portId: "image",
            kind: "image",
            text: "",
            assetId: asset.id,
            metaJson: item.metaJson,
          };
        }),
      );

      if (controller.signal.aborted) throw new CancelledError();
      const batch: ResultBatchInput = {
        id: batchId,
        nodeId,
        trigger: "run",
        provider: result.provider,
        model: result.model,
        paramsJson: result.paramsJson,
        status: "done",
      };
      this.apply(await this.document.saveRun(batch, items));
    } catch (error) {
      // The app is closing: the database is gone and startup recovery will
      // mark the abandoned run interrupted.
      if (this.disposed) return;
      if (isCancelled(error)) {
        await this.settle(nodeId, batchId, "cancelled", "", settings, "mock");
      } else {
        console.error("Flow could not run a node", error);
        await this.settleFailure(nodeId, messageOf(error), settings, batchId);
      }
    } finally {
      this.runs.delete(nodeId);
      this.callbacks.onSettled(nodeId);
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
          {
            id: batchId,
            nodeId,
            trigger: "run",
            provider: `${provider}-${settings.model.replace(/^mock-/, "")}`,
            model: settings.model,
            paramsJson: JSON.stringify({ prompt: settings.prompt }),
            status,
            error,
          },
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

function asTextSettings(settings: NodeSettings): TextSettings {
  if (settings.version === 1 && !("aspect" in settings)) return settings;
  throw new Error("an image settings object reached the text provider");
}

function asImageSettings(settings: NodeSettings): ImageSettings {
  if (settings.version === 1 && "aspect" in settings) return settings;
  throw new Error("a text settings object reached the image provider");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aspectDimensions(aspect: string): { width: number; height: number } {
  if (aspect === "16:9") return { width: 1024, height: 576 };
  if (aspect === "9:16") return { width: 576, height: 1024 };
  return { width: 768, height: 768 };
}

function mockSvg(
  request: ProviderRequest,
  settings: ImageSettings,
  dimensions: { width: number; height: number },
  index: number,
): string {
  const accent = token(index % 2 === 0 ? "chart-1" : "chart-2");
  const background = token("card");
  const titleColor = token("card-foreground");
  const muted = token("muted-foreground");
  const fontSize = Math.round(dimensions.width / 22);
  const lines = wrap(escapeXml(request.prompt), 34).slice(0, 4);
  const title = lines
    .map(
      (line, lineIndex) =>
        `<text x="${fontSize}" y="${fontSize * 2 + lineIndex * fontSize * 1.25}" \
font-size="${fontSize}" font-weight="600" fill="${titleColor}">${line}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
<stop offset="1" stop-color="${background}" stop-opacity="1"/>
</linearGradient></defs>
<rect width="100%" height="100%" fill="${background}"/>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${dimensions.width * 0.82}" cy="${dimensions.height * 0.2}" r="${dimensions.width * 0.12}" fill="${accent}" opacity="0.25"/>
${title}
<text x="${fontSize}" y="${dimensions.height - fontSize}" font-size="${Math.round(fontSize * 0.7)}" fill="${muted}">Mock Image · ${index + 1}/${settings.count} · ${escapeXml(settings.aspect)}</text>
</svg>`;
}

function wrap(text: string, width: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = "";
  for (const char of chars) {
    line += char;
    if (Array.from(line).length >= width) {
      lines.push(line);
      line = "";
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
