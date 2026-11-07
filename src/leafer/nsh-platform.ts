/**
 * Leafer on NSH.
 *
 * Leafer drives a Canvas 2D context of its own and reads pixels back for hit
 * testing. NSH's `Canvas` hands a recording context to `draw` and replays it
 * natively, with no DOM, no offscreen canvases and no pixel readback. This
 * adapter is the public entry point to that world:
 *
 * - the main canvas records every call Leafer makes; `draw` replays them onto
 *   the NSH context of the frame,
 * - hit canvases are recorded as paths in JS, so `isPointInPath`,
 *   `isPointInStroke` and the hit canvas's `getImageData` are answered from
 *   geometry instead of pixels,
 * - offscreen canvases (groups with opacity, blend modes, masks, temporary
 *   composite layers) are copied when Leafer draws them, and replayed as
 *   vectors into the destination rectangle,
 * - the canvas has no patterns: a pattern fill clips to the path and tiles
 *   the image itself,
 * - `Platform.requestRender` asks the app for a new frame instead of a
 *   browser animation frame; the view draws every frame in full,
 * - images load through NSH's `Image`; an asset's `@2x`/`@3x` name gives its
 *   density,
 * - Leafer culls what is outside the canvas itself, so large scenes stay
 *   cheap when the viewport moves.
 *
 * The implementation is split by responsibility under `./platform/`: the
 * geometry and path recorder, paint records, operation replay, recording
 * context, canvas surface and Leafer installation. Consumers import this
 * facade; the modules beneath it are internal to the adapter.
 */

export { clearRenderMarks } from "./platform/frame";
export { addDrawRequester, LeaferHost, installNshPlatform, pointerData } from "./platform/host";
export { NshRecordingContext } from "./platform/recording-context";
export { NshCanvasSurface } from "./platform/surface";
export type { Matrix, Point } from "./platform/geometry";
export type { PointerData } from "./platform/host";
export type { CanvasSnapshot } from "./platform/snapshot";
