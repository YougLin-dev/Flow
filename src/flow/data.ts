import type { EdgeInput, NodeInput } from "@flow/native";

/** The chart tokens a card's accent stripe may use. */
export type FlowAccent = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

export interface FlowNode {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly kind: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly accent: FlowAccent;
}

export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 84;

// The demo flow. It is seeded into an empty document, then read back through
// the viewport; the TSX scene never uses these positions directly.
export const NODES: readonly FlowNode[] = [
  {
    id: "trigger",
    title: "Trigger",
    subtitle: "Incoming webhook",
    kind: "panel",
    body: "Incoming webhook",
    tags: ["demo", "webhook"],
    x: 40,
    y: 40,
    accent: "chart-1",
  },
  {
    id: "validate",
    title: "Validate",
    subtitle: "JSON schema",
    kind: "panel",
    body: "Validate the payload with a JSON schema",
    tags: ["demo", "schema"],
    x: 360,
    y: 40,
    accent: "chart-2",
  },
  {
    id: "transform",
    title: "Transform",
    subtitle: "Map the fields",
    kind: "panel",
    body: "Map the incoming fields",
    tags: ["demo", "transform"],
    x: 360,
    y: 228,
    accent: "chart-3",
  },
  {
    id: "deliver",
    title: "Deliver",
    subtitle: "HTTP request",
    kind: "panel",
    body: "Deliver the result with an HTTP request",
    tags: ["demo", "http"],
    x: 40,
    y: 228,
    accent: "chart-4",
  },
];

export const EDGES: readonly FlowEdge[] = [
  { id: "trigger-validate", from: "trigger", to: "validate", kind: "flow" },
  { id: "validate-transform", from: "validate", to: "transform", kind: "flow" },
  { id: "transform-deliver", from: "transform", to: "deliver", kind: "flow" },
];

// The flow's bounds in the scene's own coordinates (nodes at 40…560 / 40…312).
export const CONTENT = {
  x: 40,
  y: 40,
  width: 360 + NODE_WIDTH - 40,
  height: 228 + NODE_HEIGHT - 40,
} as const;

/** The demo nodes in the shape the Rust core accepts. */
export function seedNodes(): NodeInput[] {
  return NODES.map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    body: node.body,
    tags: [...node.tags],
    x: node.x,
    y: node.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    z: 0,
    dataJson: JSON.stringify({ subtitle: node.subtitle, accent: node.accent }),
  }));
}

/** The demo edges in the shape the Rust core accepts. */
export function seedEdges(): EdgeInput[] {
  return EDGES.map((edge) => ({
    id: edge.id,
    fromId: edge.from,
    toId: edge.to,
    kind: edge.kind,
  }));
}
