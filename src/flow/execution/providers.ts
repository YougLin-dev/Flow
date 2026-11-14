/**
 * The mock providers a run calls: the request/result shapes, cancellation
 * primitives and the text/image generators. They are pure apart from the
 * theme tokens the mock SVG reads and the delay that simulates work.
 */
import { token } from "nsh";
import type { InputItemSummary } from "../shared";
import {
  imageModelLabel,
  type ImageResolution,
  type ImageSettings,
  type NodeSettings,
  type TextSettings,
  textModelLabel,
} from "../nodes";

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

export const mockText: Provider = async (request) => {
  const settings = asTextSettings(request.settings);
  await wait(TEXT_DELAY_MS, request.signal);
  const contexts = request.inputs
    .filter((input) => input.kind === "text")
    .map((input) => input.item?.text ?? input.text)
    .filter((text) => text.trim() !== "");
  const images = request.inputs.filter((input) => input.kind === "image").length;
  const parts = [`[${textModelLabel(settings.model)}] ${request.prompt}`];
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

export const mockImage: Provider = async (request) => {
  const settings = asImageSettings(request.settings);
  await wait(IMAGE_DELAY_MS, request.signal);
  const dimensions = aspectDimensions(settings.aspect, settings.resolution);
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
        resolution: settings.resolution,
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
      resolution: settings.resolution,
      count: settings.count,
      images: request.inputs.filter((input) => input.kind === "image").length,
    }),
    items,
  };
};

function asTextSettings(settings: NodeSettings): TextSettings {
  if (settings.version === 1 && "prompt" in settings && !("aspect" in settings)) return settings;
  throw new Error("a non-text settings object reached the text provider");
}

function asImageSettings(settings: NodeSettings): ImageSettings {
  if (settings.version === 1 && "aspect" in settings) return settings;
  throw new Error("a text settings object reached the image provider");
}

/** The image a ratio and resolution ask for: the long side, the other scaled. */
function aspectDimensions(
  aspect: string,
  resolution: ImageResolution,
): { width: number; height: number } {
  const long = resolution === "2K" ? 2048 : 1024;
  const [width = 0, height = 0] = aspect.split(":").map(Number);
  if (!(width > 0 && height > 0)) return { width: long, height: long };
  if (width >= height) {
    return { width: long, height: Math.round((long * height) / width) };
  }
  return { width: Math.round((long * width) / height), height: long };
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
<text x="${fontSize}" y="${dimensions.height - fontSize}" font-size="${Math.round(fontSize * 0.7)}" fill="${muted}">${escapeXml(imageModelLabel(settings.model))} · ${index + 1}/${settings.count} · ${escapeXml(settings.aspect)}</text>
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
