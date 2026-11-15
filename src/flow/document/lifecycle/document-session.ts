import { host } from "nsh";
import { Document, type ProjectInfo } from "@flow/native";
import { databasePath } from "./database-path";
import { seedDemoDefault, shouldSeedDocument } from "./seed-decision";
import { seedDocument } from "./seed";

/** The open document plus the report the workspace starts from. */
export interface OpenedFlowDocument {
  readonly document: Document;
  readonly info: ProjectInfo;
}

/** How this launch's document is opened. */
export interface OpenFlowDocumentOptions {
  /** Open an existing managed package and require this document identity. */
  readonly projectId?: string;
  /**
   * Whether the M1 example may seed an empty document. The legacy/dev path
   * defaults to true; managed projects pass false and decide at creation.
   */
  readonly seedDemo?: boolean;
}

/**
 * Opens this launch's document and finishes startup: runs left running by
 * the previous process become interrupted, and an empty document gets the
 * M1 text → image example. `pathOverride` is for tests that open an
 * in-memory package without a data directory; the project layer passes a
 * lease's database path with its `projectId`.
 */
export async function openFlowDocument(
  pathOverride?: string,
  options: OpenFlowDocumentOptions = {},
): Promise<OpenedFlowDocument> {
  const path =
    pathOverride ??
    databasePath({
      dataDir: process.dataDir,
      hostPath: host.params.databasePath,
      envPath: process.env.FLOW_DB_PATH,
    });
  const document =
    options.projectId === undefined
      ? await Document.open(path)
      : await Document.openPackage(path, options.projectId);
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
    const seedDemo = options.seedDemo ?? seedDemoDefault(options.projectId);
    if (shouldSeedDocument(seedDemo, info.demoSeeded, await document.isEmpty())) {
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
