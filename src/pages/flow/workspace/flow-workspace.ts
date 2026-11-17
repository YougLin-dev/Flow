/**
 * The flow workspace: one construction of the page's document session, scene,
 * camera, controllers and loaders. `FlowPage` creates it synchronously, owns
 * the effects, key bindings and render, and disposes it through cleanup; the
 * workspace owns the mutable document lifetime and every cross-object action.
 */
import { Picker, signal, type Signal } from "nsh";
import type {
  ChangeSet,
  Document,
  NodeBounds,
  ProjectInfo,
  SearchHit,
  StageSize,
} from "../../../flow/shared";
import { CanvasCamera, FlowScene } from "../../../flow/canvas";
import { CanvasController } from "../../../flow/canvas/interaction/canvas-controller";
import { ComposerState } from "../../../flow/composer";
import { CanvasMenuController } from "../../../flow/canvas/interaction/context-menu";
import {
  AssetUrls,
  CONTENT,
  MinimapLoader,
  NodeSession,
  PreviewLoader,
  ViewportController,
  applyOpenView,
  needsVerify,
  openFlowDocument,
  shutdownWorkspace,
  type OpenedFlowDocument,
} from "../../../flow/document";
import { NodeRunner } from "../../../flow/execution";
import { MinimapController } from "../../../flow/minimap";
import type { NodeKindId } from "../../../flow/nodes";
import {
  openFlowProject,
  type OpenProject,
  type ProjectLeasePort,
  type ProjectStorePort,
} from "../../../flow/projects";
import { createWorkspaceComposer, type WorkspaceComposer } from "./composer";
import { saveOpenDrafts } from "./save-drafts";
import { revealSearchHit } from "./search-navigation";

/** The managed project this workspace leases and opens. */
export interface WorkspaceProject {
  readonly store: ProjectStorePort;
  readonly projectId: string;
  /** The title at open time; the page owns the live title after a rename. */
  readonly title: string;
}

export interface FlowWorkspaceDeps {
  /** Publishes the camera's scale to the store's zoom readout. */
  readonly publishZoom: (percent: number) => void;
  /** The managed project to open; absent on the legacy single-document path. */
  readonly project?: WorkspaceProject | null | undefined;
  /** A managed open failed before a document existed; the shell leaves. */
  readonly onOpenError?: ((error: unknown) => void) | undefined;
}

export interface FlowWorkspace {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly stage: Signal<StageSize>;
  readonly searchOpen: Signal<boolean>;
  readonly minimapOpen: Signal<boolean>;
  readonly imageProbe: Signal<string>;
  readonly composerState: ComposerState;
  readonly controller: CanvasController;
  readonly canvasMenu: CanvasMenuController;
  readonly minimap: MinimapLoader;
  readonly minimapDrag: MinimapController;
  readonly session: () => NodeSession | null;
  readonly composerPosition: WorkspaceComposer["position"];
  readonly composerOpen: () => boolean;
  readonly openComposer: (id: string) => void;
  readonly closeComposer: () => void;
  readonly closeInlineDraft: () => void;
  readonly selectEdge: (id: string | null) => void;
  readonly addNode: (kind: NodeKindId) => void;
  readonly deleteSelected: () => void;
  readonly undoRedo: (direction: "undo" | "redo") => Promise<void>;
  readonly panBy: (dx: number, dy: number) => void;
  /** The unguarded pan the canvas's own gestures use. */
  readonly panViewport: (dx: number, dy: number) => void;
  readonly zoomCanvas: (factor: number, x: number, y: number) => void;
  readonly setZoom: (factor: number) => void;
  readonly fit: () => void;
  readonly searchCards: (query: string, kind: string | null) => Promise<SearchHit[]>;
  readonly selectSearchHit: (hit: SearchHit) => void;
  /** Renames the open managed project; a closed document is refused. */
  readonly renameProject: (title: string) => Promise<void>;
  /** Applies a new stage size; the first one fits and opens the document. */
  readonly handleSize: (size: StageSize) => void;
  /** Releases every object in the page's cleanup order, once. */
  readonly dispose: () => void;
  /**
   * The quit path: stops runs, saves the camera, checkpoints and closes the
   * package. Resolves with whether the document worker stopped (the project
   * session releases its lease only then); idempotent.
   */
  readonly shutdown: () => Promise<{ readonly closed: boolean }>;
}

