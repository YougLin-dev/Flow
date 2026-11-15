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
import { ComposerState, composerPlacement } from "../../../flow/composer";
import { CanvasMenuController } from "../../../flow/canvas/interaction/context-menu";
import {
  AssetUrls,
  CONTENT,
  MinimapLoader,
  NodeSession,
  PreviewLoader,
  ViewportController,
  applyOpenView,
  closeDocumentQuietly,
  needsVerify,
  openFlowDocument,
  shutdownWorkspace,
} from "../../../flow/document";
import { NodeRunner } from "../../../flow/execution";
import { MinimapController } from "../../../flow/minimap";
import type { NodeKindId } from "../../../flow/nodes";
import { revealSearchHit } from "./search-navigation";

export interface FlowWorkspaceDeps {
  /** Publishes the camera's scale to the store's zoom readout. */
  readonly publishZoom: (percent: number) => void;
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
  readonly composerPosition: () => ReturnType<typeof composerPlacement>;
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
  /** Applies a new stage size; the first one fits and opens the document. */
  readonly handleSize: (size: StageSize) => void;
  /** Releases every object in the page's cleanup order, once. */
  readonly dispose: () => void;
  /**
   * The quit path: stops runs, saves the camera, checkpoints and closes the
   * package. Resolves when the document is closed; idempotent.
   */
  readonly shutdown: () => Promise<void>;
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
  let disposed = false;
  let opening = false;
  let openingTask: Promise<void> | null = null;
  let verifyTimer: ReturnType<typeof setTimeout> | null = null;
  let sized = false;
  let cameraReady = false;

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

  const closeComposer = (): void => {
    const session = currentSession();
    composerState.save(session, session?.detail() ?? null);
    composerState.reset();
    session?.closeComposer();
  };

  /** Writes the inline editor's draft and closes it. */
  const closeInlineDraft = (): void => {
    void currentSession()?.commitInline();
  };

  const openComposer = (id: string): void => {
    const session = currentSession();
    if (!session) return;
    // An upload card is its own control: selecting it closes an editor left
    // open elsewhere, but shows the card's own button instead of a composer.
    if (scene.node(id)?.kind === "upload") {
      if (session.inlineId() !== null) closeInlineDraft();
      if (session.composerId() !== null) closeComposer();
      return;
    }
    const previous = session.composerId();
    if (previous === id) return;
    // Switching cards directly (a click or a search result) must keep the
    // open composer's drafts; only the close paths saved them before.
    if (previous !== null) {
      composerState.save(session, session.detail());
      composerState.reset();
    }
    if (session.inlineId() !== null && session.inlineId() !== id) closeInlineDraft();
    if (session.inlineId() === id) return;
    session.openComposer(id);
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

  const composerPosition = (): ReturnType<typeof composerPlacement> =>
    composerPlacement(
      currentSession()?.composerId() ?? null,
      // A click on the selected card stays a click: only real movement (a
      // drag, a resize or a pulled connector) hides the composer, so its
      // native input keeps its draft and caret while the press is held.
      controller.gestureMoved(),
      (id) => scene.cardRect(id),
      camera,
      stage(),
    );

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

  const scheduleVerify = (doc: Document, report: ProjectInfo): void => {
    if (!needsVerify(report)) return;
    verifyTimer = setTimeout(() => {
      verifyTimer = null;
      if (disposed) return;
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
          console.error("Flow could not verify its document", error);
        });
    }, VERIFY_DELAY_MS);
  };

  const openFlow = async (): Promise<void> => {
    if (document || opening || disposed) return;
    opening = true;
    try {
      const opened = await openFlowDocument();
      if (disposed) {
        await closeDocumentQuietly(opened.document);
        opened.document.dispose();
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
      if (!disposed) camera.fit(CONTENT, stage());
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

  const composerOpen = (): boolean => (currentSession()?.composerId() ?? null) !== null;

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

  let shuttingDown = false;

  const stopLoaders = (): void => {
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
    stopLoaders();
    document?.dispose();
    forgetDocument();
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A quit can race the open: wait for the handle it produces instead of
    // leaving that package neither closed nor disposed.
    const task = openingTask;
    if (task !== null) await task;
    // Before the camera has been fitted or restored it carries no view the
    // user saw; saving it would overwrite the previous session's camera.
    const view = cameraReady ? camera.view() : null;
    await shutdownWorkspace({
      runner,
      document,
      view: view === null ? null : { x: view.x, y: view.y, zoom: view.scale },
      stopConsumers: stopLoaders,
    });
    forgetDocument();
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
    handleSize,
    dispose,
    shutdown,
  };
}
