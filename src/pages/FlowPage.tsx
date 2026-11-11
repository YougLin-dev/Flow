import { cleanup, effect, host, keymap, Picker, platform, signal, untracked, View } from "nsh";
import { isAvailable } from "nsh/desktop";
import type { ChangeSet, Document, NodeBounds, SearchHit } from "@flow/native";
import { BrandCard } from "../components/BrandCard";
import { CanvasContextMenu } from "../components/CanvasContextMenu";
import { FlowCanvas } from "../components/FlowCanvas";
import { ImageLoadProbe, imageProbeText } from "../components/FlowCard";
import { FrameRate } from "../components/FrameRate";
import { InlineTextEditor } from "../components/InlineTextEditor";
import { MiniMap } from "../components/MiniMap";
import { MinimapDragOverlay } from "../components/MinimapDragOverlay";
import { NodeComposer } from "../components/NodeComposer";
import { NodeToolbar } from "../components/NodeToolbar";
import { SearchButton } from "../components/SearchButton";
import { SearchPalette } from "../components/SearchPalette";
import { SelectionBadge } from "../components/SelectionBadge";
import { ZoomControls, ZoomProbe } from "../components/ZoomControls";
import { AssetUrls } from "../flow/asset-urls";
import { bindFlowKeys } from "../flow/bindings";
import { CanvasCamera, wheelZoomFactor } from "../flow/camera";
import { CanvasController } from "../flow/canvas-controller";
import { ComposerState } from "../flow/composer-state";
import { CanvasMenuController, contextMenuPosition } from "../flow/context-menu";
import { CONTENT } from "../flow/data";
import { openFlowDocument } from "../flow/document-session";
import { NodeRunner } from "../flow/execution";
import { MinimapLoader } from "../flow/minimap-loader";
import { MinimapController } from "../flow/minimap-controller";
import type { NodeKindId } from "../flow/node-kinds";
import { NodeSession } from "../flow/node-session";
import { composerPlacement, inlinePlacement } from "../flow/overlay";
import { PreviewLoader } from "../flow/preview-loader";
import { SEARCH_FILTERS } from "../flow/search-filters";
import { revealSearchHit } from "../flow/search-navigation";
import { FlowScene } from "../flow/scene";
import { ViewportController } from "../flow/viewport-controller";
import { selectedCount, setSelectedCount, setZoomPercent, zoomPercent } from "../store";

/**
 * The flow workspace: a native canvas of cards and connectors, the page's
 * document session, and the native composer attached to the selected card.
 */
