import { expect, test } from "nsh/test";
import { App, Leafer, Rect } from "@leafer-ui/miniapp";
import "@leafer-in/editor";
import type { CanvasRenderingContext2D } from "nsh";
import {
  clearRenderMarks,
  installNshPlatform,
  NshCanvasSurface,
  pointerData,
} from "./nsh-platform";
import { setMeasureContext } from "./platform/measure";

test("clears Leafer's hidden frame marks on every layer", () => {
  installNshPlatform();
  const view = new NshCanvasSurface(200, 100, false);
  const app = new App({
    view,
    width: 200,
    height: 100,
    pixelRatio: 1,
    start: false,
    tree: {},
    editor: {},
  });
  const hidden = (layer: { renderer: unknown }): { requestTime: number } =>
    layer.renderer as { requestTime: number };

  for (const layer of [app, app.tree, app.sky]) hidden(layer).requestTime = 1;
  clearRenderMarks(app);
  for (const layer of [app, app.tree, app.sky]) expect(hidden(layer).requestTime).toBe(0);

  app.destroy();
});

test("answers hit tests from recorded paths", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.hitOnly = true; // this one stands in for a hit canvas

  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 40, 8);
  ctx.fill();

  expect(ctx.isPointInPath(50, 30)).toBe(true);
  expect(ctx.isPointInPath(12, 12)).toBe(false);
  expect(ctx.isPointInPath(95, 30)).toBe(false);

  const inside = ctx.getImageData(50, 30, 1, 1);
  expect(inside.data[3]).toBe(255);
  const outside = ctx.getImageData(2, 2, 1, 1);
  expect(outside.data[3]).toBe(0);
});

test("composites an offscreen canvas as vectors", () => {
  const offscreen = new NshCanvasSurface(100, 50, true);
  offscreen.context.fillStyle = "#ff5a5f";
  offscreen.context.fillRect(0, 0, 100, 50);

  const main = new NshCanvasSurface(200, 100, false);
  const ctx = main.context;
  ctx.beginFrame();
  ctx.drawImage(offscreen, 10, 20, 200, 100);

  const calls: string[] = [];
  // Replaying only needs the canvas methods the recording actually used.
  const target = {
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    globalAlpha: 1,
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
      calls.push(`transform:${a},${b},${c},${d},${e},${f}`);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push(`fillRect:${x},${y},${w},${h}`);
    },
  } as unknown as CanvasRenderingContext2D;

  ctx.replay(target);
  expect(calls).toContain("transform:2,0,0,2,10,20");
  expect(calls).toContain("fillRect:0,0,100,50");
});

test("roundRect without radii has square hit corners", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.hitOnly = true;

  ctx.beginPath();
  ctx.roundRect(10, 10, 80, 40);
  ctx.fill();

  // A radius-less roundRect is a rectangle: its corner must hit.
  expect(ctx.isPointInPath(12, 12)).toBe(true);
});

test("measures text with the context's font", () => {
  const canvas = new NshCanvasSurface(100, 100, false);
  const seen: string[] = [];
  let font = "12px sans-serif";
  const native = {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    measureText(text: string) {
      seen.push(font);
      return { width: text.length * 10 };
    },
  } as unknown as CanvasRenderingContext2D;

  setMeasureContext(native);
  try {
    canvas.context.font = "600 15px sans-serif";
    expect(canvas.context.measureText("abc").width).toBe(30);
    expect(seen).toEqual(["600 15px sans-serif"]);
  } finally {
    setMeasureContext(null);
  }
});

test("multiplies an offscreen layer's alpha when replaying it", () => {
  const offscreen = new NshCanvasSurface(10, 10, true);
  offscreen.context.globalAlpha = 0.5;
  offscreen.context.fillRect(0, 0, 10, 10);

  const main = new NshCanvasSurface(10, 10, false);
  main.context.beginFrame();
  main.context.globalAlpha = 0.9;
  main.context.drawImage(offscreen, 0, 0);

  const alphas: number[] = [];
  let alpha = 1;
  const target = {
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    setTransform() {},
    transform() {},
    fillRect() {},
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(value: number) {
      alpha = value;
      alphas.push(Math.round(value * 100));
    },
  } as unknown as CanvasRenderingContext2D;

  main.context.replay(target);
  expect(alphas).toContain(45);
});

