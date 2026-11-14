import { cleanup, effect, host, keymap, platform, View } from "nsh";
import { isAvailable } from "nsh/desktop";
import { BrandCard, FrameRate } from "../../components/app";
import { ImageComposer, TextComposer } from "../../components/composer";
import { CanvasMenuLayer, FlowCanvas, NodeToolbar, ZoomControls } from "../../components/canvas";
import { MiniMap, MinimapDragOverlay } from "../../components/minimap";
import { SEARCH_FILTERS, SearchButton, SearchPalette } from "../../components/search";
import { CanvasProbe, ImageLoadProbe, imageProbeText, ZoomProbe } from "../../components/probes";
import { wheelZoomFactor } from "../../flow/canvas";
import { dismissContextMenuOnChange } from "../../flow/canvas/interaction/context-menu";
import { selectedCount, setZoomPercent, zoomPercent } from "../../store";
import { bindFlowKeys } from "./workspace/bindings";
import { flowKeyActions } from "./workspace/flow-actions";
import { syncComposerState, syncSelection } from "./workspace/flow-effects";
import { createFlowWorkspace } from "./workspace/flow-workspace";
import { pageChromeHandlers } from "./workspace/page-chrome";

/**
 * The flow workspace: a native canvas of cards and connectors, the page's
 * document session, and the native composer attached to the selected card.
 */
export function FlowPage() {
  const workspace = createFlowWorkspace({ publishZoom: setZoomPercent });
  const {
    camera,
    canvasMenu,
    composerPosition,
    composerState,
    controller,
    imageProbe,
    minimap,
    minimapDrag,
    minimapOpen,
    scene,
    searchOpen,
    session,
    stage,
  } = workspace;

  dismissContextMenuOnChange(canvasMenu, camera, scene);
  bindFlowKeys(flowKeyActions(workspace));

  // The body editor's keyboard path: double-clicking a text card opens it,
  // and every edit that gesture reaches also has this one.
  keymap.bind(
    "mod+enter",
    () => {
      const current = session();
      if (searchOpen() || current === null || current.inlineId() !== null) return;
      const ids = scene.selection();
      if (ids.length !== 1) return;
      if (scene.kindOf(ids[0]) === "text") void current.openInline(ids[0]);
    },
    { when: "notEditing" },
  );

  effect(() => syncSelection(workspace));
  effect(() => syncComposerState(workspace));
  cleanup(() => workspace.dispose());

  return (
    <View
      class="flex-1"
      style={{ position: "relative", overflow: "hidden" }}
      // Secondary presses and the wheel over the composer, its dock and the
      // other page views never reach the canvas overlay, so the page
      // forwards them itself.
      {...pageChromeHandlers(canvasMenu, workspace.zoomCanvas)}
    >
      <FlowCanvas
        scene={scene}
        camera={camera}
        controller={controller}
        stage={stage}
        onSize={(size) => workspace.handleSize(size)}
        onPan={workspace.panBy}
        onZoom={workspace.zoomCanvas}
        onWheelZoom={(notches, x, y) => workspace.zoomCanvas(wheelZoomFactor(notches), x, y)}
        onMenuPress={(at) => canvasMenu.press(at)}
        onMenuRelease={() => canvasMenu.release()}
        onMenuCancel={() => {
          canvasMenu.close();
        }}
        uploadingNode={() => session()?.uploadingNode() ?? null}
        onUploadNode={(nodeId) => void session()?.uploadSource(nodeId)}
        inlineId={() => session()?.inlineId() ?? null}
        inlineText={() => session()?.inlineText() ?? ""}
        onInlineChange={(text) => session()?.setInlineText(text)}
        onInlineCommit={() => void session()?.commitInline()}
        imageEvent={(event) => imageProbe.set(imageProbeText(event))}
      />

      {host.params.flowImageLoadProbe === 1 ? <ImageLoadProbe value={imageProbe()} /> : null}

      {host.params.flowZoomProbe === 1 ? <ZoomProbe value={zoomPercent()} /> : null}

      {host.params.flowSelectionProbe === 1 ? (
        <CanvasProbe selected={selectedCount()} composing={workspace.composerOpen()} />
      ) : null}

      {workspace.composerOpen() ? null : <NodeToolbar onAdd={workspace.addNode} />}

      {workspace.composerOpen() ? null : (
        <SearchButton shortcut={keymap.label("mod+k")} onPress={() => searchOpen.set(true)} />
      )}

      {!isAvailable && !workspace.composerOpen() ? <BrandCard /> : null}

      {process.env.FLOW_FPS ? <FrameRate /> : null}

      <If when={session()?.detail()}>
        {(detail) => (
          <If when={composerPosition()}>
            {(position) => (
              <If
                when={detail().node.kind === "text"}
                else={
                  <ImageComposer
                    detail={detail()}
                    state={composerState}
                    left={position().left}
                    top={position().top}
                    width={position().width}
                    assetUrls={() => session()?.assetUrls() ?? {}}
                    running={() => session()?.running() ?? false}
                    onClose={workspace.closeComposer}
                    onRun={() => {
                      const settings = composerState.settings();
                      if (settings !== null) void session()?.run(settings);
                    }}
                    onCancel={() => session()?.cancel()}
                    onRemoveInput={(id) => void session()?.removeInput(id)}
                    onUpload={() => void session()?.upload()}
                  />
                }
              >
                <TextComposer
                  detail={detail()}
                  state={composerState}
                  left={position().left}
                  top={position().top}
                  width={position().width}
                  assetUrls={() => session()?.assetUrls() ?? {}}
                  running={() => session()?.running() ?? false}
                  onClose={workspace.closeComposer}
                  onRun={() => {
                    const settings = composerState.settings();
                    if (settings !== null) void session()?.run(settings);
                  }}
                  onCancel={() => session()?.cancel()}
                  onRemoveInput={(id) => void session()?.removeInput(id)}
                  onUpload={() => void session()?.upload()}
                />
              </If>
            )}
          </If>
        )}
      </If>

      {/* The controls and the map share the bottom-left corner. They stay
          above an inline editor (z-30) and the canvas, while a card's
          composer (z-40) covers them where its sheet reaches them; search,
          the context menu and the map's drag overlay stay above all. */}
      <View class="absolute left-4 bottom-4 z-30 flex-row items-end gap-2">
        <ZoomControls
          onZoomIn={() => workspace.setZoom(1.2)}
          onZoomOut={() => workspace.setZoom(1 / 1.2)}
          onFit={workspace.fit}
          minimapOpen={minimapOpen()}
          onToggleMinimap={platform.desktop ? () => minimapOpen.set(!minimapOpen()) : undefined}
        />
        {platform.desktop && minimapOpen() ? (
          <MiniMap
            overview={minimap.overview}
            camera={camera}
            stage={stage}
            drag={minimapDrag}
            selected={(id) => scene.isSelected(id)}
            onZoom={(notches) => workspace.setZoom(wheelZoomFactor(notches))}
          />
        ) : null}
      </View>

      <If when={searchOpen()}>
        {() => (
          <SearchPalette
            filters={SEARCH_FILTERS}
            search={workspace.searchCards}
            onClose={() => searchOpen.set(false)}
            onSelect={workspace.selectSearchHit}
          />
        )}
      </If>

      <CanvasMenuLayer menu={canvasMenu} stage={stage} />

      {minimapDrag.dragging() ? (
        <MinimapDragOverlay
          controller={minimapDrag}
          onZoom={(notches) => workspace.setZoom(wheelZoomFactor(notches))}
        />
      ) : null}
    </View>
  );
}
