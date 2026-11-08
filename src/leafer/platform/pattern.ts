/**
 * The image a pattern repeats, in the shape both replays need.
 *
 * A pattern's image can be a URL (with Leafer's resized wrapper carrying the
 * padded tile size and the image's own size inside it) or an offscreen canvas
 * snapshot. `width`/`height` are the tile's step; `innerWidth`/`innerHeight`
 * are the picture's own size, so a gap stays transparent instead of stretching
 * the picture over the padding.
 */
import { imageSource } from "./image";
import type { PatternRecord } from "./paint";
import { isSnapshotSource, SnapshotImage, type CanvasSnapshot } from "./snapshot";
import { dimension, isRecord } from "./values";

export interface PatternTile {
  kind: "url" | "snapshot";
  url?: string;
  snapshot?: CanvasSnapshot;
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  /** Canvas' repetition mode; a paint server honours its non-repeating axes. */
  repeat: string;
  opacity?: number;
}

export function patternTile(pattern: PatternRecord): PatternTile | null {
  const image = pattern.image;
  const repeat = pattern.repeat || "repeat";
  // A canvas source is frozen when the pattern is made (a snapshot drawn
  // from it travels in `drawImage` the same way): Leafer recycles the canvas
  // afterwards, which would leave the tile empty.
  if (image instanceof SnapshotImage) {
    const snapshot = image.snapshot;
    if (!snapshot.width || !snapshot.height) return null;
    return {
      kind: "snapshot",
      snapshot,
      width: snapshot.width,
      height: snapshot.height,
      innerWidth: snapshot.width,
      innerHeight: snapshot.height,
      repeat,
    };
  }
  if (isSnapshotSource(image)) {
    const snapshot = image.snapshot();
    const width = dimension(image.width) ?? snapshot.width;
    const height = dimension(image.height) ?? snapshot.height;
    if (!width || !height) return null;
    return {
      kind: "snapshot",
      snapshot,
      width,
      height,
      innerWidth: dimension(snapshot.width) ?? width,
      innerHeight: dimension(snapshot.height) ?? height,
      repeat,
    };
  }
  const url = imageSource(image);
  if (!url) return null;
  const record = isRecord(image) ? image : {};
  const size = isRecord(record.size) ? record.size : {};
  const width = dimension(record.width) ?? dimension(size.width) ?? 1;
  const height = dimension(record.height) ?? dimension(size.height) ?? 1;
  const tile: PatternTile = {
    kind: "url",
    url,
    width,
    height,
    innerWidth: dimension(record.imageWidth) ?? width,
    innerHeight: dimension(record.imageHeight) ?? height,
    repeat,
  };
  if (typeof record.opacity === "number") tile.opacity = record.opacity;
  return tile;
}
