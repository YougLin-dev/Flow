/**
 * The workspace teardown sequence, kept apart from the workspace so its
 * order, arguments and failure handling can be tested: stop the runs (their
 * batches settle cancelled), stop the views, then save the view and close the
 * package in one worker job, and finally free the handle.
 */

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

export async function shutdownWorkspace(ports: ShutdownPorts): Promise<void> {
  await ports.runner?.stop();
  ports.stopConsumers();
  const document = ports.document;
  if (document === null) return;
  try {
    if (ports.view !== null) {
      await document.closeWithView(ports.view.x, ports.view.y, ports.view.zoom);
    } else {
      await document.close();
    }
  } catch (error) {
    console.error("Flow could not close its document", error);
  }
  document.dispose();
}