/**
 * How long the shell stays responsive before the recovery check runs. The
 * quit listener is capped at 200 ms and the single worker is FIFO, so the
 * check must not overlap the first moments (or an immediate quit).
 */
const VERIFY_DELAY_MS = 1500;

export function createFlowWorkspace(deps: FlowWorkspaceDeps): FlowWorkspace {
  let document: Document | null = null;
  let assets: AssetUrls | null = null;
  let runner: NodeRunner | null = null;
  // The managed session: its lease is released only after the worker closed.
  let project: OpenProject | null = null;
  let disposed = false;
  let opening = false;
  let openingTask: Promise<void> | null = null;
  let verifyTimer: ReturnType<typeof setTimeout> | null = null;
  let sized = false;
  let cameraReady = false;
  let shuttingDown = false;
  let shutdownResult: { readonly closed: boolean } | null = null;
  // The in-flight close, shared by every caller: a second quit path must
  // observe the close that is already running, not a premature "not closed".
  let shutdownTask: Promise<{ readonly closed: boolean }> | null = null;

  const scene = new FlowScene();
  const camera = new CanvasCamera();
  const stage = signal<StageSize>({ width: 1, height: 1 });
  const sessionState = signal<NodeSession | null>(null);
  const searchOpen = signal(false);
  const minimapOpen = signal(true);
  const imageProbe = signal("");
  const composerState = new ComposerState();

  const currentSession = (): NodeSession | null => sessionState();

  const previews = new PreviewLoader({
    document: () => document,
    assets: () => assets,
    scene: () => scene,
    isDisposed: () => disposed,
  });
  const schedulePreviews = (): void => previews.schedule();

  const minimap = new MinimapLoader({
    document: () => document,
    isDisposed: () => disposed,
  });

  const applyChanges = (changes: ChangeSet): void => {
    viewport.noteRev(changes.rev);
    minimap.noteChanges(changes);
    // Close a composer whose node the change set removed before the scene
    // publishes its new selection: the selection effect saves drafts, and a
    // deleted row cannot take one.
    currentSession()?.onChanges(changes);
    scene.applyChangeSet(changes);
    schedulePreviews();
    // A command can add cards the viewport has never read; without a read
    // they would stay mounted off screen until the next pan or zoom.
    viewport.schedule();
  };

  const viewport = new ViewportController({
    camera: () => camera,
    scene: () => scene,
    document: () => document,
    fallbackBounds: () => CONTENT,
    applyChanges,
    schedulePreviews,
    publishZoom: deps.publishZoom,
    isDisposed: () => disposed,
  });

  const minimapDrag = new MinimapController((x, y) => viewport.centerOn(x, y));

  const commitBounds = (bounds: readonly NodeBounds[]): void => {
    const doc = document;
    if (!doc || disposed || bounds.length === 0) return;
    void (async () => {
      try {
        const changes = await doc.setNodeBounds([...bounds]);
        if (!disposed) applyChanges(changes);
      } catch (error) {
        console.error("Flow could not persist the gesture", error);
        scene.clearOverrides();
      }
    })();
  };

  const selectEdge = (id: string | null): void => {
    scene.selectEdge(id);
    if (id === null) return;
    scene.select([]);
  };

  const controller = new CanvasController({
    scene: () => scene,
    camera: () => camera,
    panBy: (dx, dy) => viewport.panBy(dx, dy),
    commitBounds,
    selectEdge,
    reconnectEdge: (edgeId, pair) => void currentSession()?.reconnectEdge(edgeId, pair),
    connectNodes: (pairs) => void currentSession()?.connectNodes(pairs),
    openInline: (nodeId) => {
      const session = currentSession();
      if (!session || session.inlineId() === nodeId) return;
      // The inline editor takes the composer's place; writing its drafts
      // first keeps an edit made in the composer from vanishing.
      if (session.inlineId() !== null) closeInlineDraft();
      if ((session.composerId() ?? null) !== null) closeComposer();
      void session.openInline(nodeId);
    },
    // A multi-card selection has no composer; the effect below closes one
    // that was open, so do not start loading a new one here.
    onCardPress: (id) => {
      if (scene.selection().length === 1) openComposer(id);
    },
  });

  const composer = createWorkspaceComposer({
    session: currentSession,
    state: composerState,
    scene,
    camera,
    controller,
    stage,
  });
  const composerPosition = composer.position;
  const composerOpen = composer.open;
  const openComposer = composer.openAt;
  const closeComposer = composer.close;
  const closeInlineDraft = composer.closeInlineDraft;

  /** Copies the card as the user sees it, including an open editor's drafts. */
  const copyNode = (nodeId: string): void => {
    const session = currentSession();
    if (session) void session.copyNodeWithDrafts(nodeId, composerState.settings());
  };

  const canvasMenu = new CanvasMenuController({
    camera: () => camera,
    controller: () => controller,
    scene: () => scene,
    addNode: (kind, x, y) => void currentSession()?.addNode(kind, x, y),
    copyNode,
    deleteNode: (nodeId) =>
      void currentSession()?.deleteNodeWithDrafts(nodeId, composerState.settings()),
    editBody: (nodeId) => void currentSession()?.openInline(nodeId),
    selectEdge,
    deleteEdge: (edgeId) => void currentSession()?.deleteEdge(edgeId),
  });

  const panViewport = (dx: number, dy: number): void => viewport.panBy(dx, dy);

  const panBy = (dx: number, dy: number): void => {
    if (searchOpen()) return;
    viewport.panBy(dx, dy);
  };

  // Zooming mid-gesture would re-map the press point under a moved camera and
  // jump the dragged cards; the gesture owns the pointer until release.
  const zoomCanvas = (factor: number, x: number, y: number): void => {
    if (controller.gesturing()) return;
    viewport.zoomAround(factor, x, y);
  };

  const setZoom = (factor: number): void => {
    const size = stage();
    zoomCanvas(factor, size.width / 2, size.height / 2);
  };

  const fit = (): void => void viewport.fitToDocument();

  const searchCards = async (query: string, kind: string | null): Promise<SearchHit[]> =>
    document?.search(query, { kind }, 20) ?? [];

  const revealNode = (id: string): Promise<void> =>
    revealSearchHit({ document, viewport, scene, isDisposed: () => disposed, openComposer }, id);

  const selectSearchHit = (hit: SearchHit): void => {
    searchOpen.set(false);
    void revealNode(hit.id);
  };

  /**
   * The live rename: one worker command changes the document title and its
   * timestamp without an undo step. The project list re-reads the package
   * from its changed stamp on the next list; no catalog write is needed here.
   */
  const renameProject = async (title: string): Promise<void> => {
    // A quick submit may race the managed open; wait for it rather than
    // reporting "not open" for a project that is opening.
    await openingTask;
    if (project === null || document === null) {
      throw new Error("the project is not open");
    }
    await document.setProjectTitle(title);
  };

  const scheduleVerify = (doc: Document, report: ProjectInfo): void => {
    if (!needsVerify(report)) return;
    verifyTimer = setTimeout(() => {
      verifyTimer = null;
      // A quit may start before the timer fires; the check would otherwise
      // hold the single worker ahead of the close job.
      if (disposed || shuttingDown) return;
      void doc
        .verify()
        .then(() => {
          if (disposed) return;
          // A repair changes the connector/node indexes and the bounds
          // without a revision, so publish a fresh read.
          viewport.schedule();
          minimap.schedule();
        })
        .catch((error) => {
          // Quit aborts or skips the check; that is not a failure to report.
          if (!disposed && !shuttingDown) {
            console.error("Flow could not verify its document", error);
          }
        });
    }, VERIFY_DELAY_MS);
  };

  const openFlow = async (): Promise<void> => {
    if (document || opening || disposed || shuttingDown) return;
    opening = true;
    const managed = deps.project ?? null;
    try {
      let opened: OpenedFlowDocument;
      let lease: ProjectLeasePort | null = null;
      if (managed === null) {
        opened = await openFlowDocument();
      } else {
        // The session takes the package lock and opens the package; it
        // releases the lease itself when the open fails.
        const session = await openFlowProject(
          {
            store: managed.store,
            shutdown: () => shutdown(),
            openDocument: (path, options) => openFlowDocument(path, options),
          },
          managed.projectId,
        );
        project = session;
        lease = session.lease;
        opened = session;
      }
      if (disposed) {
        // The page went away while the package opened: close it before
        // letting the lease go, and keep the lease if the close failed.
        const result = await shutdownWorkspace({
          runner: null,
          document: opened.document,
          view: null,
          stopConsumers: () => {},
        });
        if (lease !== null && result.closed) {
          lease.release();
          project = null;
        }
        return;
      }
      document = opened.document;
      assets = new AssetUrls(opened.document);
      runner = new NodeRunner(opened.document, {
        onChange: (changes) => {
          if (!disposed) applyChanges(changes);
        },
        onSettled: (nodeId) => {
          if (!disposed) currentSession()?.onSettled(nodeId);
        },
      });
      sessionState.set(
        new NodeSession({
          document: () => document,
          scene: () => scene,
          assets: () => assets,
          runner: () => runner,
          pickImages: (options) => Picker.pickImages(options),
          applyChanges,
          schedulePreviews,
          activateNode: (nodeId) => scene.select([nodeId]),
          isDisposed: () => disposed,
        }),
      );
      minimap.schedule();
      // A saved view wins over the startup fit, and a later resize must not
      // replace it with an automatic fit.
      if (applyOpenView(camera, viewport, opened.info) === "fit") {
        await viewport.fitToDocument(false, false);
      }
      await viewport.refresh();
      if (!disposed) {
        cameraReady = true;
        viewport.announceZoom(camera.scale);
        scheduleVerify(opened.document, opened.info);
      }
    } catch (error) {
      console.error("Flow could not open its document", error);
      if (!disposed) {
        if (managed === null) {
          camera.fit(CONTENT, stage());
        } else {
          // The package may have opened before the failure: close it (and
          // release its lease when the worker acknowledged) before the
          // window goes, so a retry can open the project again. This cannot
          // call `shutdown()`: it waits for this very open.
          shuttingDown = true;
          const result = await shutdownWorkspace({
            runner,
            document,
            view: null,
            stopConsumers: stopLoaders,
          });
          if (result.closed && project !== null) {
            project.lease.release();
            project = null;
          }
          // This window is leaving: a close that failed cannot be retried
          // from here, so release its handle with the window. The lease stays
          // until the app quits when the close was not acknowledged.
          if (!result.closed) document?.dispose();
          forgetDocument();
          deps.onOpenError?.(error);
        }
      }
    } finally {
      opening = false;
    }
  };

  const startOpen = (): void => {
    const task = openFlow();
    openingTask = task;
    void task.finally(() => {
      if (openingTask === task) openingTask = null;
    });
  };

  const addNode = (kind: NodeKindId): void => {
    const active = currentSession();
    const size = stage();
    const center = camera.toWorld(size.width / 2, size.height / 2);
    void active?.addNode(kind, center.x, center.y);
  };

  const deleteSelected = (): void => {
    const doc = document;
    if (!doc || disposed || (currentSession()?.composerId() ?? null) !== null) return;
    const edge = scene.selectedEdge();
    if (edge !== null) {
      selectEdge(null);
      void currentSession()?.deleteEdge(edge);
      return;
    }
    const ids = [...scene.selection()];
    if (ids.length === 0) return;
    scene.select([]);
    if (!disposed) void currentSession()?.deleteNodes(ids);
  };

  const undoRedo = async (direction: "undo" | "redo"): Promise<void> => {
    const doc = document;
    if (!doc || disposed) return;
    try {
      const changes = direction === "undo" ? await doc.undo() : await doc.redo();
      if (disposed) return;
      applyChanges(changes);
      viewport.schedule();
    } catch (error) {
      console.error(`Flow could not ${direction}`, error);
    }
  };

  const handleSize = (size: StageSize): void => {
    stage.set(size);
    viewport.setSize(size.width, size.height);
    if (!sized) {
      sized = true;
      camera.fit(CONTENT, size);
      startOpen();
      return;
    }
    viewport.onResize(size.width, size.height);
  };

  let loadersStopped = false;
  const stopLoaders = (): void => {
    if (loadersStopped) return;
    loadersStopped = true;
    canvasMenu.close();
    disposed = true;
    if (verifyTimer !== null) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    previews.dispose();
    minimap.dispose();
    minimapDrag.dispose();
    viewport.dispose();
    runner?.dispose();
    assets?.dispose();
    runner = null;
    assets = null;
    sessionState.set(null);
  };

  const forgetDocument = (): void => {
    document = null;
    assets = null;
    runner = null;
  };

  const dispose = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // No close ran, so the project layer must keep its lease.
    shutdownResult = { closed: false };
    stopLoaders();
    document?.dispose();
    forgetDocument();
  };

  const shutdown = (): Promise<{ readonly closed: boolean }> => {
    if (shutdownTask !== null) return shutdownTask;
    if (shuttingDown) return Promise.resolve(shutdownResult ?? { closed: false });
    shuttingDown = true;
    const task = (async () => {
      // A quit can race the open: wait for the handle it produces instead of
      // leaving that package neither closed nor disposed.
      const pending = openingTask;
      if (pending !== null) await pending;
      if (document === null && project === null) {
        // Nothing was ever opened: there is nothing to close.
        shutdownResult = { closed: true };
        return shutdownResult;
      }
      // Drafts are document state: write them before the close job.
      await saveOpenDrafts(currentSession(), composerState);
      // An unfitted camera carries no view the user saw; keep the old one.
      const view = cameraReady ? camera.view() : null;
      const result = await shutdownWorkspace({
        runner,
        document,
        view: view === null ? null : { x: view.x, y: view.y, zoom: view.scale },
        stopConsumers: stopLoaders,
      });
      shutdownResult = result;
      // Release the package only after the worker acknowledged the close; a
      // failed close keeps the lease (a leaked lock beats two writers).
      if (result.closed && project !== null) {
        project.lease.release();
        project = null;
      }
      if (result.closed) forgetDocument();
      if (!result.closed) {
        // A failed close is not final: the next close press retries it.
        shutdownTask = null;
        shuttingDown = false;
      }
      return result;
    })();
    shutdownTask = task;
    return task;
  };

  return {
    scene,
    camera,
    stage,
    searchOpen,
    minimapOpen,
    imageProbe,
    composerState,
    controller,
    canvasMenu,
    minimap,
    minimapDrag,
    session: currentSession,
    composerPosition,
    composerOpen,
    openComposer,
    closeComposer,
    closeInlineDraft,
    selectEdge,
    addNode,
    deleteSelected,
    undoRedo,
    panBy,
    panViewport,
    zoomCanvas,
    setZoom,
    fit,
    searchCards,
    selectSearchHit,
    renameProject,
    handleSize,
    dispose,
    shutdown,
  };
}
