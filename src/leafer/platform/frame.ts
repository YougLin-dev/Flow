import type { App } from "@leafer-ui/miniapp";
import type { IRenderer } from "@leafer-ui/interface";

/**
 * Leafer's renderer keeps the time of the frame it asked for in a field its
 * types hide. There is no browser loop here: every NSH frame is a full frame,
 * so the mark has to be cleared before and after drawing or Leafer will not
 * ask for the next one. Keep the untyped access in this module.
 */
type FrameRenderer = IRenderer & { requestTime: number };

interface RenderLayer {
  readonly renderer: IRenderer;
}

function isFrameRenderer(renderer: IRenderer): renderer is FrameRenderer {
  return "requestTime" in renderer;
}

function clearLayer(layer: RenderLayer): void {
  const renderer = layer.renderer;
  if (isFrameRenderer(renderer)) renderer.requestTime = 0;
}

export function clearRenderMarks(app: App): void {
  for (const layer of [app, app.tree, app.sky]) clearLayer(layer);
}
