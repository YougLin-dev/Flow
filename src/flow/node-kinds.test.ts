import { expect, test } from "nsh/test";
import {
  canConnectPorts,
  defaultSettings,
  isPortKind,
  modelLabel,
  nodeKind,
  parseSettings,
  serializeSettings,
  statusLabel,
} from "./node-kinds";

test("parses settings with defaults for missing values", () => {
  const text = parseSettings("text", "{bad json");
  expect(text).toEqual({ version: 1, prompt: "", model: "mock-text" });

  const image = parseSettings(
    "image",
    JSON.stringify({ prompt: "A lake", aspect: "9:16", count: 99 }),
  );
  expect(image).toEqual({
    version: 1,
    prompt: "A lake",
    model: "mock-image",
    aspect: "9:16",
    count: 4,
  });
});

test("serializes and re-parses settings", () => {
  const settings = { ...defaultSettings("text"), prompt: "Hello" };
  expect(parseSettings("text", serializeSettings(settings))).toEqual(settings);
});

test("the kinds keep mock model labels", () => {
  expect(modelLabel("text")).toBe("Mock Text");
  expect(modelLabel("image")).toBe("Mock Image");
});

test("the image kind declares prompt, references and an image output", () => {
  const spec = nodeKind("image");
  expect(spec.inputs.map((port) => [port.id, port.kind, port.capacity])).toEqual([
    ["prompt", "text", 1],
    ["references", "image", 16],
  ]);
  expect(spec.outputs.map((port) => [port.id, port.kind])).toEqual([["image", "image"]]);
});

test("typed ports join only when their item types match", () => {
  expect(canConnectPorts("text", "text", "text", "prompt")).toBe(true);
  expect(canConnectPorts("text", "text", "image", "prompt")).toBe(true);
  expect(canConnectPorts("image", "image", "image", "references")).toBe(true);
  expect(canConnectPorts("text", "text", "image", "references")).toBe(false);
  expect(canConnectPorts("image", "image", "text", "prompt")).toBe(false);
  expect(canConnectPorts("text", "missing", "text", "prompt")).toBe(false);
  expect(canConnectPorts("text", "text", "text", "missing")).toBe(false);
  expect(isPortKind("image")).toBe(true);
  expect(isPortKind("audio")).toBe(false);
});

test("statuses have readable labels", () => {
  expect(statusLabel("done")).toBe("Done");
  expect(statusLabel("stale")).toBe("Upstream updated");
  expect(statusLabel("idle")).toBe("");
});
