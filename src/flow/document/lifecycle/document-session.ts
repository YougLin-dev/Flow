import { host } from "nsh";
import { Document, type ProjectInfo } from "@flow/native";
import { databasePath } from "./database-path";
import { seedDocument } from "./seed";

/** The open document plus the report the workspace starts from. */
export interface OpenedFlowDocument {
  readonly document: Document;
  readonly info: ProjectInfo;
}

/**
 * Opens this launch's document and finishes startup: runs left running by
 * the previous process become interrupted, and an empty document gets the
 * M1 text → image example. `pathOverride` is for tests that open an
 * in-memory package without a data directory.
 */
export async function openFlowDocument(pathOverride?: string): Promise<OpenedFlowDocument> {
  const path =
    pathOverride ??
    databasePath({
      dataDir: process.dataDir,
      hostPath: host.params.databasePath,
      envPath: process.env.FLOW_DB_PATH,
    });
  const document = await Document.open(path);
  try {
    await document.recoverRuns();
    // Package maintenance: the undo history is empty at open, so terminal
    // batches and assets no live row references can be removed. A collection
    // failure is not a reason to keep the project shut.
    try {
      await document.gc();
    } catch (error) {
      console.error("Flow could not collect its package", error);
    }
    // A project seeds once. An empty project that already seeded keeps its
    // emptiness: deleting every card is not a reason to restore the demo.
    let info = await document.projectInfo();
    if (!info.demoSeeded && (await document.isEmpty())) {
      await seedDocument(document);
      // Report the seeded counts, not the pre-seed ones.
      info = await document.projectInfo();
    }
    return { document, info };
  } catch (error) {
    await closeDocumentQuietly(document);
    document.dispose();
    throw error;
  }
}

/** Closes a document without masking the failure that led here. */
export async function closeDocumentQuietly(document: Document): Promise<void> {
  try {
    await document.close();
  } catch (error) {
    console.error("Flow could not close its document", error);
  }
}
