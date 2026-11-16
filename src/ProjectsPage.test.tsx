import { expect, open, test } from "nsh/test";
import { UNREADABLE_ID } from "./test-support/ProjectsPageProbe";

const SHORT_ID = UNREADABLE_ID.slice(0, 8);

test("an unreadable row keeps restore and delete and names its package", async () => {
  const app = await open("./test-support/ProjectsPageProbe.tsx");
  await app.waitUntil(() => app.shows("text:Unavailable project"));

  await app.press(`label:Actions for Unavailable project ${SHORT_ID}`);
  await app.waitUntil(() => app.shows("text:Delete…"));
  // Rename, duplicate and backup read the package identity, which a fallback
  // row does not have; restore replaces the package and is the recovery path,
  // and delete stays so a damaged package can be removed.
  expect(app.shows("text:Rename…")).toBe(false);
  expect(app.shows("text:Duplicate…")).toBe(false);
  expect(app.shows("text:Back up…")).toBe(false);
  expect(app.shows("text:Restore…")).toBe(true);

  await app.press("text:Delete…");
  await app.waitUntil(() => app.shows("id:project-delete-dialog"));
  // The irreversible confirmation names the package, not just the shared
  // "Unavailable project" title.
  expect(app.texts().some((text) => text.includes(`Unavailable project ${SHORT_ID}`))).toBe(true);
});

test("revalidates the list when the app returns to the foreground", async () => {
  const app = await open("./test-support/ProjectsForegroundProbe.tsx");
  await app.waitUntil(() => app.texts().includes("reads:1"));

  await app.setLifecycle("background");
  await app.setLifecycle("active");
  await app.waitUntil(() => app.texts().includes("reads:2"));
});

test("revalidates the list after a system wake while active", async () => {
  const app = await open("./test-support/ProjectsForegroundProbe.tsx");
  await app.waitUntil(() => app.texts().includes("reads:1"));

  await app.wake();
  await app.waitUntil(() => app.texts().includes("reads:2"));
});
