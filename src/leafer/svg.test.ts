import { expect, test } from "nsh/test";
import { NshCanvasSurface } from "./nsh-platform";
import { needsRaster } from "./platform/raster";
import { PathCommands } from "./platform/svg/path";
import { snapshotSvg } from "./platform/svg/serialize";

function surface(width: number, height: number): NshCanvasSurface {
  return new NshCanvasSurface(width, height, true);
}

function fillBar(ctx: NshCanvasSurface["context"], color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 20, 20);
}

test("turns a destination-in mask into an alpha mask", () => {
  const mask = surface(20, 20);
  fillBar(mask.context, "#fff");
  const group = surface(20, 20);
  group.context.fillStyle = "#f00";
  group.context.fillRect(0, 0, 20, 10);
  group.context.save();
  group.context.globalCompositeOperation = "destination-in";
  group.context.drawImage(mask, 0, 0);
  group.context.globalCompositeOperation = "source-over";
  group.context.restore();

  const svg = snapshotSvg(group.snapshot());
  expect(svg).toContain("<mask");
  expect(svg).toContain('mask-type="alpha"');
  expect(svg).toContain('mask="url(#mask');
});

test("turns an eraser into an alpha-inverting mask", () => {
  const eraser = surface(20, 20);
  fillBar(eraser.context, "#000");
  const group = surface(20, 20);
  group.context.fillStyle = "#0f0";
  group.context.fillRect(0, 0, 20, 20);
  group.context.save();
  group.context.globalCompositeOperation = "destination-out";
  group.context.drawImage(eraser, 0, 0);
  group.context.globalCompositeOperation = "source-over";
  group.context.restore();

  const svg = snapshotSvg(group.snapshot());
  expect(svg).toContain("<mask");
  expect(svg).toContain("<feFlood");
  expect(svg).toContain('operator="out"');
});

test("a grayscale mask keeps Leafer's Rec.601 weights", () => {
  const mask = surface(20, 20);
  fillBar(mask.context, "#fff");
  const pixels = mask.context.getImageData(0, 0, 20, 20);
  mask.context.putImageData(pixels, 0, 0);
  expect(mask.snapshot().grayscale).toBe(true);

  const group = surface(20, 20);
  group.context.fillStyle = "#00f";
  group.context.fillRect(0, 0, 20, 20);
  group.context.save();
  group.context.globalCompositeOperation = "destination-in";
  group.context.drawImage(mask, 0, 0);
  group.context.globalCompositeOperation = "source-over";
  group.context.restore();

  // SVG's luminance mask uses Rec.709; Leafer's grayscale pass uses Rec.601,
  // so the serializer converts with a filter and uses its alpha.
  const svg = snapshotSvg(group.snapshot());
  expect(svg).toContain('mask-type="alpha"');
  expect(svg).toContain("0.299 0.587 0.114");
  expect(svg).toContain('operator="in"');
});

test("a blend copy carries its blend mode as one layer", () => {
  const box = surface(20, 20);
  fillBar(box.context, "#00f");
  const group = surface(20, 20);
  group.context.save();
  group.context.globalCompositeOperation = "multiply";
  group.context.drawImage(box, 0, 0);
  group.context.globalCompositeOperation = "source-over";
  group.context.restore();

  expect(snapshotSvg(group.snapshot())).toContain("mix-blend-mode:multiply");
});

test("a pattern keeps its gap and draws the picture at its own size", () => {
  const canvas = surface(80, 80);
  canvas.context.fillStyle = canvas.context.createPattern(
    { url: "data:image/png;base64,AA==", width: 40, height: 40, imageWidth: 20, imageHeight: 20 },
    "repeat",
  );
  canvas.context.fillRect(0, 0, 80, 80);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg.match(/<image/g)?.length).toBe(4);
  expect(svg).toContain('width="20"');
  expect(svg).toContain('href="data:image/png;base64,AA=="');
});

