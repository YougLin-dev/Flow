import type { Op } from "./op";
import { isRecord } from "./values";

/** The operations an offscreen canvas held when it was drawn. */
export interface CanvasSnapshot {
  width: number;
  height: number;
  ops: Op[];
  /**
   * Leafer's grayscale mask: the canvas read its own pixels back, replaced
   * each pixel's alpha with its luminance and wrote them back. Replay uses the
   * drawing as a luminance mask.
   */
  grayscale?: boolean;
}

/** A snapshot travelling through the operations as a drawable image. */
export class SnapshotImage {
  readonly snapshot: CanvasSnapshot;

  constructor(snapshot: CanvasSnapshot) {
    this.snapshot = snapshot;
  }
}

/** A canvas whose drawing can be copied before Leafer recycles it. */
export interface SnapshotSource {
  readonly width: number;
  readonly height: number;
  snapshot(): CanvasSnapshot;
}

export function isSnapshotSource(value: unknown): value is SnapshotSource {
  return (
    isRecord(value) &&
    typeof value.snapshot === "function" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

/**
 * A snapshot is a picture, so its save stack must be self-contained: an open
 * `save()` (Leafer snapshots a layer while its own save is still open) would
 * otherwise consume the replay's restore and leave the destination clipped to
 * the snapshot rectangle. A `restore()` without an open save is a no-op.
 */
export function balancedOps(ops: Op[]): Op[] {
  const balanced: Op[] = [];
  let depth = 0;
  for (const op of ops) {
    if (op[0] === 1 && op[1] === "save") {
      depth += 1;
      balanced.push(op);
    } else if (op[0] === 1 && op[1] === "restore") {
      if (depth === 0) continue;
      depth -= 1;
      balanced.push(op);
    } else {
      balanced.push(op);
    }
  }
  while (depth > 0) {
    balanced.push([1, "restore"]);
    depth -= 1;
  }
  return balanced;
}
