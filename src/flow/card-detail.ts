/**
 * The detail a card draws at a camera scale. Below the readability of its
 * text the card drops its body and status text and its shadow rather than
 * painting sub-pixel glyphs; below the readability of its shape it drops
 * its title and image previews too. The tiers are named so the view binds
 * on the tier, not on the scale: a continuous zoom wakes the card only on
 * a tier change.
 */

export type CardDetail = "full" | "reduced" | "minimal";

/** Below this scale the card's shadow, body text and status text stop painting. */
export const DETAIL_REDUCED_BELOW = 0.35;
/** Below this scale the title and image previews stop too. */
export const DETAIL_MINIMAL_BELOW = 0.2;

/** The detail tier for `scale`, given the camera's logical scale. */
export function cardDetailAt(scale: number): CardDetail {
  if (!Number.isFinite(scale)) return "full";
  if (scale < DETAIL_MINIMAL_BELOW) return "minimal";
  if (scale < DETAIL_REDUCED_BELOW) return "reduced";
  return "full";
}
