import { host } from "nsh";
import { Document } from "@flow/native";
import { databasePath } from "./database-path";
import { seedDocument } from "./data";

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
    if ((await document.count()) === 0 && (await document.edgeCount()) === 0) {
      await seedDocument(document);
    }
  } catch (error) {
    document.dispose();
    throw error;
  }
  return document;
}
