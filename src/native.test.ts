// Headless-only: the desktop test host loads test bundles before an app has
// registered its native module, so `@flow/native` cannot load there. The
// headless runner links the Rust crate and runs this file with the rest.
import { expect, test } from "nsh/test";
import { Document } from "@flow/native";

test("stores, searches and undoes nodes through the Rust core", async () => {
  const document = await Document.open(":memory:");

  const inserted = await document.insertNodes([
    {
      id: "image-a",
      kind: "image",
      title: "Image generator",
      body: "Turns text into an image",
      tags: ["generated"],
      x: 40,
      y: 60,
      width: 220,
      height: 120,
      z: 1,
    },
    {
      id: "text-b",
      kind: "text",
      title: "Text panel",
      body: "A text node",
      tags: ["source"],
      x: 400,
      y: 60,
      width: 220,
      height: 120,
      z: 1,
    },
  ]);

  expect(inserted.changed.length).toBe(2);
  expect(await document.count()).toBe(2);

  const hits = await document.search("generator", {}, 10);
  expect(hits.length).toBe(1);
  expect(hits[0]?.id).toBe("image-a");

  const moved = await document.moveNodes(["image-a"], 30, 20);
  expect(moved.changed[0]?.x).toBe(70);
  expect(moved.changed[0]?.y).toBe(80);

  await document.undo();
  const visible = await document.viewport({ x: 0, y: 0, width: 100, height: 100 }, 0);
  expect(visible[0]?.x).toBe(40);

  const redone = await document.redo();
  expect(redone.changed[0]?.x).toBe(70);

  document.dispose();
});

test("clears seeded history so undo cannot remove the demo", async () => {
  const document = await Document.open(":memory:");
  await document.insertNodes([
    {
      id: "seed",
      kind: "panel",
      title: "Seed",
      body: "",
      tags: [],
      x: 0,
      y: 0,
      width: 200,
      height: 84,
      z: 0,
    },
  ]);
  await document.clearHistory();

  const changes = await document.undo();
  expect(changes.changed.length).toBe(0);
  expect(await document.count()).toBe(1);
  document.dispose();
});

test("searches short Chinese queries through the Rust boundary", async () => {
  const document = await Document.open(":memory:");
  await document.insertNodes([
    {
      id: "cjk",
      kind: "text",
      title: "图像生成器",
      body: "把文本变成图片",
      tags: ["设计"],
      x: 0,
      y: 0,
      width: 200,
      height: 84,
      z: 0,
    },
  ]);

  const shortHits = await Promise.all(
    ["图像", "图片", "设计"].map((query) => document.search(query, {}, 10)),
  );
  expect(shortHits.map((hits) => hits[0]?.id)).toEqual(["cjk", "cjk", "cjk"]);
  expect((await document.search("生成器", {}, 10))[0]?.id).toBe("cjk");
  expect((await document.search("图像", { kind: "image" }, 10)).length).toBe(0);

  document.dispose();
});

test("serves viewport scenes, bounds, edges and undo", async () => {
  const document = await Document.open(":memory:");

  await document.insertNodes([
    {
      id: "a",
      kind: "panel",
      title: "A",
      body: "",
      tags: [],
      x: 40,
      y: 40,
      width: 200,
      height: 84,
      z: 0,
      dataJson: '{"subtitle":"First"}',
    },
    {
      id: "b",
      kind: "panel",
      title: "B",
      body: "",
      tags: [],
      x: 360,
      y: 40,
      width: 200,
      height: 84,
      z: 0,
    },
  ]);
  await document.insertEdges([{ id: "a-b", fromId: "a", toId: "b", kind: "flow" }]);

  const scene = await document.scene({ x: 0, y: 0, width: 1000, height: 1000 }, 0);
  expect(scene.nodes.length).toBe(2);
  expect(scene.edges.length).toBe(1);
  expect(scene.nodes.find((node) => node.id === "a")?.dataJson).toContain("First");

  const summary = await document.getNode("a");
  expect(summary?.title).toBe("A");
  expect(await document.getNode("missing")).toBeNull();

  const bounds = await document.bounds();
  expect(bounds.x).toBe(40);
  expect(bounds.y).toBe(40);
  expect(bounds.width).toBe(520);
  expect(bounds.height).toBe(84);

  const moved = await document.setNodeBounds([
    { id: "a", x: 100, y: 120, width: 220, height: 100 },
  ]);
  expect(moved.changed[0]?.x).toBe(100);
  expect(moved.changed[0]?.width).toBe(220);

  await document.undo();
  const restored = await document.scene({ x: 0, y: 0, width: 1000, height: 1000 }, 0);
  expect(restored.nodes.find((node) => node.id === "a")?.x).toBe(40);

  await document.deleteNodes(["a"]);
  expect(await document.edgeCount()).toBe(0);

  await document.undo();
  expect(await document.edgeCount()).toBe(1);

  document.dispose();
});
