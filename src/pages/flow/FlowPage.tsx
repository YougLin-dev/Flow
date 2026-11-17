import { Pencil } from "lucide";
import { cleanup, effect, host, keymap, platform, signal, token, View } from "nsh";
import { Button } from "nsh/base";
import { isAvailable } from "nsh/desktop";
import { BrandCard, FrameRate } from "../../components/app";
import { Icon } from "../../components/primitives";
import { ImageComposer, TextComposer } from "../../components/composer";
import { CanvasMenuLayer, FlowCanvas, NodeToolbar, ZoomControls } from "../../components/canvas";
import { MiniMap, MinimapDragOverlay } from "../../components/minimap";
import { SEARCH_FILTERS, SearchButton, SearchPalette } from "../../components/search";
import { CanvasProbe, ImageLoadProbe, imageProbeText, ZoomProbe } from "../../components/probes";
import { wheelZoomFactor } from "../../flow/canvas";
import { bindFlowKeys } from "./workspace/bindings";
import { flowKeyActions } from "./workspace/flow-actions";
import {
  dismissContextMenuOnChange,
  syncComposerState,
  syncSelection,
} from "./workspace/flow-effects";
import {
  createFlowWorkspace,
  type FlowWorkspace,
  type WorkspaceProject,
} from "./workspace/flow-workspace";
import { pageChromeHandlers } from "./workspace/page-chrome";
import { PROJECT_ACTION_FAILURE, ProjectNameDialog } from "../projects";

export interface FlowPageProps {
  /** The managed project to open; absent on the legacy single-document path. */
  readonly project?: WorkspaceProject | null | undefined;
  /** The workspace this page owns, for the window that closes and quits it. */
  readonly onWorkspace?: ((workspace: FlowWorkspace) => void) | undefined;
  /** A managed open failed; the shell shows the list with the reason. */
  readonly onOpenError?: ((error: unknown) => void) | undefined;
  /** The open project was renamed; the shell updates its window title. */
  readonly onRenamed?: ((title: string) => void) | undefined;
}

/**
 * The flow workspace: a native canvas of cards and connectors, the page's
 * document session, and the native composer attached to the selected card.
 */
export function FlowPage(props: FlowPageProps = {}) {
  // This page's own readout: a second project window has its own camera and
  // selection, so neither is app state.
  const zoomPercent = signal<number | null>(null);
  const workspace = createFlowWorkspace({
    publishZoom: (percent) => zoomPercent.set(percent),
    project: props.project ?? null,
    onOpenError: props.onOpenError,
  });
  props.onWorkspace?.(workspace);
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

  const renameOpen = signal(false);
  const projectTitle = signal(props.project?.title ?? "");
  // Identifies the live dialog run: a write that settles after its dialog was
  // dismissed must not close a later run the user has since opened.
  let renameRun = 0;

  const openRename = (): void => {
    renameRun += 1;
    renameOpen.set(true);
  };

  const cancelRename = (): void => {
    renameRun += 1;
    renameOpen.set(false);
  };

  const submitRename = async (title: string): Promise<void> => {
    const run = renameRun;
    await workspace.renameProject(title);
    // The write landed, so publish the committed title even if the dialog
    // was dismissed; only close the dialog that submitted it.
    projectTitle.set(title);
    props.onRenamed?.(title);
    if (run === renameRun) renameOpen.set(false);
  };

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
        onSize={workspace.handleSize}
        onPan={workspace.panViewport}
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

      <View class="absolute top-4 left-4 z-30 items-start gap-2">
        <View class="flex-row items-center gap-2">
          {props.project ? (
            <Button
              testID="rename-project"
              accessibilityLabel="Rename project"
              onPress={openRename}
              class="size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <Icon icon={Pencil} size={14} tint={() => token("muted-foreground")} />
            </Button>
          ) : null}
          {workspace.composerOpen() ? null : (
            <SearchButton shortcut={keymap.label("mod+k")} onPress={() => searchOpen.set(true)} />
          )}
        </View>
      </View>

      {host.params.flowImageLoadProbe === 1 ? <ImageLoadProbe value={imageProbe()} /> : null}

      {host.params.flowZoomProbe === 1 ? <ZoomProbe value={zoomPercent()} /> : null}

      {host.params.flowSelectionProbe === 1 ? (
        <CanvasProbe selected={scene.selection().length} composing={workspace.composerOpen()} />
      ) : null}

      {workspace.composerOpen() ? null : <NodeToolbar onAdd={workspace.addNode} />}

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

      <If when={renameOpen()}>
        {() => (
          <ProjectNameDialog
            idPrefix="project-rename"
            heading="Rename project"
            description="The name changes in the project list and the window title."
            submitLabel="Rename"
            initialTitle={projectTitle()}
            failurePrefix={PROJECT_ACTION_FAILURE.rename}
            onCancel={cancelRename}
            onSubmit={submitRename}
          />
        )}
      </If>

      {minimapDrag.dragging() ? (
        <MinimapDragOverlay
          controller={minimapDrag}
          onZoom={(notches) => workspace.setZoom(wheelZoomFactor(notches))}
        />
      ) : null}
    </View>
  );
}
