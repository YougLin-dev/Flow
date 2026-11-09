/**
 * World-space layout of a card's chrome, shared by the views and the
 * selection frame. The title and status sit above the card body; a frame
 * around selected cards includes that band so it does not cut through them.
 */

/** The title row above a card, in world points. */
export const CARD_TITLE_HEIGHT = 20;
export const CARD_TITLE_GAP = 6;
/** From the top of the title row to the top of the card body. */
export const CARD_TITLE_BAND = CARD_TITLE_HEIGHT + CARD_TITLE_GAP;