test("patterned strokes and text use a pattern paint server", () => {
  const canvas = surface(60, 40);
  const pattern = canvas.context.createPattern(
    { url: "data:image/png;base64,AA==", width: 10, height: 10 },
    "repeat",
  );
  canvas.context.strokeStyle = pattern;
  canvas.context.beginPath();
  canvas.context.rect(2, 2, 40, 10);
  canvas.context.stroke();
  canvas.context.fillStyle = pattern;
  canvas.context.fillText("x", 2, 30);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg.match(/<pattern/g)?.length).toBeGreaterThan(0);
  expect(svg).toContain('stroke="url(#pattern');
  expect(svg).toContain('fill="url(#pattern');
});

test("a transformed path keeps Canvas' stroke space", () => {
  const canvas = surface(40, 40);
  canvas.context.scale(2, 2);
  canvas.context.beginPath();
  canvas.context.rect(0, 0, 10, 10);
  canvas.context.lineWidth = 3;
  canvas.context.stroke();

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain('transform="matrix(2 0 0 2 0 0)"');
  expect(svg).toContain("M 0 0 L 10 0 L 10 10 L 0 10 Z");
  expect(svg).toContain('stroke-width="3"');
});

test("text keeps its font, alignment and escaped content", () => {
  const canvas = surface(100, 40);
  canvas.context.font = "600 15px Inter";
  canvas.context.textAlign = "center";
  canvas.context.fillStyle = "#fff";
  canvas.context.fillText("a<b&c", 50, 20);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain("<text");
  expect(svg).toContain('font-size="15"');
  expect(svg).toContain('font-weight="600"');
  expect(svg).toContain('text-anchor="middle"');
  expect(svg).toContain("a&lt;b&amp;c");

  const system = surface(40, 40);
  system.context.font = "18px caption";
  system.context.fillText("x", 2, 20);
  expect(snapshotSvg(system.snapshot())).toContain('font-family="sans-serif"');
});

test("a shadow becomes a drop-shadow filter", () => {
  const canvas = surface(40, 40);
  canvas.context.fillStyle = "#f00";
  canvas.context.shadowColor = "rgba(0,0,0,0.4)";
  canvas.context.shadowBlur = 8;
  canvas.context.shadowOffsetX = 2;
  canvas.context.shadowOffsetY = 3;
  canvas.context.fillRect(10, 10, 20, 20);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain("<feDropShadow");
  expect(svg).toContain('dx="2"');
  expect(svg).toContain('dy="3"');
  expect(svg).toContain('stdDeviation="4"');
});

test("places a nested snapshot by its source and destination rectangles", () => {
  const inner = surface(10, 10);
  fillBar(inner.context, "#abc");
  const canvas = surface(40, 40);
  canvas.context.drawImage(inner, 0, 0, 10, 10, 5, 6, 20, 20);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain("matrix(2 0 0 2 5 6)");
  expect(svg).toContain('clip-path="url(#clip');
});

test("only layers whose compositing must stay inside them are rasterized", () => {
  const plain = surface(10, 10);
  fillBar(plain.context, "#fff");
  expect(needsRaster(plain.snapshot(), 1, "source-over")).toBe(false);
  expect(needsRaster(plain.snapshot(), 0.5, "source-over")).toBe(true);
  expect(needsRaster(plain.snapshot(), 1, "multiply")).toBe(true);

  const mask = surface(10, 10);
  mask.context.save();
  mask.context.globalCompositeOperation = "destination-in";
  mask.context.fillRect(0, 0, 10, 10);
  mask.context.restore();
  expect(needsRaster(mask.snapshot(), 1, "source-over")).toBe(true);

  // A composite inside the layer combines with the layer's own content,
  // never with the destination: the whole layer rasterizes.
  const blended = surface(10, 10);
  blended.context.globalCompositeOperation = "multiply";
  blended.context.drawImage(plain, 0, 0);
  blended.context.globalCompositeOperation = "source-over";
  expect(needsRaster(blended.snapshot(), 1, "source-over")).toBe(true);

  const pattern = { url: "data:image/png;base64,AA==", width: 5, height: 5 };
  const patterned = surface(10, 10);
  patterned.context.strokeStyle = patterned.context.createPattern(pattern, "repeat");
  patterned.context.strokeRect(0, 0, 10, 10);
  expect(needsRaster(patterned.snapshot(), 1, "source-over")).toBe(true);

  const filled = surface(10, 10);
  filled.context.fillStyle = filled.context.createPattern(pattern, "repeat");
  filled.context.fillRect(0, 0, 10, 10);
  expect(needsRaster(filled.snapshot(), 1, "source-over")).toBe(false);

  const cleared = new NshCanvasSurface(10, 10, false);
  cleared.context.clearRect(1, 1, 5, 5);
  expect(needsRaster(cleared.snapshot(), 1, "source-over")).toBe(true);
});

