import { expect, test } from "nsh/test";
import { CONTENT, IMAGE_NODE_ID, NODE_HEIGHT, NODE_WIDTH, TEXT_NODE_ID, seedNodes } from "./data";
import { parseSettings } from "./node-kinds";

test("the seed has one text and one image node", () => {
  const nodes = seedNodes();
  expect(nodes.length).toBe(2);
  expect(nodes[0]?.id).toBe(TEXT_NODE_ID);
  expect(nodes[0]?.kind).toBe("text");
  expect(nodes[1]?.id).toBe(IMAGE_NODE_ID);
  expect(nodes[1]?.kind).toBe("image");
});

test("the content bounds enclose both cards", () => {
  expect(CONTENT.width).toBeGreaterThan(0);
  expect(CONTENT.height).toBeGreaterThan(0);
  for (const node of seedNodes()) {
    expect(node.x).toBeGreaterThanOrEqual(CONTENT.x);
    expect(node.y).toBeGreaterThanOrEqual(CONTENT.y);
    expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(CONTENT.x + CONTENT.width);
    expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(CONTENT.y + CONTENT.height);
  }
});

test("the seed's image settings are valid", () => {
  const image = seedNodes()[1];
  const settings = parseSettings("image", image?.settingsJson ?? "{}");
  expect(settings.prompt.length).toBeGreaterThan(0);
  expect(settings.version).toBe(1);
  if (settings.version === 1 && "aspect" in settings) {
    expect(settings.aspect).toBe("16:9");
    expect(settings.count).toBe(2);
  }
});
