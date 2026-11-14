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
/** The inset of a card's content inside its border, in world points. Shared
 * by the body text and the in-place editor that replaces it. */
export const CARD_BODY_INSET = 16;
/** A card body's type: its font size and line height in world points. The
 * in-place editor scales both with the camera to keep the text in place. */
export const CARD_BODY_FONT_SIZE = 13;
export const CARD_BODY_LINE_HEIGHT = 19;
