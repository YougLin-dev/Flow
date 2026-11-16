/**
 * Selection queries for `FlowScene`: normalizing ids against the scene,
 * comparing selections by value, their 1-based stacking ranks and the
 * selected group's world rectangle. The scene class keeps the selection
 * signals and keyed flags; these helpers decide the values.
 */
import type { BoxGeometry } from "../../../shared";
import { CARD_TITLE_BAND } from "../cards/card-layout";

/** Reduces ids to known cards, first occurrence wins. */
export function normalizeSelection(
  ids: readonly string[],
  known: (id: string) => boolean,
): string[] {
  const next: string[] = [];
  for (const id of ids) {
    if (known(id) && !next.includes(id)) next.push(id);
  }
  return next;
}

/** Whether two selections hold the same ids in the same order. */
export function sameSelection(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((id, index) => id === second[index]);
}

/** The 1-based stacking ranks of a selection, in selection order. */
export function selectionRanksOf(selection: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  selection.forEach((id, index) => ranks.set(id, index + 1));
  return ranks;
}

/**
 * The world rectangle around the selected cards, titles included, or null
 * when none is in the scene. The selection frame draws it with the world.
 */
export function selectionBoundsOf(
  selection: readonly string[],
  cardRect: (id: string) => BoxGeometry | null,
): BoxGeometry | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const id of selection) {
    const rect = cardRect(id);
    if (!rect) continue;
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y - CARD_TITLE_BAND);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
