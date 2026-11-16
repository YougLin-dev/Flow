import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { makeSession, until } from "../test/node-session-harness";

test("closes the composer when its node is removed", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.composerId() === TEXT_NODE_ID && session.detail() !== null);

  session.onChanges({
    rev: 1,
    changed: [],
    removed: [TEXT_NODE_ID],
    edgesChanged: [],
    edgesRemoved: [],
  });
  expect(session.composerId()).toBeNull();
  expect(session.detail()).toBeNull();

  runner.dispose();
  assets.dispose();
  document.dispose();
});
