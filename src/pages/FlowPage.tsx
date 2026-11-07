import { cleanup, colorScheme, effect, keymap, View } from "nsh";
import { isAvailable } from "nsh/desktop";
import type { IEditorBase } from "@leafer-ui/miniapp";
import { BrandCard } from "../components/BrandCard";
import { HintBar } from "../components/HintBar";
import { SelectionBadge } from "../components/SelectionBadge";
import { ToolSwitch } from "../components/ToolSwitch";
import { ZoomControls } from "../components/ZoomControls";
import { CONTENT } from "../flow/data";
import { drawGrid } from "../flow/grid";
import { buildScene, type FlowScene } from "../flow/scene";
import { CanvasCamera } from "../leafer/camera";
import { LeaferView } from "../leafer/LeaferView";
import {
  currentTool,
  selectedCount,
  setSelectedCount,
  setTool,
  setZoomPercent,
  zoomPercent,
} from "../store";

/**
 * The flow workspace: a Leafer canvas, its camera, and the controls that
 * float over it. The page owns the camera and the editor for as long as it is
 * mounted; the shared tool, zoom and selection values live in the store.
 */
export function FlowPage() {
  let camera: CanvasCamera | null = null;
  let editor: IEditorBase | null = null;
  let scene: FlowScene | null = null;
  let stageWidth = 1;
  let stageHeight = 1;
  // Once the user moves the camera, a resize keeps it where it is.
  let userCamera = false;
  let recolor: (() => void) | null = null;
  let zoomFrame = 0;

  const syncSelection = (): void => {
    setSelectedCount(editor?.list.length ?? 0);
  };

  // The first fit happens inside the canvas' draw call; NSH does not take
  // signal writes made there, so publish the label on the next frame.
  const publishZoom = (scale: number): void => {
    cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(() => setZoomPercent(Math.round(scale * 100)));
  };

  const zoomAround = (factor: number, cx: number, cy: number): void => {
    if (!camera) return;
    userCamera = true;
    if (camera.zoomAround(factor, cx, cy)) {
      setZoomPercent(Math.round(camera.scale * 100));
    }
  };

  const setZoom = (factor: number): void => {
    zoomAround(factor, stageWidth / 2, stageHeight / 2);
  };

  const panBy = (dx: number, dy: number): void => {
    if (!camera) return;
    userCamera = true;
    camera.panBy(dx, dy);
  };

  const fit = (): void => {
    if (!camera) return;
    userCamera = false;
    const next = camera.fit(scene?.bounds() ?? CONTENT, {
      width: stageWidth,
      height: stageHeight,
    });
    setZoomPercent(Math.round(next * 100));
  };

  keymap.bind({
    "mod+=": () => setZoom(1.2),
    "mod+-": () => setZoom(1 / 1.2),
    "mod+0": fit,
    v: () => setTool("select"),
    h: () => setTool("hand"),
    escape: () => editor?.cancel(),
    // The arrows move the camera (the view moves the opposite way).
    up: () => panBy(0, 40),
    down: () => panBy(0, -40),
    left: () => panBy(40, 0),
    right: () => panBy(-40, 0),
  });

  // Leafer nodes keep the token values they were built with. When the system
  // switches between light and dark, repaint the scene; setting a fill asks
  // Leafer for a frame, which also redraws the token-based grid behind it.
  effect(() => {
    colorScheme();
    recolor?.();
  });

  cleanup(() => {
    cancelAnimationFrame(zoomFrame);
    editor?.off("editor.select", syncSelection);
  });

  return (
    <View class="flex-1" style={{ position: "relative" }}>
      <LeaferView
        class="flex-1"
        testID="flow-canvas"
        setup={(app, size) => {
          stageWidth = size.width;
          stageHeight = size.height;
          const built = buildScene(app);
          scene = built;
          camera = new CanvasCamera(built.world);
          recolor = built.recolor;
          editor = app.editor;
          // The flow's cards have no inner text editor; a double click should
          // not open a group or clear the selection.
          delete editor.config.openInner;
          editor.on("editor.select", syncSelection);
          publishZoom(camera.fit(CONTENT, size));
        }}
        tool={currentTool}
        onPan={panBy}
        onZoom={zoomAround}
        drawBackdrop={(cx, size) => drawGrid(cx, size.width, size.height, camera)}
        onResize={(size) => {
          stageWidth = size.width;
          stageHeight = size.height;
          if (camera && !userCamera) {
            publishZoom(camera.fit(scene?.bounds() ?? CONTENT, size));
          }
        }}
      />

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
    </View>
  );
}
