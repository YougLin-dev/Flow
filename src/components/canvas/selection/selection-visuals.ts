/**
 * The selection recipe both selection surfaces draw: a neutral outline around
 * the swept or selected region and a faint foreground wash that marks what it
 * covers. Keeping the classes in one place stops the marquee box and the
 * multi-card frame from drifting apart.
 */

/** The one-point selection outline, painted over the cards. */
export const SELECTION_OUTLINE = "absolute border border-selection";

/** The wash that marks the region a selection covers. */
export const SELECTION_WASH = "absolute left-0 top-0 h-full w-full bg-foreground opacity-5";