test("composes a snapshot's transform with its placement", () => {
  const offscreen = new NshCanvasSurface(10, 10, true);
  offscreen.context.beginFrame();
  offscreen.context.setTransform(2, 0, 0, 2, 0, 0);
  offscreen.context.fillRect(0, 0, 10, 10);

  const main = new NshCanvasSurface(20, 20, false);
  main.context.beginFrame();
  main.context.drawImage(offscreen, 5, 6);

  const calls: string[] = [];
  const target = {
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    transform() {},
    fillRect() {},
    globalAlpha: 1,
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      calls.push(`setTransform:${a},${b},${c},${d},${e},${f}`);
    },
  } as unknown as CanvasRenderingContext2D;

  main.context.replay(target);
  expect(calls).toContain("setTransform:2,0,0,2,5,6");
});

test("replays gradients", () => {
  const canvas = new NshCanvasSurface(100, 100, false);
  const ctx = canvas.context;
  ctx.beginFrame();

  const gradient = ctx.createLinearGradient(0, 0, 100, 0);
  gradient.addColorStop(0, "#ff0000");
  gradient.addColorStop(1, "#0000ff");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 100, 100);

  const stops: number[] = [];
  const target = {
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    createLinearGradient() {
      return {
        addColorStop(offset: number) {
          stops.push(offset);
        },
      };
    },
    fillRect() {},
  } as unknown as CanvasRenderingContext2D;

  ctx.replay(target);
  expect(stops).toEqual([0, 1]);
});

test("replays numeric style properties", () => {
  const canvas = new NshCanvasSurface(10, 10, false);
  const ctx = canvas.context;
  ctx.beginFrame();

  ctx.globalAlpha = 0.2;
  ctx.lineWidth = 2.5;
  ctx.shadowBlur = 8;
  ctx.shadowColor = "#123456";

  const seen: Record<string, unknown> = {};
  const target = {
    resetTransform() {},
    setLineDash() {},
    set globalAlpha(value: number) {
      seen.globalAlpha = value;
    },
    set lineWidth(value: number) {
      seen.lineWidth = value;
    },
    set shadowBlur(value: number) {
      seen.shadowBlur = value;
    },
    set shadowColor(value: string) {
      seen.shadowColor = value;
    },
  } as unknown as CanvasRenderingContext2D;

  ctx.replay(target);

  // These carry Leafer's leaf opacity, stroke width and shadows; treating them
  // as paints used to drop every one of them.
  expect(seen.globalAlpha).toBe(0.2);
  expect(seen.lineWidth).toBe(2.5);
  expect(seen.shadowBlur).toBe(8);
  expect(seen.shadowColor).toBe("#123456");
});

test("answers stroke hit tests", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.hitOnly = true;

  ctx.beginPath();
  ctx.moveTo(10, 50);
  ctx.lineTo(90, 50);
  ctx.lineWidth = 4;
  ctx.stroke();

  // A stroke is not a fill: the line's interior is empty.
  expect(ctx.isPointInPath(50, 50)).toBe(false);
  expect(ctx.isPointInStroke(50, 51)).toBe(true);
  expect(ctx.isPointInStroke(50, 80)).toBe(false);
  // The default lineCap is butt, so the stroke ends at the endpoint.
  expect(ctx.isPointInStroke(9, 50)).toBe(false);

  ctx.lineCap = "round";
  ctx.stroke();
  expect(ctx.isPointInStroke(9, 50)).toBe(true);
});

test("winds subpaths like the canvas", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.hitOnly = true;

  // A square inside a square: even-odd leaves a hole, nonzero fills it.
  ctx.beginPath();
  ctx.rect(10, 10, 80, 80);
  ctx.rect(30, 30, 40, 40);

  expect(ctx.isPointInPath(50, 50)).toBe(true);
  expect(ctx.isPointInPath(50, 50, "evenodd")).toBe(false);
  expect(ctx.isPointInPath(20, 20, "evenodd")).toBe(true);
});