test("arcTo joins a transformed path in its user space", () => {
  const ctm = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 };
  const path = new PathCommands();
  path.moveTo(0, 0, ctm);
  path.arcTo(10, 0, 10, 10, 5, ctm);

  // The tangent point is user-space (5, 0), baked to canvas (105, 0); the
  // arc ends at the other tangent (10, 5), baked to (110, 5).
  expect(path.commands[1].points[0].x).toBe(105);
  expect(path.commands[1].points[0].y).toBe(0);
  const end = path.commands[path.commands.length - 1].points[0];
  expect(Math.round(end.x)).toBe(110);
  expect(Math.round(end.y)).toBe(5);
});

test("a shadow's region stays in canvas space around a transformed shape", () => {
  const canvas = surface(300, 200);
  canvas.context.translate(100, 50);
  canvas.context.fillStyle = "#f00";
  canvas.context.shadowColor = "rgba(0,0,0,0.5)";
  canvas.context.shadowBlur = 8;
  canvas.context.fillRect(0, 0, 20, 20);

  const svg = snapshotSvg(canvas.snapshot());
  // The filter is on an untransformed wrapper; the shape keeps its matrix.
  expect(svg).toContain("<g filter=");
  expect(svg).toContain('transform="matrix(1 0 0 1 100 50)"');
  expect(svg).toContain('x="86"');
  expect(svg).toContain('y="36"');
});

test("a stroke's shadow region includes its joins", () => {
  const canvas = surface(100, 100);
  canvas.context.strokeStyle = "#f00";
  canvas.context.lineWidth = 20;
  canvas.context.shadowColor = "rgba(0,0,0,0.5)";
  canvas.context.beginPath();
  canvas.context.moveTo(50, 10);
  canvas.context.lineTo(50, 90);
  canvas.context.stroke();

  const svg = snapshotSvg(canvas.snapshot());
  const x = Number(/<filter[^>]* x="(-?[\d.]+)"/.exec(svg)?.[1]);
  // The 20-wide miter can reach 100 points out at the default limit, so the
  // region cannot start at the 50-point path.
  expect(x <= -40).toBe(true);
});

test("a stroke's shadow region scales with the paint-time transform", () => {
  const canvas = surface(100, 100);
  canvas.context.scale(4, 4);
  canvas.context.strokeStyle = "#f00";
  canvas.context.lineWidth = 4;
  canvas.context.lineJoin = "round";
  canvas.context.shadowColor = "rgba(0,0,0,0.5)";
  canvas.context.beginPath();
  canvas.context.moveTo(0, 10);
  canvas.context.lineTo(20, 10);
  canvas.context.stroke();

  const svg = snapshotSvg(canvas.snapshot());
  const y = Number(/<filter[^>]* y="(-?[\d.]+)"/.exec(svg)?.[1]);
  const height = Number(/<filter[^>]* height="(-?[\d.]+)"/.exec(svg)?.[1]);
  // The 4-wide round stroke is 16 canvas units wide at scale 4 (y 32..48):
  // the region must include it, not pad the unscaled 2 units.
  expect(y <= 32).toBe(true);
  expect(y + height >= 48).toBe(true);
});

