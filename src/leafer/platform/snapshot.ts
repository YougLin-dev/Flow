import type { Op } from "./op";
import { isRecord } from "./values";

/** The operations an offscreen canvas held when it was drawn. */
export interface CanvasSnapshot {
  width: number;
  height: number;
  ops: Op[];
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
