import { Image as NshImage, pixelRatio } from "nsh";
import type { IPointerEvent, IPlatform } from "@leafer-ui/interface";
import { Creator, InteractionBase, Platform } from "@leafer-ui/miniapp";
import type { ReplayContext } from "./canvas";
import { assetScale, imageSource } from "./image";
import { setMeasureContext } from "./measure";
import { NshCanvasSurface } from "./surface";

const drawRequesters = new Set<() => void>();

/** Registers a view's frame request; returns the cleanup. */
export function addDrawRequester(requester: () => void): () => void {
  drawRequesters.add(requester);
  return () => {
    drawRequesters.delete(requester);
  };
}

/** The canvas the NSH component draws one frame into. */
export class LeaferHost {
  readonly view = new NshCanvasSurface(1, 1, false);
  private frameContext: ReplayContext | null = null;

  beginFrame(context: ReplayContext, width: number, height: number): void {
    this.frameContext = context;
    setMeasureContext(context);
    this.view.width = Math.max(1, Math.round(width));
    this.view.height = Math.max(1, Math.round(height));
    this.view.context.beginFrame();
  }

  endFrame(): void {
    if (this.frameContext) this.view.context.replay(this.frameContext);
    this.frameContext = null;
  }

  dispose(): void {
    this.frameContext = null;
    setMeasureContext(null);
  }
}

/** A pointer event in the shape Leafer's interaction expects. */
export interface PointerData extends IPointerEvent {
  button?: number;
}

export function pointerData(
  x: number,
  y: number,
  options?: {
    multiTouch?: boolean;
    pointerType?: "mouse" | "pen" | "touch";
    buttons?: number;
    button?: number;
    pressure?: number;
    altKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
  },
): PointerData {
  return {
    x,
    y,
    width: 1,
    height: 1,
    pointerType: options?.pointerType ?? "mouse",
    multiTouch: Boolean(options?.multiTouch),
    pressure: options?.pressure ?? 1,
    buttons: options?.buttons ?? 1,
    button: options?.button ?? 0,
    altKey: Boolean(options?.altKey),
    ctrlKey: Boolean(options?.ctrlKey),
    shiftKey: Boolean(options?.shiftKey),
    metaKey: Boolean(options?.metaKey),
    time: Date.now(),
  };
}

let installed = false;

/** Points Leafer's platform layer at NSH. Safe to call more than once. */
export function installNshPlatform(): void {
  if (installed) return;
  installed = true;

  const origin: NonNullable<IPlatform["origin"]> = {
    createCanvas(width: number, height: number) {
      return new NshCanvasSurface(width || 1, height || 1, true);
    },
    canvasToDataURL() {
      return "";
    },
    canvasToBolb() {
      return Promise.reject(new Error("Exporting images is not supported here."));
    },
    canvasSaveAs() {
      return Promise.reject(new Error("Saving images is not supported here."));
    },
    download() {
      return Promise.resolve();
    },
    loadImage(url: string): Promise<{ url: string; width: number; height: number }> {
      // `Image.getSize` counts pixels. An asset is named with its density
      // (`logo@2x.png`), or is 1x; a remote image follows the screen's ratio.
      const scale = url.startsWith("asset:") ? assetScale(url) : pixelRatio();
      return NshImage.getSize(url).then((size) => ({
        url,
        width: size.width / scale,
        height: size.height / scale,
      }));
    },
    loadContent(url: string, responseType?: string): Promise<unknown> {
      return fetch(url).then((response) => {
        if (responseType === "arrayBuffer") return response.arrayBuffer();
        if (responseType === "json") return response.json();
        return response.text();
      });
    },
    noRepeat: "no-repeat",
  };

  Platform.origin = origin;
  const platformCanvas = Creator.canvas?.();
  if (platformCanvas) Platform.canvas = platformCanvas;
  Platform.conicGradientSupport = true;
  // The miniapp canvas reaches for the host's window API when it resizes or
  // stops its auto layout; NSH resizes the view itself.
  Platform.miniapp = {
    select: () => ({}),
    getBounds: () => Promise.resolve({ x: 0, y: 0, width: 0, height: 0 }),
    getSizeView: () => Promise.resolve({ view: null, width: 0, height: 0 }),
    saveToAlbum: () => Promise.resolve(true),
    onWindowResize() {},
    offWindowResize() {},
  };
  Object.defineProperty(Platform, "devicePixelRatio", {
    get: () => 1,
    configurable: true,
  });
  Platform.requestRender = () => {
    for (const requester of drawRequesters) requester();
  };

  // A "resized canvas" is the same image under another size in points: the
  // pattern code only uses its size, and drawing scales the picture.
  Platform.image.resize = (
    view: unknown,
    width: number,
    height: number,
    xGap?: number,
    yGap?: number,
    _clip?: unknown,
    _smooth?: boolean,
    opacity?: number,
  ) => {
    if (!view) return view;
    const url = imageSource(view);
    if (!url) return view;
    return {
      url,
      width: Math.max(1, Math.floor(width + (xGap ?? 0))),
      height: Math.max(1, Math.floor(height + (yGap ?? 0))),
      opacity,
    };
  };

  // Interaction without DOM: the app feeds pointer events in.
  Creator.interaction = (target, canvas, selector, options) =>
    new InteractionBase(target, canvas, selector, options);

  // Hit canvases are the only ones that need the recorded geometry: mark
  // them so ordinary render canvases skip flattening paths for hit tests.
  const createHitCanvas = Creator.hitCanvas?.bind(Creator);
  Creator.hitCanvas = (options, manager) => {
    if (!createHitCanvas) throw new Error("Leafer's Creator has no hit canvas.");
    const canvas = createHitCanvas(options, manager);
    const surface: unknown = canvas.view;
    if (surface instanceof NshCanvasSurface) surface.context.hitOnly = true;
    return canvas;
  };
}