test("a shadow with no blur or offset still shows behind a translucent fill", () => {
  const canvas = surface(40, 40);
  canvas.context.fillStyle = "rgba(255,0,0,0.5)";
  canvas.context.shadowColor = "rgba(0,0,0,1)";
  canvas.context.fillRect(10, 10, 20, 20);

  expect(snapshotSvg(canvas.snapshot())).toContain("<feDropShadow");
});

test("a conic gradient turns and scales with the paint transform", () => {
  const canvas = surface(200, 100);
  canvas.context.translate(50, 10);
  canvas.context.scale(2, 1);
  const gradient = canvas.context.createConicGradient(0, 10, 5);
  gradient.addColorStop(0, "#f00");
  gradient.addColorStop(1, "#00f");
  canvas.context.fillStyle = gradient;
  canvas.context.fillRect(0, 0, 40, 40);

  const svg = snapshotSvg(canvas.snapshot());
  // Wedges are in gradient user space (their centre is 10 5), carried by
  // the paint-time matrix.
  expect(svg).toContain('transform="matrix(2 0 0 1 50 10)"');
  expect(svg).toContain("M 10 5 L ");
});

test("stroke text does not fill its glyphs black", () => {
  const canvas = surface(60, 40);
  canvas.context.strokeStyle = "#f00";
  canvas.context.lineWidth = 4;
  canvas.context.strokeText("x", 2, 30);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain('fill="none"');
  expect(svg).toContain('stroke="#f00"');
  expect(svg).toContain('stroke-width="4"');
});

test("a non-repeating pattern covers the stroke with one tile", () => {
  const canvas = surface(80, 20);
  const pattern = canvas.context.createPattern(
    { url: "data:image/png;base64,AA==", width: 10, height: 10 },
    "no-repeat",
  );
  canvas.context.strokeStyle = pattern;
  canvas.context.beginPath();
  canvas.context.rect(2, 2, 76, 16);
  canvas.context.stroke();

  const svg = snapshotSvg(canvas.snapshot());
  const width = /<pattern[^>]*width="([\d.]+)"/.exec(svg)?.[1];
  expect(width !== undefined && Number(width) > 10).toBe(true);
});

test("a non-repeating pattern does not paint before its origin", () => {
  const canvas = surface(120, 60);
  const pattern = canvas.context.createPattern(
    { url: "data:image/png;base64,AA==", width: 10, height: 10 },
    "no-repeat",
  );
  pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
  canvas.context.strokeStyle = pattern;
  canvas.context.lineWidth = 4;
  canvas.context.beginPath();
  canvas.context.moveTo(60, 5);
  canvas.context.lineTo(80, 5);
  canvas.context.stroke();

  const svg = snapshotSvg(canvas.snapshot());
  // The stroke is pattern x -40..-20, before the tile: Canvas paints nothing
  // there, so the element is clipped to the origin cell (local x -100..-90).
  const clip = /<clipPath[^>]*>(.*?)<\/clipPath>/s.exec(svg)?.[1] ?? "";
  expect(clip).toContain("-100");
  expect(clip).toContain("-90");
});

test("text keeps Canvas' letter and word spacing", () => {
  const canvas = surface(100, 40);
  canvas.context.letterSpacing = "2px";
  canvas.context.wordSpacing = "3px";
  canvas.context.fillText("a b", 4, 20);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg).toContain('letter-spacing="2px"');
  expect(svg).toContain('word-spacing="3px"');
  expect(svg).toContain('xml:space="preserve"');
});

