/** Thumbnail cells inside an image card's body. */

export interface PreviewCell {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The gap between preview cells, in card points. */
const GAP = 8;

/**
 * One preview's cell, relative to the card body (not the card): one column
 * for a single image, two columns up to four, and one or two rows. The Rust
 * preview read returns at most four items.
 */
export function previewCell(
  width: number,
  height: number,
  index: number,
  count: number,
): PreviewCell {
  const visible = Math.min(4, Math.max(0, count));
  const columns = visible <= 1 ? 1 : 2;
  const rows = visible <= 2 ? 1 : 2;
  const areaWidth = Math.max(1, width);
  const areaHeight = Math.max(1, height);
  const cellWidth = Math.max(1, (areaWidth - GAP * (columns - 1)) / columns);
  const cellHeight = Math.max(1, (areaHeight - GAP * (rows - 1)) / rows);
  return {
    left: (index % columns) * (cellWidth + GAP),
    top: Math.floor(index / columns) * (cellHeight + GAP),
    width: cellWidth,
    height: cellHeight,
  };
}
