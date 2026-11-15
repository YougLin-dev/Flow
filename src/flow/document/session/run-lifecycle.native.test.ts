import { expect, test } from "nsh/test";
import { Document } from "@flow/native";
import { TEXT_NODE_ID, seedDocument } from "../lifecycle/seed";
import { parseSettings } from "../../nodes";
import { makeSession, until } from "../test/node-session-harness";

test("cancels a run and keeps the last output", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const opened = session.detail();
  if (!opened) throw new Error("the composer did not open");
  await session.run(parseSettings(opened.node.kind, opened.node.settingsJson));
  const done = await document.nodeDetail(TEXT_NODE_ID);
  const output = done?.batch;
  if (!done || !output) throw new Error("the first run stored no output");
  expect(done.node.status).toBe("done");

  // A second run cancelled mid-flight records its batch but keeps the first
  // run's output, body and status line.
  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not reopen");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  session.cancel();
  await pending;

  const after = await document.nodeDetail(TEXT_NODE_ID);
  if (!after) throw new Error("the text node disappeared");
  expect(after.node.status).toBe("cancelled");
  expect(after.batch?.id).toBe(output.id);
  expect(after.node.outputBatchId).toBe(output.id);
  expect(after.node.body).toBe(done.node.body);
  expect(after.latestBatch?.status).toBe("cancelled");
  expect(after.latestBatch?.error).toBeNull();

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("deleting a running node cancels its run", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  await session.deleteNodes([TEXT_NODE_ID]);
  await pending;

  expect(runner.isRunning(TEXT_NODE_ID)).toBe(false);
  expect(await document.nodeDetail(TEXT_NODE_ID)).toBeNull();

  // Undo restores the card in a terminal state, not stuck running.
  const undone = await document.undo();
  const restored = undone.changed.find((node) => node.id === TEXT_NODE_ID);
  expect(restored?.status).toBe("cancelled");
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.status).toBe("cancelled");
  expect(after?.latestBatch?.status).toBe("cancelled");

  runner.dispose();
  assets.dispose();
  document.dispose();
});

test("stopping the runner settles a running batch before a close", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  await runner.stop();
  await pending;

  expect(runner.isRunning(TEXT_NODE_ID)).toBe(false);
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.status).toBe("cancelled");
  expect(after?.latestBatch?.status).toBe("cancelled");
  await document.close();
  document.dispose();
  assets.dispose();
});

test("disposing the runner mid-run leaves the batch for startup recovery", async () => {
  const document = await Document.open(":memory:");
  await seedDocument(document);
  const { session, runner, assets } = makeSession(document);

  session.openComposer(TEXT_NODE_ID);
  await until(() => session.detail()?.node.id === TEXT_NODE_ID);
  const detail = session.detail();
  if (!detail) throw new Error("the composer did not open");
  const pending = session.run(parseSettings(detail.node.kind, detail.node.settingsJson));
  await until(() => runner.isRunning(TEXT_NODE_ID));
  runner.dispose();
  await pending;

  // The app is closing, so the runner leaves the run open for the next open
  // to settle rather than writing through a database that may be gone.
  const abandoned = await document.nodeDetail(TEXT_NODE_ID);
  expect(abandoned?.node.status).toBe("running");
  expect(abandoned?.latestBatch?.status).toBe("running");

  expect(await document.recoverRuns()).toBeGreaterThan(0);
  const after = await document.nodeDetail(TEXT_NODE_ID);
  expect(after?.node.status).toBe("interrupted");
  expect(after?.latestBatch?.status).toBe("interrupted");

  assets.dispose();
  document.dispose();
});