test("RTL text keeps Canvas' flow-relative anchors", () => {
  const canvas = surface(100, 40);
  canvas.context.direction = "rtl";
  canvas.context.fillText("x", 50, 20);
  const start = snapshotSvg(canvas.snapshot());
  expect(start).toContain('text-anchor="start"');
  expect(start).toContain('direction="rtl"');

  const left = surface(100, 40);
  left.context.direction = "rtl";
  left.context.textAlign = "left";
  left.context.fillText("x", 50, 20);
  expect(snapshotSvg(left.snapshot())).toContain('text-anchor="end"');
});

test("text with XML-invalid characters still makes a document", () => {
  const canvas = surface(100, 40);
  canvas.context.fillText("a\u0001b", 2, 20);
  const svg = snapshotSvg(canvas.snapshot());
  expect(svg.includes("\u0001")).toBe(false);
  expect(svg).toContain("a�b");
});

test("a negative destination rectangle mirrors in a rasterized layer", () => {
  const inner = surface(10, 10);
  fillBar(inner.context, "#abc");
  const canvas = surface(40, 40);
  canvas.context.drawImage(inner, 0, 0, 10, 10, 5, 6, -20, 20);

  expect(snapshotSvg(canvas.snapshot())).toContain("matrix(-2 0 0 2 5 6)");
});

test("fractional source rectangles keep their exact crop", () => {
  const inner = surface(4, 4);
  fillBar(inner.context, "#abc");

  // The viewBox maps exactly the source rectangle, even below one point;
  // only a full snapshot's intrinsic size is rounded up.
  const svg = snapshotSvg(inner.snapshot(), { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  expect(svg).toContain('viewBox="0.5 0.5 0.5 0.5"');
  expect(svg).toContain('width="0.5"');
});

test("a drawing clear masks the layer before it, not after it", () => {
  // Leafer's path eraser records save, clip(eraser), clearRect(its bounds),
  // restore on the parent's offscreen layer. The clear must erase the red
  // fill under the clip and leave the blue fill drawn afterwards.
  const canvas = new NshCanvasSurface(20, 20, true);
  const ctx = canvas.context;
  ctx.fillStyle = "#f00";
  ctx.fillRect(0, 0, 20, 20);
  ctx.save();
  ctx.beginPath();
  ctx.rect(5, 5, 5, 5);
  ctx.clip();
  ctx.clearRect(5, 5, 5, 5);
  ctx.restore();
  ctx.fillStyle = "#00f";
  ctx.fillRect(0, 15, 20, 5);

  const snapshot = canvas.snapshot();
  expect(snapshot.ops.some((op) => op[0] === 1 && op[1] === "clearRect")).toBe(true);
  const svg = snapshotSvg(snapshot);
  expect(svg).toContain("<mask");
  expect(svg).toContain('fill="#f00"');
  expect(svg).toContain('fill="#00f"');
  // The earlier content is the masked group; the later fill is a sibling.
  expect(svg.indexOf('fill="#00f"')).toBeGreaterThan(svg.indexOf('fill="#f00"'));
});

test("an offscreen recycle clear starts the recording over", () => {
  const canvas = new NshCanvasSurface(10, 10, true);
  canvas.context.fillRect(0, 0, 10, 10);
  // A full clear at rest is Leafer reusing the canvas, not a drawing clear.
  canvas.context.clearRect(0, 0, 10, 10);
  expect(canvas.snapshot().ops.length).toBe(0);
});

test("clearRect is measured through the current transform", () => {
  // A render canvas records a clear that is partial in user space. Here the
  // transform moves it over the whole canvas, so it empties the layer
  // instead of building a mask: the user-space rectangle alone is 10..50.
  const canvas = new NshCanvasSurface(40, 40, false);
  canvas.context.translate(-10, -10);
  canvas.context.fillStyle = "#f00";
  canvas.context.fillRect(0, 0, 60, 60);
  canvas.context.clearRect(10, 10, 40, 40);

  const svg = snapshotSvg(canvas.snapshot());
  expect(svg.includes("<mask")).toBe(false);
  expect(svg.includes("<path")).toBe(false);
});
