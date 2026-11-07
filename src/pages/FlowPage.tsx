import { cleanup, colorScheme, effect, host, keymap, signal, View } from "nsh";
import { isAvailable } from "nsh/desktop";
import type { App as LeaferApp, IEditorBase } from "@leafer-ui/miniapp";
import {
  Document,
  type ChangeSet,
  type NodeInput,
  type SearchHit,
  type Viewport,
} from "@flow/native";
import { BrandCard } from "../components/BrandCard";
import { HintBar } from "../components/HintBar";
import { SearchButton } from "../components/SearchButton";
import { SearchPalette, type SearchFilter } from "../components/SearchPalette";
import { SelectionBadge } from "../components/SelectionBadge";
import { ToolSwitch } from "../components/ToolSwitch";
import { ZoomControls } from "../components/ZoomControls";
import { CONTENT, seedEdges, seedNodes } from "../flow/data";
import { databasePath } from "../flow/database-path";
import { drawGrid } from "../flow/grid";
import { FlowScene } from "../flow/scene";
import { CanvasCamera } from "../leafer/camera";
import { refreshEditBox } from "../leafer/editor-box";
import { LeaferView } from "../leafer/LeaferView";
import {
  currentTool,
  selectedCount,
  setSelectedCount,
  setTool,
  setZoomPercent,
  zoomPercent,
} from "../store";

const VIEWPORT_MARGIN = 0.25;
const VIEWPORT_DELAY_MS = 80;

const SEARCH_FILTERS: readonly SearchFilter[] = [
  { label: "All", kind: null },
  { label: "Panels", kind: "panel" },
];

/**
 * The flow workspace: a Leafer canvas, its camera, and the controls that
 * float over it. The page owns the camera and the editor for as long as it is
 * mounted; the shared tool, zoom and selection values live in the store.
 *
 * The document lives in Rust. This page only keeps the visible cards in Leaner
 * and sends one command per user gesture.
 */
