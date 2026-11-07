import { expect, test } from "nsh/test";
import { CONTENT, EDGES, NODE_HEIGHT, NODE_WIDTH, NODES } from "./data";

test("every edge connects two nodes", () => {
  for (const [from, to] of EDGES) {
    expect(NODES[from]).toBeDefined();
    expect(NODES[to]).toBeDefined();
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
