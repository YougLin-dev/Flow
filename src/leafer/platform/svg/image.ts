/**
 * `drawImage` in a rasterized snapshot: a nested offscreen canvas becomes a
 * group of its serialized elements, a URL becomes an SVG `<image>`. The
 * destination rectangle is clipped and the source rectangle crops, as Canvas
 * specifies.
 */
import { identity, multiply, type Matrix } from "../geometry";
import { imageSource } from "../image";
import type { PatternTile } from "../pattern";
import { SnapshotImage, type CanvasSnapshot } from "../snapshot";
import { dimension, isRecord, numberArg } from "../values";
import { clipFor } from "./defs";
import { element, matrixTransform, numberText, type SvgElement } from "./nodes";
import { PathCommands } from "./path";
import { boundsUnder, type SvgPaintState, type SvgRect } from "./types";

export function drawImage(state: SvgPaintState, args: unknown[]): void {
  const image = args[0];
  const values = args.slice(1).map(numberArg);
  if (!values.every((value) => Number.isFinite(value))) return;
  if (image instanceof SnapshotImage) {
    drawSnapshot(state, image.snapshot, values);
    return;
  }
  const url = imageSource(image);
  if (url) drawUrlImage(state, image, url, values);
}

function drawSnapshot(state: SvgPaintState, snapshot: CanvasSnapshot, values: number[]): void {
  const placement = placementOf(values, snapshot.width, snapshot.height);
  if (!placement) return;
  const { source, dest } = placement;
  const scaleX = dest.width / source.width;
  const scaleY = dest.height / source.height;
  const offset = {
    a: scaleX,
    b: 0,
    c: 0,
    d: scaleY,
    e: dest.x - source.x * scaleX,
    f: dest.y - source.y * scaleY,
  };
  const transform = state.matrix();
  const childBase = multiply(transform, offset);
  const shape = new PathCommands();
  shape.rect(dest.x, dest.y, dest.width, dest.height, state.ctm);
  const clip = clipFor(state.defs, shape.commands, identity());
  state.place(
    element("g", { "clip-path": clip }, state.snapshotBody(snapshot, childBase)),
    boundsUnder(dest, transform),
    snapshot.grayscale === true,
  );
}

function drawUrlImage(state: SvgPaintState, image: unknown, url: string, values: number[]): void {
  const record = isRecord(image) ? image : {};
  const naturalWidth = dimension(record.width);
  const naturalHeight = dimension(record.height);
  if (!matrixTransform(state.matrix())) return;
  if (values.length < 2) return;
  if (values.length >= 8 && !(naturalWidth && naturalHeight)) return;

  if (naturalWidth && naturalHeight) {
    // The recorded image size lets every form use the same placement
    // matrix as a nested snapshot, including a source crop and a negative
    // destination rectangle (a mirrored image).
    const placement = placementOf(values, naturalWidth, naturalHeight);
    if (!placement) return;
    const { source, dest } = placement;
    const scaleX = dest.width / source.width;
    const scaleY = dest.height / source.height;
    const offset = {
      a: scaleX,
      b: 0,
      c: 0,
      d: scaleY,
      e: dest.x - source.x * scaleX,
      f: dest.y - source.y * scaleY,
    };
    const transform = matrixTransform(multiply(state.matrix(), offset));
    if (!transform) return;
    const attrs: Record<string, string> = {
      transform,
      href: url,
      x: "0",
      y: "0",
      width: numberText(naturalWidth),
      height: numberText(naturalHeight),
      preserveAspectRatio: "none",
    };
    if (state.props.imageSmoothingEnabled === false) attrs["image-rendering"] = "pixelated";
    let clip: string | null = null;
    if (values.length >= 8) {
      const shape = new PathCommands();
      shape.rect(dest.x, dest.y, dest.width, dest.height, state.ctm);
      clip = clipFor(state.defs, shape.commands, identity());
    }
    const imageNode = element("image", attrs);
    const node = clip ? element("g", { "clip-path": clip }, [imageNode]) : imageNode;
    state.place(node, boundsUnder(dest, state.matrix()));
    return;
  }

  if (values.length < 4) {
    // `drawImage(url, dx, dy)`: the image's own size, which SVG knows.
    const transform = matrixTransform(state.matrix());
    if (!transform) return;
    const node = element("image", {
      transform,
      href: url,
      x: numberText(values[0]),
      y: numberText(values[1]),
    });
    state.place(
      node,
      boundsUnder({ x: values[0], y: values[1], width: 1, height: 1 }, state.matrix()),
    );
    return;
  }

  // No recorded size: the destination rectangle is drawn at its own size,
  // mirrored by a negative width or height through the placement matrix.
  const dest = { x: values[0], y: values[1], width: values[2], height: values[3] };
  if (!dest.width || !dest.height) return;
  const x = Math.min(dest.x, dest.x + dest.width);
  const y = Math.min(dest.y, dest.y + dest.height);
  const width = Math.abs(dest.width);
  const height = Math.abs(dest.height);
  const mirror = {
    a: dest.width < 0 ? -1 : 1,
    b: 0,
    c: 0,
    d: dest.height < 0 ? -1 : 1,
    e: dest.width < 0 ? x + width : x,
    f: dest.height < 0 ? y + height : y,
  };
  const transform = matrixTransform(multiply(state.matrix(), mirror));
  if (!transform) return;
  const attrs: Record<string, string> = {
    transform,
    href: url,
    x: "0",
    y: "0",
    width: numberText(width),
    height: numberText(height),
    preserveAspectRatio: "none",
  };
  if (state.props.imageSmoothingEnabled === false) attrs["image-rendering"] = "pixelated";
  state.place(element("image", attrs), boundsUnder({ x, y, width, height }, state.matrix()));
}

/** The image inside a pattern tile, placed by `matrix`. */
export function tileContent(
  state: SvgPaintState,
  tile: PatternTile,
  matrix: Matrix,
): SvgElement | null {
  if (tile.kind === "url" && tile.url) {
    return element("image", {
      x: "0",
      y: "0",
      width: numberText(tile.innerWidth),
      height: numberText(tile.innerHeight),
      preserveAspectRatio: "none",
      href: tile.url,
      ...(state.props.imageSmoothingEnabled === false ? { "image-rendering": "pixelated" } : {}),
    });
  }
  if (tile.snapshot) {
    return element("g", {}, state.snapshotBody(tile.snapshot, matrix));
  }
  return null;
}

export function placementOf(
  values: number[],
  naturalWidth: number,
  naturalHeight: number,
): { source: SvgRect; dest: SvgRect } | null {
  let source: SvgRect = { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  let dest: SvgRect;
  if (values.length >= 8) {
    source = { x: values[0], y: values[1], width: values[2], height: values[3] };
    dest = { x: values[4], y: values[5], width: values[6], height: values[7] };
  } else if (values.length >= 4) {
    dest = { x: values[0], y: values[1], width: values[2], height: values[3] };
  } else if (values.length >= 2) {
    dest = { x: values[0], y: values[1], width: naturalWidth, height: naturalHeight };
  } else {
    return null;
  }
  // Zero has no drawing; a negative side mirrors (Canvas keeps the signed
  // rectangle, and the placement matrix carries the flip).
  if (!source.width || !source.height || !dest.width || !dest.height) return null;
  return { source, dest };
}
