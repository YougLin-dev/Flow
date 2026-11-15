import { openFlowDocument, type OpenedFlowDocument } from "../document";
import type { Document, ProjectInfo } from "../shared";
import type { ProjectLeasePort, ProjectStorePort } from "./project-store";

/**
 * A managed open: the lease, the live document and its startup report.
 * Release the lease only after the document's worker closed.
 */
export interface OpenProject {
  readonly lease: ProjectLeasePort;
  readonly document: Document;
  readonly info: ProjectInfo;
}

/** Options a managed document open always passes. */
export interface ManagedOpenOptions {
  readonly projectId: string;
  readonly seedDemo: false;
}

/** The collaboration points of a project session, injected for tests. */
export interface ProjectSessionDeps {
  readonly store: Pick<ProjectStorePort, "openProject">;
  /** The workspace teardown; `closed` is false when the close failed. */
  readonly shutdown: () => Promise<{ readonly closed: boolean }>;
  readonly openDocument: (path: string, options: ManagedOpenOptions) => Promise<OpenedFlowDocument>;
}

/** The production wiring: the real store and the workspace's shutdown. */
export function projectSessionDeps(
  store: ProjectStorePort,
  shutdown: () => Promise<{ readonly closed: boolean }>,
): ProjectSessionDeps {
  return {
    store,
    shutdown,
    openDocument: (path, options) => openFlowDocument(path, options),
  };
}

export const PROJECT_CLOSE_FAILED = "the open project could not be closed";

/**
 * Claims a project and opens its package through the managed path. A failed
 * open releases the lease, so the next attempt is not blocked by a package
 * that never had a live document.
 */
export async function openFlowProject(
  deps: ProjectSessionDeps,
  projectId: string,
): Promise<OpenProject> {
  const lease = await deps.store.openProject(projectId);
  try {
    const opened = await deps.openDocument(lease.databasePath, {
      projectId: lease.projectId,
      seedDemo: false,
    });
    return { lease, document: opened.document, info: opened.info };
  } catch (error) {
    lease.release();
    throw error;
  }
}

/**
 * Shuts the workspace down and releases the lease only when the document
 * worker actually closed. A failed close keeps the lease: the OS lock is the
 * guarantee that no second connection opens the same package. Returns
 * whether the lease was released.
 */
export async function closeFlowProject(
  deps: ProjectSessionDeps,
  project: OpenProject | null,
): Promise<boolean> {
  if (project === null) return true;
  const { closed } = await deps.shutdown();
  if (!closed) return false;
  project.lease.release();
  return true;
}

/**
 * Switches projects in order: stop and close the current document, dispose
 * the handle, release its lease, then claim and open the next. A failed
 * close stops the switch rather than opening a second package in this
 * window.
 */
export async function switchFlowProject(
  deps: ProjectSessionDeps,
  current: OpenProject | null,
  projectId: string,
): Promise<OpenProject> {
  const closed = await closeFlowProject(deps, current);
  if (!closed) throw new Error(PROJECT_CLOSE_FAILED);
  return openFlowProject(deps, projectId);
}
