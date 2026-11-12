import type { Document, NodeInput, ResultBatchInput, ResultItemInput } from "@flow/native";
import { portOffset } from "./connection";
import { serializeSettings } from "./node-kinds";

export const NODE_WIDTH = 300;
export const NODE_HEIGHT = 220;

export const TEXT_NODE_ID = "seed-text";
export const IMAGE_NODE_ID = "seed-image";
export const SEED_EDGE_ID = "seed-text-image";

/** The text node's manual body; it is also the image node's first input. */
const SEED_TEXT = "清晨的湖面像一面镜子，远山的轮廓在薄雾里慢慢清晰，光线柔和。";

// The document's bounds in world coordinates (nodes at 80…820 / 120…340).
export const CONTENT = {
  x: 80,
  y: 120,
  width: 740,
  height: NODE_HEIGHT,
} as const;

/** The two connected nodes the first open (or a reset) seeds. */
export function seedNodes(): NodeInput[] {
  return [
    {
      id: TEXT_NODE_ID,
      kind: "text",
      title: "Text",
      body: SEED_TEXT,
      tags: ["text"],
      x: 80,
      y: 120,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      z: 0,
      settingsJson: serializeSettings({
        version: 1,
        prompt: "Describe a calm lake at dawn in one sentence.",
        model: "mock-text",
      }),
    },
    {
      id: IMAGE_NODE_ID,
      kind: "image",
      title: "Image",
      body: "",
      tags: ["image"],
      x: 520,
      y: 120,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      z: 0,
      settingsJson: serializeSettings({
        version: 1,
        prompt: "A quiet mountain lake at dawn, soft light.",
        model: "mock-image",
        aspect: "16:9",
        count: 2,
      }),
    },
  ];
}

/**
 * Writes the M1 example into an empty document: a text node with one manual
 * result, connected to an unrun image node. The demo is not undo history.
 */
export async function seedDocument(document: Document): Promise<void> {
  await document.insertNodes(seedNodes());

  const batch: ResultBatchInput = {
    id: `batch-${crypto.randomUUID()}`,
    nodeId: TEXT_NODE_ID,
    trigger: "manual",
    provider: "manual",
    model: "",
    paramsJson: "{}",
    status: "done",
  };
  const item: ResultItemInput = {
    id: `item-${crypto.randomUUID()}`,
    position: 0,
    portId: "text",
    kind: "text",
    text: SEED_TEXT,
  };
  await document.setManualText(TEXT_NODE_ID, SEED_TEXT, batch, item);
  await document.connectEdge({
    id: SEED_EDGE_ID,
    fromId: TEXT_NODE_ID,
    toId: IMAGE_NODE_ID,
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: portOffset(0, 1, NODE_HEIGHT),
    toOffset: portOffset(0, 2, NODE_HEIGHT),
    kind: "flow",
  });
  await document.clearHistory();
}
