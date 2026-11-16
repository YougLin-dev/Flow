/**
 * The workspace teardown sequence, kept apart from the workspace so its
 * order, arguments and failure handling can be tested: stop the runs (their
 * batches settle cancelled), stop the views, then save the view and close the
 * package in one worker job, and finally free the handle.
 */

/**
 * Prefix of a close failure that ran to completion: the worker acknowledged
 * the close (and dropped its connection) but could not checkpoint cleanly.
 * The package is merely dirty and verifies on its next open, so the project
 * lease may be released. Mirrors `db/session.rs::CLOSE_FAILED_AFTER_STOP`.
 */
export const CLOSE_FAILED_AFTER_STOP = "the document closed with a recovery warning: ";

/** Whether a close rejection still left the worker stopped. */
export function closeStoppedWorker(error: unknown): boolean {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return message.startsWith(CLOSE_FAILED_AFTER_STOP);
}

export interface ShutdownCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ShutdownRunner {
  stop(): Promise<void>;
}

export interface ShutdownDocument {
  closeWithView(x: number, y: number, zoom: number): Promise<void>;
  close(): Promise<void>;
  dispose(): void;
}

export interface ShutdownPorts {
  readonly runner: ShutdownRunner | null;
  readonly document: ShutdownDocument | null;
  /** Null when no stage size arrived: the camera holds no user view. */
  readonly view: ShutdownCamera | null;
  readonly stopConsumers: () => void;
}

/**
 * Returns whether the document worker actually stopped. The project session
 * releases its package lease only on `true`: a close that failed before the
 * job ran may have left the connection open, and a second open on the same
 * package must not race it — a leak is better than two writers. A close that
 * failed after the worker acknowledged it (the recovery-warning marker) did
 * stop; its package stays dirty and verifies on the next open.
 */
export async function shutdownWorkspace(ports: ShutdownPorts): Promise<{ closed: boolean }> {
  await ports.runner?.stop();
  ports.stopConsumers();
  const document = ports.document;
  if (document === null) return { closed: false };
  let closed = false;
  try {
    if (ports.view !== null) {
      await document.closeWithView(ports.view.x, ports.view.y, ports.view.zoom);
    } else {
      await document.close();
    }
    closed = true;
  } catch (error) {
    console.error("Flow could not close its document", error);
    closed = closeStoppedWorker(error);
  }
  document.dispose();
  return { closed };
}
