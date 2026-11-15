import { host } from "nsh";
import { Document } from "@flow/native";
import { databasePath } from "./database-path";
import { seedDocument } from "./seed";

/**
 * Opens this launch's document and finishes startup: runs left running by
 * the previous process become interrupted, and an empty document gets the
 * M1 text → image example.
 */
export async function openFlowDocument(): Promise<Document> {
  const path = databasePath({
    dataDir: process.dataDir,
    hostPath: host.params.databasePath,
    envPath: process.env.FLOW_DB_PATH,
  });
  const document = await Document.open(path);
  try {
    await document.recoverRuns();
    // A project seeds once. An empty project that already seeded keeps its
    // emptiness: deleting every card is not a reason to restore the demo.
    const info = await document.projectInfo();
    if (!info.demoSeeded && (await document.isEmpty())) {
      await seedDocument(document);
    }
  } catch (error) {
    document.dispose();
    throw error;
  }
  return document;
}