export function FlowPage() {
  let document: Document | null = null;
  let assets: AssetUrls | null = null;
  let runner: NodeRunner | null = null;
  let disposed = false;
  let opening = false;
  let sized = false;

  const scene = new FlowScene();
  const camera = new CanvasCamera();
  const stage = signal({ width: 1, height: 1 });
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
    scene.applyChangeSet(changes);
    currentSession()?.onChanges(changes);
    schedulePreviews();
  };

  const viewport = new ViewportController({
    camera: () => camera,
    scene: () => scene,
    document: () => document,
    applyChanges,
    schedulePreviews,
    publishZoom: (percent) => setZoomPercent(percent),
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
    const session = currentSession();
    const id = session?.inlineId() ?? null;
    if (!session || id === null) return;
    const text = session.inlineText();
    session.closeInline();
    void session.commitBody(id, text);
  };

  const openComposer = (id: string): void => {
    const session = currentSession();
    if (!session) return;
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
    reconnectEdge: (edgeId, fromId, toId) =>
      void currentSession()?.reconnectEdge(edgeId, fromId, toId),
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

  const composerPosition = () =>
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

  const inlinePosition = () =>
    inlinePlacement(
      currentSession()?.inlineId() ?? null,
      (id) => scene.cardRect(id),
      camera,
      stage(),
    );

  const canvasMenu = new CanvasMenuController({
    camera: () => camera,
    controller: () => controller,
    addNode: (kind, x, y) => void currentSession()?.addNode(kind, x, y),
  });

  const panBy = (dx: number, dy: number): void => {
    if (searchOpen()) return;
    viewport.panBy(dx, dy);
  };

  const setZoom = (factor: number): void => {
    const size = stage();
    viewport.zoomAround(factor, size.width / 2, size.height / 2);
  };

  const fit = (): void => {
    void viewport.fitToDocument();
  };

  const searchCards = async (query: string, kind: string | null): Promise<SearchHit[]> => {
    const doc = document;
    if (!doc) return [];
    return doc.search(query, { kind }, 20);
  };

  const revealNode = (id: string): Promise<void> =>
    revealSearchHit({ document, viewport, scene, isDisposed: () => disposed, openComposer }, id);

  const selectSearchHit = (hit: SearchHit): void => {
    searchOpen.set(false);
    void revealNode(hit.id);
  };

  const openFlow = async (): Promise<void> => {
    if (document || opening || disposed) return;
    opening = true;
    try {
      const opened = await openFlowDocument();
      if (disposed) {
        opened.dispose();
        return;
      }
      document = opened;
      assets = new AssetUrls(opened);
      runner = new NodeRunner(opened, {
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
      await viewport.fitToDocument(false, false);
      await viewport.refresh();
      if (!disposed) viewport.announceZoom(camera.scale);
    } catch (error) {
      console.error("Flow could not open its document", error);
      if (!disposed) camera.fit(CONTENT, stage());
    } finally {
      opening = false;
    }
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
    void (async () => {
      try {
        const changes = await doc.deleteNodes(ids);
        if (!disposed) applyChanges(changes);
      } catch (error) {
        console.error("Flow could not delete the selection", error);
      }
    })();
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

  bindFlowKeys({
    setZoom,
    fit,
    deleteSelected,
    undo: () => void undoRedo("undo"),
    redo: () => void undoRedo("redo"),
    panBy,
    toggleSearch: () => searchOpen.update((open) => !open),
    dismiss: () => {
      if (canvasMenu.close()) return;
      if (searchOpen()) {
        searchOpen.set(false);
        return;
      }
      const active = currentSession();
      if (active?.inlineId()) {
        active.closeInline();
        return;
      }
      if (scene.selectedEdge() !== null) {
        selectEdge(null);
        return;
      }
      if ((active?.composerId() ?? null) !== null) {
        closeComposer();
        return;
      }
      scene.select([]);
    },
  });

  effect(() => {
    const ids = scene.selection();
    const session = currentSession();
    setSelectedCount(ids.length);
    // Opening or closing a composer must not re-arm this effect: only a
    // selection change (or the session appearing) re-runs it.
    untracked(() => {
      if (ids.length === 1) {
        const id = ids[0];
        if (id !== undefined) openComposer(id);
        return;
      }
      if (session !== null && session.composerId() !== null) {
        composerState.save(session, session.detail());
        composerState.reset();
        session.closeComposer();
      }
    });
  });

  effect(() => {
    composerState.sync(currentSession()?.detail() ?? null);
  });

  cleanup(() => {
    canvasMenu.close();
    disposed = true;
    previews.dispose();
    minimap.dispose();
    minimapDrag.dispose();
    viewport.dispose();
    runner?.dispose();
    assets?.dispose();
    document?.dispose();
    document = null;
    assets = null;
    runner = null;
    sessionState.set(null);
  });

  const composerOpen = (): boolean => (currentSession()?.composerId() ?? null) !== null;

  return (
    <View class="flex-1" style={{ position: "relative", overflow: "hidden" }}>
      <FlowCanvas
        scene={scene}
        camera={camera}
        controller={controller}
        stage={stage}
        onSize={(size) => {
          stage.set(size);
          viewport.setSize(size.width, size.height);
          if (!sized) {
            sized = true;
            camera.fit(CONTENT, size);
            void openFlow();
            return;
          }
          viewport.onResize(size.width, size.height);
        }}
        onPan={(dx, dy) => viewport.panBy(dx, dy)}
        onZoom={(factor, x, y) => viewport.zoomAround(factor, x, y)}
        onWheelZoom={(notches, x, y) => viewport.zoomAround(wheelZoomFactor(notches), x, y)}
        onMenuPress={(at) => canvasMenu.press(at)}
        onMenuRelease={() => canvasMenu.release()}
        onMenuCancel={() => {
          canvasMenu.close();
        }}
        imageEvent={(event) => imageProbe.set(imageProbeText(event))}
      />

      {host.params.flowImageLoadProbe === 1 ? <ImageLoadProbe value={imageProbe()} /> : null}

      {host.params.flowZoomProbe === 1 ? <ZoomProbe value={zoomPercent()} /> : null}

      {composerOpen() ? null : <NodeToolbar onAdd={addNode} />}

      {composerOpen() ? null : (
        <SearchButton shortcut={keymap.label("mod+k")} onPress={() => searchOpen.set(true)} />
      )}

      {!isAvailable && !composerOpen() ? <BrandCard /> : null}

      {selectedCount() > 0 ? (
        <SelectionBadge count={selectedCount()} composing={composerOpen()} />
      ) : null}

      {process.env.FLOW_FPS ? <FrameRate /> : null}

      <If when={currentSession()?.detail()}>
        {(detail) => (
          <If when={composerPosition()}>
            {(position) => (
              <NodeComposer
                detail={detail()}
                state={composerState}
                left={position().left}
                top={position().top}
                width={position().width}
                assetUrls={() => currentSession()?.assetUrls() ?? {}}
                running={() => currentSession()?.running() ?? false}
                onClose={closeComposer}
                onRun={() => {
                  const settings = composerState.settings();
                  if (settings !== null) void currentSession()?.run(settings);
                }}
                onCancel={() => currentSession()?.cancel()}
                onRemoveInput={(id) => void currentSession()?.removeInput(id)}
                onReorderInputs={(ids) => void currentSession()?.reorderInputs(ids)}
                onUpload={() => void currentSession()?.upload()}
                onSaveBody={() => {
                  const node = currentSession()?.detail();
                  if (node) void currentSession()?.commitBody(node.node.id, composerState.body());
                }}
              />
            )}
          </If>
        )}
      </If>

      <If when={currentSession()?.inlineId()}>
        {(id) => (
          <If when={inlinePosition()}>
            {(position) => (
              <InlineTextEditor
                nodeId={() => currentSession()?.inlineId() ?? null}
                text={() => currentSession()?.inlineText() ?? ""}
                left={position().left}
                top={position().top}
                width={position().width}
                height={position().height}
                onChange={(text) => currentSession()?.setInlineText(text)}
                onSave={(text) => void currentSession()?.commitBody(id(), text)}
                onCancel={() => currentSession()?.closeInline()}
              />
            )}
          </If>
        )}
      </If>

      {/* The controls and the map share the bottom-left corner. They stay
          above a card's composer (z-20) and inline editor (z-30), while
          search, the context menu and the map's drag overlay stay above. */}
      <View class="absolute left-4 bottom-4 z-40 flex-row items-end gap-2">
        <ZoomControls
          onZoomIn={() => setZoom(1.2)}
          onZoomOut={() => setZoom(1 / 1.2)}
          onFit={fit}
          minimapOpen={minimapOpen()}
          onToggleMinimap={platform.desktop ? () => minimapOpen.set(!minimapOpen()) : undefined}
        />
        {platform.desktop && minimapOpen() ? (
          <MiniMap
            overview={minimap.overview}
            camera={camera}
            stage={stage}
            drag={minimapDrag}
            onZoom={(notches) => setZoom(wheelZoomFactor(notches))}
          />
        ) : null}
      </View>

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

      <If when={canvasMenu.open()}>
        {(press) => (
          <CanvasContextMenu
            left={contextMenuPosition(press(), stage()).left}
            top={contextMenuPosition(press(), stage()).top}
            onClose={() => {
              canvasMenu.close();
            }}
            onAddText={() => canvasMenu.add("text", press())}
            onAddImage={() => canvasMenu.add("image", press())}
            onMove={(x, y, held) => canvasMenu.move(x, y, held)}
            onPress={(x, y) => canvasMenu.press({ x, y })}
            onRelease={() => canvasMenu.release()}
          />
        )}
      </If>

      {minimapDrag.dragging() ? (
        <MinimapDragOverlay
          controller={minimapDrag}
          onZoom={(notches) => setZoom(wheelZoomFactor(notches))}
        />
      ) : null}
    </View>
  );
}
