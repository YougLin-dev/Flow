/**
 * The node kinds the editor knows. A kind declares its name, accent and
 * default size; its ports are resolved per node because an upload node's
 * outputs follow the media it holds. `execution.ts` selects the provider for
 * a runnable kind. Rust stores `kind` and the settings JSON without knowing
 * either.
 */

export type FlowAccent = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

/** A media type an upload node can emit. Extend here when video or 3D lands. */
export type MediaKind = "image";

/** The type of a port's items: text plus the media kinds. */
export type PortKind = "text" | MediaKind;

/** The media kinds an upload node may hold, in output-port order. */
export const MEDIA_KINDS: readonly MediaKind[] = ["image"];

/** Every port type, in the order group ports stack. */
export const PORT_KINDS: readonly PortKind[] = ["text", ...MEDIA_KINDS];

/** Whether a stored kind names a media type. */
export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Whether a stored kind names a known port type. */
export function isPortKind(value: string): value is PortKind {
  return value === "text" || isMediaKind(value);
}

export type NodeKindId = "text" | "image" | "upload";

/** Whether a kind runs a provider; an upload only holds a local file. */
export function isRunnableKind(kind: string): kind is "text" | "image" {
  return kind === "text" || kind === "image";
}

export type ImageAspect = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";

export const IMAGE_ASPECTS: readonly ImageAspect[] = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
];

/** The generated image's long side: 1K is 1024 points, 2K 2048. */
export type ImageResolution = "1K" | "2K";

export const IMAGE_RESOLUTIONS: readonly ImageResolution[] = ["1K", "2K"];

/** The models a text node offers; the mock provider stands in for either. */
export const TEXT_MODELS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "mock-text", label: "Mock Text" },
] as const;

export type TextModelId = (typeof TEXT_MODELS)[number]["id"];

/** The default model a new text node asks for. */
export const DEFAULT_TEXT_MODEL: TextModelId = "deepseek-v4.1-flash";

/** The model's name for the composer and result cards. */
export function textModelLabel(id: TextModelId): string {
  return TEXT_MODELS.find((model) => model.id === id)?.label ?? "Mock Text";
}

export function isTextModel(value: unknown): value is TextModelId {
  return typeof value === "string" && TEXT_MODELS.some((model) => model.id === value);
}

/** The models an image node offers; the mock provider stands in for either. */
export const IMAGE_MODELS = [
  { id: "qwen-image-3.0-pro", label: "Qwen Image 3.0 Pro" },
  { id: "mock-image", label: "Mock Image" },
] as const;

export type ImageModelId = (typeof IMAGE_MODELS)[number]["id"];

/** The default model a new image node asks for. */
export const DEFAULT_IMAGE_MODEL: ImageModelId = "qwen-image-3.0-pro";

/** The model's name for the composer and result cards. */
export function imageModelLabel(id: ImageModelId): string {
  return IMAGE_MODELS.find((model) => model.id === id)?.label ?? "Mock Image";
}

export function isImageModel(value: unknown): value is ImageModelId {
  return typeof value === "string" && IMAGE_MODELS.some((model) => model.id === value);
}

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
  model: TextModelId;
}

export interface ImageSettings {
  version: 1;
  prompt: string;
  model: ImageModelId;
  aspect: ImageAspect;
  resolution: ImageResolution;
  count: number;
}

export interface UploadSettings {
  version: 1;
  /** The media kinds the current upload holds; each becomes an output port. */
  media: readonly MediaKind[];
}

export type NodeSettings = TextSettings | ImageSettings | UploadSettings;

/** The ports one node exposes, resolved from its kind and settings. */
export interface NodePorts {
  readonly inputs: readonly InputPort[];
  readonly outputs: readonly OutputPort[];
}

/** The fields a port schema is resolved from; a NodeSummary satisfies it. */
export interface PortSchemaSource {
  readonly kind: string;
  readonly settingsJson: string;
}

export interface NodeKind {
  readonly id: NodeKindId;
  readonly name: string;
  readonly accent: FlowAccent;
  readonly size: { readonly width: number; readonly height: number };
}

const TEXT_PORTS: NodePorts = {
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 4 },
  ],
  outputs: [{ id: "text", name: "Text", kind: "text" }],
};

const IMAGE_PORTS: NodePorts = {
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 16 },
  ],
  outputs: [{ id: "image", name: "Image", kind: "image" }],
};

const MEDIA_PORTS: Record<MediaKind, OutputPort> = {
  image: { id: "image", name: "Image", kind: "image" },
};

/** The ports a kind this build does not know keeps: the generous text/image
 * schema older documents were written with, so a newer kind can still be
 * read and connected before its own handling lands. */
