import { expect, test } from "nsh/test";
import { CONTENT, EDGES, NODE_HEIGHT, NODE_WIDTH, NODES, seedEdges, seedNodes } from "./data";

test("every edge connects two nodes", () => {
  const ids = new Set(NODES.map((node) => node.id));
  for (const edge of EDGES) {
    expect(ids.has(edge.from)).toBe(true);
    expect(ids.has(edge.to)).toBe(true);
  }
});

test("the content bounds enclose every card", () => {
  expect(CONTENT.width).toBeGreaterThan(0);
  expect(CONTENT.height).toBeGreaterThan(0);

  for (const node of NODES) {
    expect(node.x).toBeGreaterThanOrEqual(CONTENT.x);
    expect(node.y).toBeGreaterThanOrEqual(CONTENT.y);
    expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(CONTENT.x + CONTENT.width);
    expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(CONTENT.y + CONTENT.height);
  }
});

test("seeds nodes and edges with their ids", () => {
  const nodes = seedNodes();
  const edges = seedEdges();
  expect(nodes.length).toBe(NODES.length);
  expect(edges.length).toBe(EDGES.length);
  expect(nodes[0]?.id).toBe("trigger");
  expect(edges[0]?.fromId).toBe("trigger");
  expect(edges[0]?.toId).toBe("validate");
});