export function FlowPage() {
  let app: LeaferApp | null = null;
  let camera: CanvasCamera | null = null;
  let editor: IEditorBase | null = null;
  let scene: FlowScene | null = null;
  let document: Document | null = null;
  let stageWidth = 1;
  let stageHeight = 1;
  // Once the user moves the camera, a resize keeps it where it is.
  let userCamera = false;
  let recolor: (() => void) | null = null;
  let zoomFrame = 0;
  let viewportTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportGeneration = 0;
  let viewportDeferred = false;
  let cameraGeneration = 0;
  let disposed = false;
  let opening = false;
  let committing = false;
  let commitAgain = false;
  let commitGeneration = 0;
  let lastRev = 0;
  const searchOpen = signal(false);

  const syncSelection = (): void => {
    setSelectedCount(editor?.list.length ?? 0);
  };

  // The first fit happens after the document opens; NSH does not take signal
  // writes made inside a draw call, so publish the label on the next frame.
  // A later zoom publishes its own label directly; this frame must not
  // overwrite it with the scale it captured earlier.
  const publishZoom = (scale: number): void => {
    cancelAnimationFrame(zoomFrame);
    const percent = Math.round(scale * 100);
    zoomFrame = requestAnimationFrame(() => {
      if (disposed) return;
      if (Math.round((camera?.scale ?? scale) * 100) === percent) setZoomPercent(percent);
    });
  };

  // The edit box lives in the editor (sky) layer and is positioned from the
  // selected elements' world bounds. Moving the camera changes those bounds
  // without changing the elements themselves, so Leafer does not refresh the
  // box on its own; update the layout and the editor after every camera move.
  const refreshEditor = (): void => refreshEditBox(editor, scene?.world ?? null);

  // Change sets carry the document revision; a viewport read that started
  // before a command must not rewind the scene.
  const applyChanges = (changes: ChangeSet): void => {
    lastRev = Math.max(lastRev, changes.rev);
    scene?.applyChangeSet(changes);
    refreshEditor();
  };

  const visibleRect = (): { rect: Viewport; margin: number } => {
    if (!camera) {
      return { rect: CONTENT, margin: 0 };
    }
    const rect = camera.visibleBounds({ width: stageWidth, height: stageHeight });
    const margin = Math.max(rect.width, rect.height) * VIEWPORT_MARGIN;
    return { rect, margin };
  };

  // Throttle viewport reads during a pan or zoom; Leafer moves the cards it
  // already has between reads, so the scene never waits on the database.
  const scheduleViewport = (): void => {
    if (viewportTimer !== null || disposed) return;
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      if (!disposed) void refreshViewport();
    }, VIEWPORT_DELAY_MS);
  };

  const refreshViewport = async (): Promise<void> => {
    const doc = document;
    if (!doc || !scene || disposed) return;
    // Do not overwrite a card while the editor is dragging it. Remember to
    // read again when the gesture commits; otherwise the timer is consumed
    // and newly exposed cards stay missing until the camera moves again.
    if (app?.interaction?.dragging) {
      viewportDeferred = true;
      return;
    }

    const generation = ++viewportGeneration;
    const { rect, margin } = visibleRect();
    try {
      const snapshot = await doc.scene(rect, margin);
      if (disposed || generation !== viewportGeneration || !scene) return;
      if (app?.interaction?.dragging) {
        viewportDeferred = true;
        return;
      }
      if (snapshot.rev < lastRev) return;
      lastRev = snapshot.rev;
      // At low zoom the viewport can cover tens of thousands of nodes. Keep
      // the card count bounded; selected cards survive the cap.
      const scale = camera?.scale ?? 1;
      const maxCards = scale < 0.15 ? 300 : scale < 0.4 ? 800 : 2_000;
      scene.apply(snapshot, { maxCards });
      viewportDeferred = false;
      refreshEditor();
    } catch (error) {
      console.error("Flow could not read the viewport", error);
    }
  };

  const drainDeferredViewport = (): void => {
    if (!viewportDeferred || disposed) return;
    viewportDeferred = false;
    scheduleViewport();
  };

  const fitToDocument = async (announce = true, schedule = true): Promise<void> => {
    const doc = document;
    if (!doc || !camera || disposed) return;
    const generation = cameraGeneration;
    let bounds: Viewport = CONTENT;
    try {
      const documentBounds = await doc.bounds();
      if (documentBounds.width > 0 || documentBounds.height > 0) {
        bounds = documentBounds;
      }
    } catch (error) {
      console.error("Flow could not read the document bounds", error);
    }
    // A pan or zoom during the bounds read is the newer intent; do not
    // override it (or re-enable auto-fit) with this stale result.
    if (disposed || !camera || generation !== cameraGeneration) return;

    userCamera = false;
    const scale = camera.fit(bounds, { width: stageWidth, height: stageHeight });
    if (announce) publishZoom(scale);
    refreshEditor();
    if (schedule) scheduleViewport();
  };

  const revealNode = async (id: string): Promise<void> => {
    const doc = document;
    if (!doc || !camera || disposed) return;
    try {
      const node = await doc.getNode(id);
      if (!node || disposed || !camera) return;
      cameraGeneration += 1;
      userCamera = true;
      const scale = camera.fit(
        { x: node.x, y: node.y, width: node.width, height: node.height },
        { width: stageWidth, height: stageHeight },
      );
      publishZoom(scale);
      refreshEditor();
      // The viewport moved: wait for the new snapshot before selecting its card.
      await refreshViewport();
      if (disposed || !scene) return;
      // A newer scheduled read can supersede the awaited one; ensure the hit
      // exists before selecting so the reveal never depends on that race.
      if (!scene.card(id)) {
        scene.applyChangeSet({
          changed: [node],
          removed: [],
          edgesChanged: [],
          edgesRemoved: [],
        });
      }
      const card = scene.card(id);
      if (!card || disposed) return;
      app?.editor.select([card]);
      syncSelection();
      refreshEditor();
      scheduleViewport();
    } catch (error) {
      console.error("Flow could not reveal the search result", error);
    }
  };

  const searchCards = async (query: string, kind: string | null): Promise<SearchHit[]> => {
    const doc = document;
    if (!doc) return [];
    return doc.search(query, { kind }, 20);
  };

  const selectSearchHit = (hit: SearchHit): void => {
    searchOpen.set(false);
    void revealNode(hit.id);
  };

  const openFlow = async (): Promise<void> => {
    if (document || opening || disposed) return;
    opening = true;
    try {
      const path = databasePath({
        dataDir: process.dataDir,
        hostPath: host.params.databasePath,
        envPath: process.env.FLOW_DB_PATH,
      });
      const opened = await Document.open(path);
      if (disposed) {
        opened.dispose();
        return;
      }
      document = opened;

      if ((await opened.count()) === 0 && (await opened.edgeCount()) === 0) {
        await opened.insertNodes(seedNodes());
        await opened.insertEdges(seedEdges());
        // The demo was not a user action; keep Ctrl+Z for real edits.
        await opened.clearHistory();
      }

      // Fit without publishing the zoom label: tests and users wait on that
      // label, so it must not appear before the first cards do. Skip the
      // scheduled read too; the direct read below is the first snapshot.
      await fitToDocument(false, false);
      await refreshViewport();
      if (!disposed) publishZoom(camera?.scale ?? 1);
    } catch (error) {
      console.error("Flow could not open its document", error);
      if (!disposed && camera) {
        const scale = camera.fit(CONTENT, { width: stageWidth, height: stageHeight });
        publishZoom(scale);
      }
    } finally {
      opening = false;
    }
  };

  const commitGesture = (): void => {
    drainDeferredViewport();
    const doc = document;
    if (!doc || !scene || disposed) return;

    const bounds = scene.commitBounds();
    if (bounds.length === 0) return;
    const generation = ++commitGeneration;

    if (committing) {
      commitAgain = true;
      return;
    }

    committing = true;
    void (async () => {
      try {
        const changes = await doc.setNodeBounds(bounds);
        if (disposed || !scene) return;
        // A newer drag may have started while this write was in flight; let
        // its commit win instead of snapping the card back.
        if (generation === commitGeneration && !app?.interaction?.dragging) {
          applyChanges(changes);
        }
      } catch (error) {
        console.error("Flow could not persist the gesture", error);
        await refreshViewport();
      } finally {
        committing = false;
        if (commitAgain && !disposed) {
          commitAgain = false;
          commitGesture();
        }
      }
    })();
  };

  const zoomAround = (factor: number, cx: number, cy: number): void => {
    if (!camera) return;
    cameraGeneration += 1;
    userCamera = true;
    if (camera.zoomAround(factor, cx, cy)) {
      refreshEditor();
      cancelAnimationFrame(zoomFrame);
      setZoomPercent(Math.round(camera.scale * 100));
      scheduleViewport();
    }
  };

  const setZoom = (factor: number): void => {
    zoomAround(factor, stageWidth / 2, stageHeight / 2);
  };

  const panBy = (dx: number, dy: number): void => {
    if (!camera || searchOpen()) return;
    cameraGeneration += 1;
    userCamera = true;
    camera.panBy(dx, dy);
    refreshEditor();
    scheduleViewport();
  };

  const fit = (): void => {
    void fitToDocument();
  };

  const addNode = (): void => {
    const doc = document;
    if (!doc || !camera || disposed) return;
    const center = camera.toWorld(stageWidth / 2, stageHeight / 2);
    const id = `node-${crypto.randomUUID()}`;
    const input: NodeInput = {
      id,
      kind: "panel",
      title: "New panel",
      body: "",
      tags: ["untitled"],
      x: center.x - 100,
      y: center.y - 42,
      width: 200,
      height: 84,
      z: 0,
      dataJson: JSON.stringify({ subtitle: "Untitled", accent: "chart-1" }),
    };

    void (async () => {
      try {
        const changes = await doc.insertNodes([input]);
        if (disposed) return;
        // `applyChanges` creates the card from the change set, so the panel
        // is selectable even when a capped viewport read would omit it.
        applyChanges(changes);
        const card = scene?.card(id);
        if (card) app?.editor.select([card]);
        syncSelection();
        refreshEditor();
        scheduleViewport();
      } catch (error) {
        console.error("Flow could not add a panel", error);
      }
    })();
  };

  const deleteSelected = (): void => {
    const doc = document;
    if (!doc || !scene || disposed) return;
    const ids = scene.selectedIds();
    if (ids.length === 0) return;

    app?.editor.cancel();
    syncSelection();
    void (async () => {
      try {
        const changes = await doc.deleteNodes(ids);
        if (disposed) return;
        applyChanges(changes);
      } catch (error) {
        console.error("Flow could not delete the selection", error);
      }
    })();
  };

  const connectSelected = (): void => {
    const doc = document;
    if (!doc || !scene || disposed) return;
    const selected = scene.selectedIds();
    if (selected.length !== 2) return;
    const [from, to] = selected;
    if (!from || !to) return;

    const id = `edge-${crypto.randomUUID()}`;
    void (async () => {
      try {
        const changes = await doc.insertEdges([{ id, fromId: from, toId: to, kind: "flow" }]);
        if (disposed) return;
        applyChanges(changes);
      } catch (error) {
        console.error("Flow could not connect the panels", error);
      }
    })();
  };

  const undoRedo = async (direction: "undo" | "redo"): Promise<void> => {
    const doc = document;
    if (!doc || disposed) return;
    try {
      const changes = direction === "undo" ? await doc.undo() : await doc.redo();
      if (disposed) return;
      if (changes.removed.length > 0) app?.editor.cancel();
      // The change set already restores or removes the affected cards; the
      // scheduled read only reconciles the rest of the viewport.
      applyChanges(changes);
      syncSelection();
      refreshEditor();
      scheduleViewport();
    } catch (error) {
      console.error(`Flow could not ${direction}`, error);
    }
  };

  keymap.bind({
    "mod+=": () => setZoom(1.2),
    "mod+-": () => setZoom(1 / 1.2),
    "mod+0": fit,
    v: () => setTool("select"),
    h: () => setTool("hand"),
    n: addNode,
    l: connectSelected,
    backspace: deleteSelected,
    delete: deleteSelected,
    "mod+z": () => void undoRedo("undo"),
    "mod+shift+z": () => void undoRedo("redo"),
    "mod+y": () => void undoRedo("redo"),
    // The arrows move the camera (the view moves the opposite way).
    up: () => panBy(0, 40),
    down: () => panBy(0, -40),
    left: () => panBy(40, 0),
    right: () => panBy(-40, 0),
  });
  keymap.bind("mod+k", () => searchOpen.update((open) => !open), { when: "always" });
  keymap.bind(
    "escape",
    () => {
      if (searchOpen()) searchOpen.set(false);
      else editor?.cancel();
    },
    { when: "always" },
  );

  // Leafer nodes keep the token values they were built with. When the system
  // switches between light and dark, repaint the scene; setting a fill asks
  // Leafer for a frame, which also redraws the token-based grid behind it.
  effect(() => {
    colorScheme();
    recolor?.();
  });

  cleanup(() => {
    disposed = true;
    viewportGeneration += 1;
    cancelAnimationFrame(zoomFrame);
    if (viewportTimer !== null) clearTimeout(viewportTimer);
    editor?.off("editor.select", syncSelection);
    document?.dispose();
    document = null;
  });

  return (
    <View class="flex-1" style={{ position: "relative" }}>
      <LeaferView
        class="flex-1"
        testID="flow-canvas"
        setup={(nextApp, size) => {
          app = nextApp;
          stageWidth = size.width;
          stageHeight = size.height;
          const flow = new FlowScene(nextApp);
          scene = flow;
          camera = new CanvasCamera(flow.world);
          recolor = flow.recolor.bind(flow);
          editor = nextApp.editor;
          // The flow's cards have no inner text editor; a double click should
          // not open a group or clear the selection. The document stores only
          // an axis-aligned box, so rotation, skew and flip must not become
          // reachable editor gestures: their geometry cannot be persisted.
          delete editor.config.openInner;
          editor.config.rotateable = false;
          editor.config.skewable = false;
          editor.config.flipable = false;
          editor.on("editor.select", syncSelection);
          // Keep the scene at the demo bounds while the document opens; the
          // zoom label is published only after the first real fit.
          camera.fit(CONTENT, size);
          void openFlow();
        }}
        tool={currentTool}
        onPan={panBy}
        onZoom={zoomAround}
        onCommit={commitGesture}
        drawBackdrop={(cx, size) => drawGrid(cx, size.width, size.height, camera)}
        onResize={(size) => {
          stageWidth = size.width;
          stageHeight = size.height;
          if (camera && !userCamera) {
            void fitToDocument();
          } else {
            scheduleViewport();
          }
        }}
      />

      <SearchButton shortcut={keymap.label("mod+k")} onPress={() => searchOpen.set(true)} />

      <ZoomControls
        zoom={zoomPercent()}
        onZoomIn={() => setZoom(1.2)}
        onZoomOut={() => setZoom(1 / 1.2)}
        onFit={fit}
      />

      {!isAvailable && <BrandCard />}

      {selectedCount() > 0 && <SelectionBadge count={selectedCount()} />}

      <HintBar tool={currentTool()} />

      <ToolSwitch tool={currentTool()} onChange={setTool} />

      <If when={searchOpen()}>
        {() => (
          <SearchPalette
            filters={SEARCH_FILTERS}
            search={searchCards}
            onClose={() => searchOpen.set(false)}
            onSelect={selectSearchHit}
          />
        )}
      </If>
    </View>
  );
}
