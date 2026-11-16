import { expect, open, test } from "nsh/test";

test("the bar follows its title accessor", async () => {
  const app = await open("../../test-support/TitleBarProbe.tsx");
  await app.waitUntil(() => app.shows("text:Native canvas · NSH"));
  await app.press("id:set-title");
  await app.waitUntil(() => app.shows("text:Probe title"));
  expect(app.texts()).toContain("Probe title");
});
