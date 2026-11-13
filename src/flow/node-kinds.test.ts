import { expect, test } from "nsh/test";
import {
  canConnectPorts,
  defaultSettings,
  isPortKind,
  MEDIA_KINDS,
  modelLabel,
  parseSettings,
  portsOfNode,
  serializeSettings,
  statusLabel,
  type PortSchemaSource,
} from "./node-kinds";

const textSubject: PortSchemaSource = { kind: "text", settingsJson: "" };
const imageSubject: PortSchemaSource = { kind: "image", settingsJson: "" };

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
  expect(modelLabel("upload")).toBe("Local file");
});

test("the image kind declares prompt, references and an image output", () => {
  const spec = portsOfNode(imageSubject);
  expect(spec.inputs.map((port) => [port.id, port.kind, port.capacity])).toEqual([
    ["prompt", "text", 1],
    ["references", "image", 16],
  ]);
  expect(spec.outputs.map((port) => [port.id, port.kind])).toEqual([["image", "image"]]);
});

test("an upload node's outputs follow its media settings", () => {
  const empty = portsOfNode({
    kind: "upload",
    settingsJson: JSON.stringify({ version: 1, media: [] }),
  });
  expect(empty.inputs).toEqual([]);
  expect(empty.outputs).toEqual([]);

  const uploaded = portsOfNode({
    kind: "upload",
    settingsJson: JSON.stringify({ version: 1, media: ["image"] }),
  });
  expect(uploaded.inputs).toEqual([]);
  expect(uploaded.outputs).toEqual([{ id: "image", name: "Image", kind: "image" }]);
});

test("upload settings keep only known media, in registry order", () => {
  expect(parseSettings("upload", "{bad json")).toEqual({ version: 1, media: [] });
  expect(
    parseSettings("upload", JSON.stringify({ version: 1, media: ["audio", "image", "image"] })),
  ).toEqual({ version: 1, media: ["image"] });
  expect(defaultSettings("upload")).toEqual({ version: 1, media: [] });
  expect(MEDIA_KINDS).toEqual(["image"]);
});

test("typed ports join only when their item types match", () => {
  const textPorts = portsOfNode(textSubject);
  const imagePorts = portsOfNode(imageSubject);
  const uploadPorts = portsOfNode({
    kind: "upload",
    settingsJson: JSON.stringify({ version: 1, media: ["image"] }),
  });
  expect(canConnectPorts(textPorts, "text", textPorts, "prompt")).toBe(true);
  expect(canConnectPorts(textPorts, "text", imagePorts, "prompt")).toBe(true);
  expect(canConnectPorts(imagePorts, "image", imagePorts, "references")).toBe(true);
  expect(canConnectPorts(uploadPorts, "image", imagePorts, "references")).toBe(true);
  expect(canConnectPorts(textPorts, "text", imagePorts, "references")).toBe(false);
  expect(canConnectPorts(imagePorts, "image", textPorts, "prompt")).toBe(false);
  expect(canConnectPorts(textPorts, "missing", textPorts, "prompt")).toBe(false);
  expect(canConnectPorts(textPorts, "text", textPorts, "missing")).toBe(false);
  expect(isPortKind("image")).toBe(true);
  expect(isPortKind("audio")).toBe(false);
});

test("statuses have readable labels", () => {
  expect(statusLabel("done")).toBe("Done");
  expect(statusLabel("stale")).toBe("Upstream updated");
  expect(statusLabel("idle")).toBe("");
});

test("an unknown kind keeps the compatibility port schema", () => {
  const ports = portsOfNode({ kind: "future-kind", settingsJson: "{}" });
  expect(ports.outputs.map((port) => port.kind)).toEqual(["text"]);
  expect(ports.inputs.find((port) => port.id === "references")?.capacity).toBe(16);
});
