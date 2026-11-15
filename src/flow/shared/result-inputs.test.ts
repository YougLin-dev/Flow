import { expect, test } from "nsh/test";
import {
  imageResultItem,
  manualTextResult,
  resultBatch,
  resultItem,
  textResultItem,
} from "./result-inputs";

test("a batch carries the shared empty defaults and a fresh id", () => {
  const first = resultBatch({
    nodeId: "n1",
    trigger: "manual",
    provider: "manual",
    status: "done",
  });
  const second = resultBatch({
    nodeId: "n1",
    trigger: "manual",
    provider: "manual",
    status: "done",
  });
  expect(first.id).toMatch(/^batch-/);
  expect(first).toEqual({
    id: first.id,
    nodeId: "n1",
    trigger: "manual",
    provider: "manual",
    model: "",
    paramsJson: "{}",
    status: "done",
  });
  expect(first.id).not.toBe(second.id);
  expect("error" in first).toBe(false);
});

test("a caller-tracked run keeps the batch id it settled on", () => {
  const batch = resultBatch({
    id: "batch-run-1",
    nodeId: "n1",
    trigger: "run",
    provider: "mock",
    model: "mock-model",
    paramsJson: '{"seed":1}',
    status: "done",
  });
  expect(batch.id).toBe("batch-run-1");
  expect(batch.model).toBe("mock-model");
  expect(batch.paramsJson).toBe('{"seed":1}');
});

test("a failed batch writes the error only when one is given", () => {
  const batch = resultBatch({
    nodeId: "n1",
    trigger: "upload",
    provider: "local",
    status: "failed",
    error: "The image could not be read",
  });
  expect(batch.error).toBe("The image could not be read");
  expect(batch.model).toBe("");
  expect(batch.paramsJson).toBe("{}");
});

test("an item writes asset keys only when the writer supplies them", () => {
  const text = textResultItem(2, "hello");
  expect(text.id).toMatch(/^item-/);
  expect(text).toEqual({
    id: text.id,
    position: 2,
    portId: "text",
    kind: "text",
    text: "hello",
  });
  expect("assetId" in text).toBe(false);
  expect("metaJson" in text).toBe(false);

  const image = imageResultItem(3, "asset-1", '{"width":10}');
  expect(image.id).toMatch(/^item-/);
  expect(image).toEqual({
    id: image.id,
    position: 3,
    portId: "image",
    kind: "image",
    text: "",
    assetId: "asset-1",
    metaJson: '{"width":10}',
  });

  const copied = resultItem({
    position: 0,
    portId: "text",
    kind: "text",
    text: "copied",
    assetId: null,
    metaJson: '{"width":10}',
  });
  expect(copied.assetId).toBeNull();
  expect(copied.metaJson).toBe('{"width":10}');
});

test("a manual text write yields the batch and its single text item", () => {
  const result = manualTextResult("n2", "body");
  expect(result.batch.nodeId).toBe("n2");
  expect(result.batch.trigger).toBe("manual");
  expect(result.batch.status).toBe("done");
  expect(result.item.id).toMatch(/^item-/);
  expect(result.item).toEqual({
    id: result.item.id,
    position: 0,
    portId: "text",
    kind: "text",
    text: "body",
  });
});
