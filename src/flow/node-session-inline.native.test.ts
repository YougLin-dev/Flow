import { expect, test } from "nsh/test";
import { Document, type ResultBatchInput, type ResultItemInput } from "@flow/native";
import { IMAGE_NODE_ID, TEXT_NODE_ID, seedDocument } from "./data";
import { makeSession, until } from "./node-session-harness";

test("edits a text node inline and closes the editor on save", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  expect(session.inlineText()).toBe((await document.getNode(TEXT_NODE_ID))?.body);

  session.setInlineText("An inline edit");
  await session.commitInline();
  expect(session.inlineId()).toBeNull();
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.body).toBe("An inline edit");
  expect(after?.batch?.items[0]?.text).toBe("An inline edit");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("commits the inline draft once when blur and a press both ask", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  session.setInlineText("A pressed-away edit");

  // The input's blur and the canvas's press can both arrive for one gesture;
  // the first closes the editor, so the second must not write again.
  const first = session.commitInline();
  await session.commitInline();
  await first;

  expect(session.inlineId()).toBeNull();
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.body).toBe("A pressed-away edit");
  expect(after?.batch?.items[0]?.text).toBe("A pressed-away edit");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("a body written under the draft closes the editor without saving the draft", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  session.setInlineText("a draft a run overtook");

  // A run (or an undo) writes the body while the editor is open. The session
  // hears the change and closes the stale draft: the new content wins.
  const batch: ResultBatchInput = {
    id: "batch-elsewhere",
    nodeId: TEXT_NODE_ID,
    trigger: "run",
    provider: "mock",
    model: "",
    paramsJson: "{}",
    status: "done",
  };
  const item: ResultItemInput = {
    id: "item-elsewhere",
    position: 0,
    portId: "text",
    kind: "text",
    text: "written while editing",
  };
  const changes = await document.setManualText(TEXT_NODE_ID, "written while editing", batch, item);
  session.onChanges(changes);

  expect(session.inlineId()).toBeNull();
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.body).toBe("written while editing");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("keeps the draft open when its write fails", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  session.setInlineText("a draft that cannot be saved");

  // Closing the document under the session fails the write; the editor must
  // keep the draft rather than drop what the user typed.
  document.dispose();
  await session.commitInline();

  expect(session.inlineId()).toBe(TEXT_NODE_ID);
  expect(session.inlineText()).toBe("a draft that cannot be saved");

  runner.dispose();
  assets.dispose();
});

test("a write in flight does not close an editor reopened since", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(TEXT_NODE_ID);
  await until(() => session.inlineId() === TEXT_NODE_ID);
  session.setInlineText("the first draft");
  const write = session.commitInline();

  // The card is opened again before the first write lands: the reopened
  // editor owns the new draft, and the older write must not close it.
  await session.openInline(TEXT_NODE_ID);
  session.setInlineText("the second draft");
  await write;

  expect(session.inlineId()).toBe(TEXT_NODE_ID);
  expect(session.inlineText()).toBe("the second draft");
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.body).toBe("the first draft");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("double-clicking a non-text node opens its composer", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  await session.openInline(IMAGE_NODE_ID);
  await until(() => session.composerId() === IMAGE_NODE_ID && session.detail() !== null);
  expect(session.inlineId()).toBeNull();
  expect(session.detail()?.node.kind).toBe("image");

  runner.dispose();
  assets.dispose();
  document.dispose();
});
