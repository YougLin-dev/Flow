import { expect, open, test } from "nsh/test";
import { UNREADABLE_ID } from "./test-support/ProjectsPageProbe";

const SHORT_ID = UNREADABLE_ID.slice(0, 8);

test("an unreadable row offers only delete and names its package", async () => {
  const app = await open("./test-support/ProjectsPageProbe.tsx");
  await app.waitUntil(() => app.shows("text:Unavailable project"));

  await app.press(`label:Actions for Unavailable project ${SHORT_ID}`);
  await app.waitUntil(() => app.shows("text:Delete…"));
  // Rename and duplicate read the package identity, which a fallback row
  // does not have; only delete may stay.
  expect(app.shows("text:Rename…")).toBe(false);
  expect(app.shows("text:Duplicate…")).toBe(false);

  await app.press("text:Delete…");
  await app.waitUntil(() => app.shows("id:project-delete-dialog"));
  // The irreversible confirmation names the package, not just the shared
  // "Unavailable project" title.
  expect(app.texts().some((text) => text.includes(`Unavailable project ${SHORT_ID}`))).toBe(true);
});
