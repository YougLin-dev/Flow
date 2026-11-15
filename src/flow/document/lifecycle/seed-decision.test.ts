import { expect, test } from "nsh/test";
import { seedDemoDefault, shouldSeedDocument } from "./seed-decision";

test("seeds only an empty, unseeded project that permits it", () => {
  expect(shouldSeedDocument(true, false, true)).toBe(true);
});

test("a managed blank project never auto-seeds", () => {
  expect(shouldSeedDocument(false, false, true)).toBe(false);
});

test("a seeded project stays empty after its content is deleted", () => {
  expect(shouldSeedDocument(true, true, true)).toBe(false);
});

test("a project with content is never seeded", () => {
  expect(shouldSeedDocument(true, false, false)).toBe(false);
});

test("only the legacy path auto-seeds by default", () => {
  expect(seedDemoDefault(undefined)).toBe(true);
  expect(seedDemoDefault("0123456789abcdef0123456789abcdef")).toBe(false);
});
