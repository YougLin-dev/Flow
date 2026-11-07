import type { ReplayContext } from "./canvas";
import { applyMatrix, clamp, identity, invert, multiply, type Matrix } from "./geometry";
import { imageSource } from "./image";
import type { Op } from "./op";
import { PatternRecord, resolvePaint } from "./paint";
import { isSnapshotSource, SnapshotImage, type CanvasSnapshot } from "./snapshot";
import { dimension, isRecord, numberArg, ruleArg, type PathRule } from "./values";

interface Tile {
  kind: "url" | "snapshot";
  url?: string;
  snapshot?: CanvasSnapshot;
  width: number;
  height: number;
  opacity?: number;
}

interface ReplayState {
  ctm: Matrix;
  fillPattern: PatternRecord | null;
  strokePattern: PatternRecord | null;
  /** Outer layer alpha that every replayed globalAlpha is multiplied by. */
  alphaScale: number;
}

function finiteArgs(args: unknown[]): number[] | null {
  const values = args.map(numberArg);
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

function currentAlpha(ctx: ReplayContext): number {
  try {
    const alpha = Number(ctx.globalAlpha);
    return Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
  } catch {
    return 1;
  }
}

function patternTile(pattern: PatternRecord): Tile | null {
  const image = pattern.image;
  if (isSnapshotSource(image)) {
    return {
      kind: "snapshot",
      snapshot: image.snapshot(),
      width: image.width,
      height: image.height,
    };
  }
  const url = imageSource(image);
  if (!url) return null;
  const record = isRecord(image) ? image : {};
  const size = isRecord(record.size) ? record.size : {};
  const tile: Tile = {
    kind: "url",
    url,
    width: dimension(record.width) ?? dimension(size.width) ?? 1,
    height: dimension(record.height) ?? dimension(size.height) ?? 1,
  };
  if (typeof record.opacity === "number") tile.opacity = record.opacity;
  return tile;
}

/** Replays a snapshot (an offscreen canvas' drawing) into `args`' rectangle. */
function drawSnapshot(
  ctx: ReplayContext,
  snapshot: CanvasSnapshot,
  args: number[],
  width: number,
  height: number,
  callerCtm: Matrix = identity(),
): void {
  const alphaScale = currentAlpha(ctx);
  let sx = 0;
  let sy = 0;
  let sw = snapshot.width;
  let sh = snapshot.height;
  let dx: number;
  let dy: number;
  let dw: number;
  let dh: number;
  if (args.length >= 8) {
    [sx, sy, sw, sh, dx, dy, dw, dh] = args;
  } else if (args.length >= 4) {
    [dx, dy, dw, dh] = args;
  } else if (args.length >= 2) {
    dx = args[0];
    dy = args[1];
    dw = snapshot.width;
    dh = snapshot.height;
  } else {
    return;
  }
  if (!sw || !sh || !dw || !dh) return;
  const kx = dw / sw;
  const ky = dh / sh;
  const placement: Matrix = { a: kx, b: 0, c: 0, d: ky, e: dx - sx * kx, f: dy - sy * ky };
  const baseCtm = multiply(callerCtm, placement);
  ctx.save();
  try {
    // A snapshot is an image: its content must not paint outside the
    // destination rectangle, and an explicit source rectangle crops it.
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.transform(placement.a, placement.b, placement.c, placement.d, placement.e, placement.f);
    replayOps(
      ctx,
      snapshot.ops,
      { ctm: baseCtm, fillPattern: null, strokePattern: null, alphaScale },
      width,
      height,
      baseCtm,
    );
  } finally {
    try {
      ctx.beginPath();
    } catch {
      // ignore
    }
    ctx.restore();
  }
}

/**
 * Draws a pattern by clipping to the current path and tiling the image;
 * NSH's canvas has no native patterns.
 */
function fillWithPattern(
  ctx: ReplayContext,
  pattern: PatternRecord,
  ctm: Matrix,
  width: number,
  height: number,
  rule?: PathRule,
): void {
  const tile = patternTile(pattern);
  if (!tile) return;
  // The pattern-space rectangle that covers the canvas (the pattern's own
  // transform is applied on top of the current one when tiling).
  const combined = pattern.transform ? multiply(ctm, pattern.transform) : ctm;
  const inv = invert(combined);
  if (!inv) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ]) {
    const p = applyMatrix(inv, corner);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

  const repeat = pattern.repeat || "repeat";
  const repeatX = repeat !== "repeat-y" && repeat !== "no-repeat";
  const repeatY = repeat !== "repeat-x" && repeat !== "no-repeat";
  const tw = tile.width;
  const th = tile.height;
  // A malformed tile must not stall the tile loops or divide by zero.
  if (!(tw > 0) || !(th > 0) || !Number.isFinite(tw) || !Number.isFinite(th)) return;
  const startX = repeatX ? Math.floor(minX / tw) * tw : 0;
  const startY = repeatY ? Math.floor(minY / th) * th : 0;
  const endX = repeatX ? maxX : startX + tw;
  const endY = repeatY ? maxY : startY + th;

  ctx.save();
  try {
    if (rule) ctx.clip(rule);
    else ctx.clip();
    if (typeof tile.opacity === "number" && tile.opacity >= 0 && tile.opacity < 1) {
      // `currentAlpha` keeps a zero destination alpha zero; `Number(x) || 1`
      // would turn an invisible layer visible.
      ctx.globalAlpha = currentAlpha(ctx) * tile.opacity;
    }
    if (pattern.transform) {
      const m = pattern.transform;
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    const tileCtm = pattern.transform ? multiply(ctm, pattern.transform) : ctm;
    for (let x = startX; x < endX; x += tw) {
      for (let y = startY; y < endY; y += th) {
        if (tile.kind === "snapshot" && tile.snapshot) {
          drawSnapshot(ctx, tile.snapshot, [x, y, tw, th], width, height, tileCtm);
        } else if (tile.url) {
          ctx.drawImage(tile.url, x, y, tw, th);
        }
      }
    }
  } finally {
    ctx.restore();
  }
}

/**
 * Replays recorded operations onto an NSH context, carrying enough state to
 * emulate what NSH's canvas does not have: patterns, offscreen canvases.
 */
export function replayOps(
  ctx: ReplayContext,
  ops: Op[],
  state: ReplayState,
  width: number,
  height: number,
  baseCtm: Matrix = identity(),
): void {
  const states: ReplayState[] = [];
  for (const op of ops) {
    if (op[0] === 0) {
      const name = op[1];
      if (!REPLAY_PROPS.has(name)) continue;
      const value = op[2];

      // Only the two paint properties need translating. Numbers and booleans
      // (globalAlpha, lineWidth, shadowBlur, …) must reach NSH as they are;
      // running them through `resolvePaint` used to drop every one of them.
      if (name === "fillStyle" || name === "strokeStyle") {
        const pattern = value instanceof PatternRecord;
        if (name === "fillStyle") state.fillPattern = pattern ? value : null;
        else state.strokePattern = pattern ? value : null;
        if (pattern) continue;
        try {
          const resolved = resolvePaint(ctx, value);
          if (resolved !== null) Reflect.set(ctx, name, resolved);
        } catch {
          // A gradient NSH's canvas cannot build.
        }
        continue;
      }

      if (name === "globalAlpha") {
        // A snapshot (group opacity, mask, temporary layer) is drawn as
        // vectors: its own alpha must multiply the destination layer's.
        const alpha = numberArg(value);
        if (Number.isFinite(alpha)) {
          try {
            Reflect.set(ctx, name, clamp(alpha, 0, 1) * state.alphaScale);
          } catch {
            // NSH's canvas does not take this value.
          }
        }
        continue;
      }

      try {
        Reflect.set(ctx, name, value);
      } catch {
        // A value NSH's canvas does not take (an unknown join, a filter).
      }
      continue;
    }

    const name = op[1];
    const args = op.slice(2);
    try {
      switch (name) {
        case "save":
          ctx.save();
          states.push({
            ctm: { ...state.ctm },
            fillPattern: state.fillPattern,
            strokePattern: state.strokePattern,
            alphaScale: state.alphaScale,
          });
          break;
        case "restore": {
          const previous = states.pop();
          if (previous) {
            state.ctm = previous.ctm;
            state.fillPattern = previous.fillPattern;
            state.strokePattern = previous.strokePattern;
            state.alphaScale = previous.alphaScale;
          }
          ctx.restore();
          break;
        }
        case "setTransform": {
          const values = finiteArgs(args);
          if (!values) break;
          const [a, b, c, d, e, f] = values;
          // A snapshot's setTransform is relative to the placement matrix,
          // not an absolute replacement of it.
          state.ctm = multiply(baseCtm, { a, b, c, d, e, f });
          ctx.setTransform(
            state.ctm.a,
            state.ctm.b,
            state.ctm.c,
            state.ctm.d,
            state.ctm.e,
            state.ctm.f,
          );
          break;
        }
        case "resetTransform":
          state.ctm = baseCtm;
          ctx.setTransform(baseCtm.a, baseCtm.b, baseCtm.c, baseCtm.d, baseCtm.e, baseCtm.f);
          break;
        case "transform": {
          const values = finiteArgs(args);
          if (!values) break;
          const [a, b, c, d, e, f] = values;
          state.ctm = multiply(state.ctm, { a, b, c, d, e, f });
          ctx.transform(a, b, c, d, e, f);
          break;
        }
        case "translate": {
          const values = finiteArgs(args);
          if (!values) break;
          const [x, y] = values;
          state.ctm = multiply(state.ctm, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
          ctx.translate(x, y);
          break;
        }
        case "scale": {
          const values = finiteArgs(args);
          if (!values) break;
          const [x, y] = values;
          state.ctm = multiply(state.ctm, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
          ctx.scale(x, y);
          break;
        }
        case "rotate": {
          const values = finiteArgs(args);
          if (!values) break;
          const angle = values[0];
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          state.ctm = multiply(state.ctm, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
          ctx.rotate(angle);
          break;
        }
        case "fill": {
          const rule = ruleArg(args[0]);
          if (state.fillPattern) {
            fillWithPattern(ctx, state.fillPattern, state.ctm, width, height, rule);
          } else if (rule) ctx.fill(rule);
          else ctx.fill();
          break;
        }
        case "fillRect": {
          const values = finiteArgs(args);
          if (!values) break;
          const [x, y, w, h] = values;
          if (state.fillPattern) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            fillWithPattern(ctx, state.fillPattern, state.ctm, width, height);
            ctx.restore();
          } else ctx.fillRect(x, y, w, h);
          break;
        }
        case "stroke":
          if (!state.strokePattern) ctx.stroke();
          break;
        case "strokeRect": {
          const values = finiteArgs(args);
          if (!values) break;
          if (!state.strokePattern) {
            const [x, y, w, h] = values;
            ctx.strokeRect(x, y, w, h);
          }
          break;
        }
        case "fillText": {
          if (!state.fillPattern) {
            const [text, x, y, maxWidth] = [
              String(args[0]),
              numberArg(args[1]),
              numberArg(args[2]),
              args.length > 3 ? numberArg(args[3]) : undefined,
            ];
            ctx.fillText(text, x, y, maxWidth);
          }
          break;
        }
        case "strokeText": {
          if (!state.strokePattern) {
            const text = String(args[0]);
            ctx.strokeText(
              text,
              numberArg(args[1]),
              numberArg(args[2]),
              args.length > 3 ? numberArg(args[3]) : undefined,
            );
          }
          break;
        }
        case "clip": {
          const rule = ruleArg(args[0]);
          if (rule) ctx.clip(rule);
          else ctx.clip();
          break;
        }
        case "drawImage": {
          const image = args[0];
          if (image instanceof SnapshotImage) {
            drawSnapshot(
              ctx,
              image.snapshot,
              args.slice(1).map(numberArg),
              width,
              height,
              state.ctm,
            );
          } else {
            const url = imageSource(image);
            if (url) ctx.drawImage(url, ...args.slice(1).map(numberArg));
          }
          break;
        }
        case "putImageData":
          break;
        default: {
          const fn: unknown = Reflect.get(ctx, name);
          if (typeof fn === "function") Reflect.apply(fn, ctx, args);
        }
      }
    } catch {
      // Skip a call NSH's canvas does not support.
    }
  }
}

/** Style properties replayOps forwards to NSH's context. */
const REPLAY_PROPS = new Set<string>([
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "lineCap",
  "lineJoin",
  "miterLimit",
  "lineDashOffset",
  "globalAlpha",
  "globalCompositeOperation",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "font",
  "fontVariantNumeric",
  "textAlign",
  "textBaseline",
]);