test("an offscreen clear starts a new drawing", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.beginFrame();
  ctx.fillRect(0, 0, 10, 10);
  expect(ctx.ops.length).toBeGreaterThan(0);

  ctx.clearRect(0, 0, 100, 100);
  expect(ctx.ops.length).toBe(0);
});

test("resizing a surface starts a new drawing", () => {
  const canvas = new NshCanvasSurface(100, 100, true);
  const ctx = canvas.context;
  ctx.beginFrame();
  ctx.fillRect(0, 0, 10, 10);
  expect(ctx.ops.length).toBeGreaterThan(0);

  canvas.width = 120;
  expect(ctx.ops.length).toBe(0);
});

test("tiles a pattern fill", () => {
  const canvas = new NshCanvasSurface(200, 100, false);
  const ctx = canvas.context;
  ctx.beginFrame();

  const pattern = ctx.createPattern({ url: "asset:/tile.png", width: 20, height: 20 }, "repeat");
  ctx.fillStyle = pattern;
  ctx.beginPath();
  ctx.rect(0, 0, 50, 50);
  ctx.fill();

  const images: unknown[][] = [];
  const target = {
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    clip() {},
    transform() {},
    drawImage(...args: unknown[]) {
      images.push(args);
    },
  } as unknown as CanvasRenderingContext2D;

  ctx.replay(target);
  expect(images.length).toBeGreaterThan(1);
  expect(images[0][0]).toBe("asset:/tile.png");
});

test("keeps a pattern's own opacity inside the destination alpha", () => {
  const canvas = new NshCanvasSurface(200, 100, false);
  const ctx = canvas.context;
  ctx.beginFrame();

  // A zero-alpha destination (an invisible layer) stays invisible even when
  // the pattern tile itself has opacity.
  ctx.globalAlpha = 0;
  const pattern = ctx.createPattern(
    { url: "asset:/tile.png", width: 20, height: 20, opacity: 0.5 },
    "repeat",
  );
  ctx.fillStyle = pattern;
  ctx.beginPath();
  ctx.rect(0, 0, 50, 50);
  ctx.fill();

  const alphas: number[] = [];
  let layerAlpha = 1;
  const target = {
    get globalAlpha() {
      return layerAlpha;
    },
    set globalAlpha(value: number) {
      layerAlpha = value;
    },
    resetTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    beginPath() {},
    clip() {},
    transform() {},
    drawImage() {
      alphas.push(layerAlpha);
    },
  } as unknown as CanvasRenderingContext2D;

  ctx.replay(target);
  expect(alphas.length).toBeGreaterThan(1);
  expect(alphas.every((alpha) => alpha === 0)).toBe(true);
});

test("leafer picks and drags elements", () => {
  installNshPlatform();

  const view = new NshCanvasSurface(400, 300, false);
  const app = new Leafer({
    view,
    width: 400,
    height: 300,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
  });
  const rect = new Rect({
    x: 50,
    y: 50,
    width: 100,
    height: 60,
    cornerRadius: 12,
    fill: "#ff5a5f",
    draggable: true,
  });
  app.add(rect);
  app.start();

  const interaction = app.interaction;
  if (!interaction) throw new Error("Leafer created no interaction.");

  interaction.pointerMove(pointerData(100, 80));
  const hovered = interaction.hoverData?.path?.list ?? [];
  expect(hovered.some((leaf) => leaf === rect)).toBe(true);

  interaction.pointerDown(pointerData(100, 80));
  const path = interaction.downData?.path?.list ?? [];
  expect(path.some((leaf) => leaf === rect)).toBe(true);

  interaction.pointerMove(pointerData(140, 110));
  interaction.pointerUp(pointerData(140, 110));

  expect(rect.x).toBeGreaterThan(50);
  expect(rect.y).toBeGreaterThan(50);

  app.destroy();
});
