/** The dot grid's tile layout in screen space. */
export interface GridLayout {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The tiles needed to cover a stage of `width` × `height`. Placement starts
 * one tile before the camera's wrapped offset, so one extra tile each way is
 * enough at any offset.
 */
export function gridLayout(width: number, height: number, tile: number): GridLayout {
  if (!Number.isFinite(tile) || tile <= 0) return { columns: 1, rows: 1 };
  return { columns: tileCount(width, tile), rows: tileCount(height, tile) };
}

/**
 * The camera offset wrapped into one tile. The grid's moving container starts
 * one tile before it, so its static tiles cover the stage at every camera
 * position without each tile reading the camera.
 */
export function wrappedGridOffset(value: number, tile: number): number {
  if (!Number.isFinite(tile) || tile <= 0) return 0;
  return ((value % tile) + tile) % tile;
}

function tileCount(size: number, tile: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.ceil(size / tile) + 1;
}
