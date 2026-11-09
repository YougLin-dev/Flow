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

function tileCount(size: number, tile: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.ceil(size / tile) + 1;
}
