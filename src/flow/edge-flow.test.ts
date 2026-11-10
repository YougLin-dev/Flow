import { expect, test } from "nsh/test";
import type { EdgeSummary } from "@flow/native";
import { edgeFlows, FLOW_HEAD_ALPHA, FLOW_LAYERS, flowLayers } from "./edge-flow";

function edge(fromId: string, toId: string): EdgeSummary {
  return {
    id: `${fromId}-${toId}`,
    fromId,
    toId,
    fromPort: null,
    toPort: null,
    kind: "flow",
    dataJson: "{}",
  };
}

test("flows a connector with a selected card at either end", () => {
  const selected = new Set(["a"]);

  // An incoming connector (the selected card is its target) and an outgoing
  // one (its source) both flow.
  expect(edgeFlows(edge("b", "a"), selected)).toBe(true);
  expect(edgeFlows(edge("a", "b"), selected)).toBe(true);
  expect(edgeFlows(edge("b", "c"), selected)).toBe(false);
  expect(edgeFlows(edge("b", "c"), new Set())).toBe(false);
});

test("flows a connector between two selected cards", () => {
  expect(edgeFlows(edge("a", "b"), new Set(["a", "b"]))).toBe(true);
});

test("a wave's passes share one head and fade into its tail", () => {
  const fill = 160;
  const layers = flowLayers(fill);
  expect(layers.length).toBe(FLOW_LAYERS);
  // Every pass's lit span ends where the wave's head is: the constant shift
  // of its dash is exactly its body's shorter length.
  for (const layer of layers) {
    expect(layer.shift).toBe(layer.lit - fill);
    expect(layer.lit - layer.shift).toBe(fill);
  }
  // The passes stack from the tail's faint light up to the head.
  expect(layers[0].lit).toBe(fill);
  expect(Math.abs(layers[layers.length - 1].lit - fill / FLOW_LAYERS) < 1e-9).toBe(true);
  expect(layers[layers.length - 1].head).toBe(true);
  expect(layers.slice(0, -1).every((layer) => !layer.head)).toBe(true);
  let shown = 0;
  for (const layer of layers) {
    expect(layer.alpha).toBeGreaterThan(0);
    shown = 1 - (1 - shown) * (1 - layer.alpha);
  }
  // Composed toward the head, the passes reach the head's alpha; the tail
  // keeps only the first pass's small share of it.
  expect(Math.abs(shown - FLOW_HEAD_ALPHA) < 1e-9).toBe(true);
  expect(layers[0].alpha).toBeLessThan(FLOW_HEAD_ALPHA / 4);
  // No wave, no passes.
  expect(flowLayers(0).length).toBe(0);
});
