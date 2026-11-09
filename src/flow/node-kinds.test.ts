import { expect, test } from "nsh/test";
import {
  canConnect,
  defaultSettings,
  modelLabel,
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

test("both M1 kinds connect, and model labels stay mock", () => {
  expect(canConnect("text", "image")).toBe(true);
  expect(canConnect("image", "text")).toBe(true);
  expect(canConnect("image", "image")).toBe(true);
  expect(modelLabel("text")).toBe("Mock Text");
  expect(modelLabel("image")).toBe("Mock Image");
});

test("statuses have readable labels", () => {
  expect(statusLabel("done")).toBe("Done");
  expect(statusLabel("stale")).toBe("Upstream updated");
  expect(statusLabel("idle")).toBe("");
});
