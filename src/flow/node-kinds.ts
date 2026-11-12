/**
 * The node kinds the editor knows in M1. A kind declares its ports, default
 * size and opaque settings schema; `execution.ts` selects the provider for a
 * kind. Rust stores `kind` and the settings JSON without knowing either.
 */

export type FlowAccent = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

/** The type of a port's items. */
export type PortKind = "text" | "image";

/** Whether a stored kind names a known port type. */
export function isPortKind(value: string): value is PortKind {
  return value === "text" || value === "image";
}

export type NodeKindId = "text" | "image";

export type ImageAspect = "1:1" | "16:9" | "9:16";

export const IMAGE_ASPECTS: readonly ImageAspect[] = ["1:1", "16:9", "9:16"];

/** One input parameter of a node kind. */
export interface InputPort {
  readonly id: string;
  readonly name: string;
  readonly kind: PortKind;
  /** The most edges this input may receive. */
  readonly capacity: number;
}

/** One output parameter of a node kind. */
export interface OutputPort {
  readonly id: string;
  readonly name: string;
  readonly kind: PortKind;
}

export interface TextSettings {
  version: 1;
  prompt: string;
  model: "mock-text";
}

export interface ImageSettings {
  version: 1;
  prompt: string;
  model: "mock-image";
  aspect: ImageAspect;
  count: number;
}

export type NodeSettings = TextSettings | ImageSettings;

export interface NodeKind {
  readonly id: NodeKindId;
  readonly name: string;
  readonly accent: FlowAccent;
  readonly size: { readonly width: number; readonly height: number };
  readonly inputs: readonly InputPort[];
  readonly outputs: readonly OutputPort[];
}

const TEXT_KIND: NodeKind = {
  id: "text",
  name: "Text",
  accent: "chart-2",
  size: { width: 300, height: 220 },
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 4 },
  ],
  outputs: [{ id: "text", name: "Text", kind: "text" }],
};

const IMAGE_KIND: NodeKind = {
  id: "image",
  name: "Image",
  accent: "chart-1",
  size: { width: 300, height: 220 },
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 16 },
  ],
  outputs: [{ id: "image", name: "Image", kind: "image" }],
};

const FALLBACK_KIND: NodeKind = {
  id: "text",
  name: "Node",
  accent: "chart-1",
  size: { width: 300, height: 220 },
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 16 },
  ],
  outputs: [{ id: "text", name: "Text", kind: "text" }],
};

const KINDS: Record<string, NodeKind> = {
  text: TEXT_KIND,
  image: IMAGE_KIND,
};

export function nodeKind(id: string): NodeKind {
  return KINDS[id] ?? FALLBACK_KIND;
}

export function isKnownKind(id: string): id is NodeKindId {
  return id in KINDS;
}

/** Whether two specific ports may be joined: they carry the same item type. */
export function canConnectPorts(
  fromKind: string,
  fromPort: string,
  toKind: string,
  toPort: string,
): boolean {
  const from = nodeKind(fromKind).outputs.find((port) => port.id === fromPort);
  const to = nodeKind(toKind).inputs.find((port) => port.id === toPort);
  return from !== undefined && to !== undefined && from.kind === to.kind;
}

export function defaultSettings(kind: string): NodeSettings {
  if (kind === "image") {
    return {
      version: 1,
      prompt: "",
      model: "mock-image",
      aspect: "1:1",
      count: 1,
    };
  }
  return { version: 1, prompt: "", model: "mock-text" };
}

/** Parses a node's opaque settings, filling missing or invalid values. */
export function parseSettings(kind: string, json: string): NodeSettings {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  const prompt = typeof record.prompt === "string" ? record.prompt : "";

  if (kind === "image") {
    return {
      version: 1,
      prompt,
      model: "mock-image",
      aspect: isAspect(record.aspect) ? record.aspect : "1:1",
      count: clampCount(record.count),
    };
  }
  return { version: 1, prompt, model: "mock-text" };
}

export function serializeSettings(settings: NodeSettings): string {
  return JSON.stringify(settings);
}

export function modelLabel(kind: string): string {
  return kind === "image" ? "Mock Image" : "Mock Text";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "stale":
      return "Upstream updated";
    case "interrupted":
      return "Interrupted";
    default:
      return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAspect(value: unknown): value is ImageAspect {
  return typeof value === "string" && (IMAGE_ASPECTS as readonly string[]).includes(value);
}

function clampCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.round(value)));
}