const FALLBACK_PORTS: NodePorts = {
  inputs: [
    { id: "prompt", name: "Prompt", kind: "text", capacity: 1 },
    { id: "references", name: "Image references", kind: "image", capacity: 16 },
  ],
  outputs: [{ id: "text", name: "Text", kind: "text" }],
};

const TEXT_KIND: NodeKind = {
  id: "text",
  name: "Text",
  accent: "chart-2",
  size: { width: 300, height: 220 },
};

const IMAGE_KIND: NodeKind = {
  id: "image",
  name: "Image",
  accent: "chart-1",
  size: { width: 300, height: 220 },
};

const UPLOAD_KIND: NodeKind = {
  id: "upload",
  name: "Upload",
  accent: "chart-3",
  size: { width: 300, height: 220 },
};

const FALLBACK_KIND: NodeKind = {
  id: "text",
  name: "Node",
  accent: "chart-1",
  size: { width: 300, height: 220 },
};

const KINDS: Record<string, NodeKind> = {
  text: TEXT_KIND,
  image: IMAGE_KIND,
  upload: UPLOAD_KIND,
};

const PORTS_CACHE = new WeakMap<PortSchemaSource, NodePorts>();

export function nodeKind(id: string): NodeKind {
  return KINDS[id] ?? FALLBACK_KIND;
}

export function isKnownKind(id: string): id is NodeKindId {
  return id in KINDS;
}

/**
 * A node's ports. The schema is cached by the node record: the scene keeps a
 * record object while its fields are unchanged, so a pan or zoom parses no
 * upload settings again.
 */
export function portsOfNode(node: PortSchemaSource): NodePorts {
  const cached = PORTS_CACHE.get(node);
  if (cached !== undefined) return cached;
  const ports = resolvePorts(node.kind, node.settingsJson);
  PORTS_CACHE.set(node, ports);
  return ports;
}

function resolvePorts(kind: string, settingsJson: string): NodePorts {
  if (kind === "upload") return uploadPorts(parseUploadSettings(settingsJson));
  if (kind === "image") return IMAGE_PORTS;
  if (kind === "text") return TEXT_PORTS;
  return FALLBACK_PORTS;
}

function uploadPorts(settings: UploadSettings): NodePorts {
  return {
    inputs: [],
    outputs: settings.media.map((kind) => MEDIA_PORTS[kind]),
  };
}

/** Whether the node shows an image body and loads asset previews. */
export function hasImageOutput(node: PortSchemaSource): boolean {
  return portsOfNode(node).outputs.some((port) => port.kind === "image");
}

/** Whether two specific ports may be joined: they carry the same item type. */
export function canConnectPorts(
  from: NodePorts,
  fromPort: string,
  to: NodePorts,
  toPort: string,
): boolean {
  const output = from.outputs.find((port) => port.id === fromPort);
  const input = to.inputs.find((port) => port.id === toPort);
  return output !== undefined && input !== undefined && output.kind === input.kind;
}

export function defaultSettings(kind: string): NodeSettings {
  if (kind === "image") {
    return {
      version: 1,
      prompt: "",
      model: DEFAULT_IMAGE_MODEL,
      aspect: "1:1",
      resolution: "1K",
      count: 1,
    };
  }
  if (kind === "upload") {
    return { version: 1, media: [] };
  }
  return { version: 1, prompt: "", model: DEFAULT_TEXT_MODEL };
}

/** Parses a node's opaque settings, filling missing or invalid values. */
export function parseSettings(kind: string, json: string): NodeSettings {
  if (kind === "upload") return parseUploadSettings(json);
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
      model: isImageModel(record.model) ? record.model : DEFAULT_IMAGE_MODEL,
      aspect: isAspect(record.aspect) ? record.aspect : "1:1",
      resolution: isResolution(record.resolution) ? record.resolution : "1K",
      count: clampCount(record.count),
    };
  }
  return {
    version: 1,
    prompt,
    model: isTextModel(record.model) ? record.model : DEFAULT_TEXT_MODEL,
  };
}

function parseUploadSettings(json: string): UploadSettings {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  const raw: unknown[] = Array.isArray(record.media) ? record.media : [];
  const present = new Set(
    raw.filter((value): value is MediaKind => typeof value === "string" && isMediaKind(value)),
  );
  return { version: 1, media: MEDIA_KINDS.filter((kind) => present.has(kind)) };
}

export function serializeSettings(settings: NodeSettings): string {
  return JSON.stringify(settings);
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

function isResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && (IMAGE_RESOLUTIONS as readonly string[]).includes(value);
}

function clampCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.round(value)));
}
