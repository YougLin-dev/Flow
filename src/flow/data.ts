/** The chart tokens a card's accent stripe may use. */
export type FlowAccent = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

export interface FlowNode {
  readonly title: string;
  readonly subtitle: string;
  readonly x: number;
  readonly y: number;
  readonly accent: FlowAccent;
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 84;

// Where the flow lives in the scene's own coordinates.
export const NODES: readonly FlowNode[] = [
  { title: "Trigger", subtitle: "Incoming webhook", x: 40, y: 40, accent: "chart-1" },
  { title: "Validate", subtitle: "JSON schema", x: 360, y: 40, accent: "chart-2" },
  { title: "Transform", subtitle: "Map the fields", x: 360, y: 228, accent: "chart-3" },
  { title: "Deliver", subtitle: "HTTP request", x: 40, y: 228, accent: "chart-4" },
];

export const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
];

// The flow's bounds in the scene's own coordinates (nodes at 40…560 / 40…312).
export const CONTENT = {
  x: 40,
  y: 40,
  width: 360 + NODE_WIDTH - 40,
  height: 228 + NODE_HEIGHT - 40,
} as const;
