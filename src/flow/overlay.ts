import { CARD_BODY_INSET } from "./card-layout";
import type { CanvasCamera } from "./camera";
import type { BoxGeometry } from "./connection";

/** The in-place text editor's anchor: the body's world size and the camera's
 * scale, so the editor lays out at world type and scales like the card. */
export interface InlineBodyBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export interface ComposerAnchor {
  readonly left: number;
  readonly top: number;
}

export interface ComposerBox extends ComposerAnchor {
  readonly width: number;
}

/**
 * The composer's box for `composerId`, or null while a gesture moves the card
 * (the composer hides then) or when its card is not in the scene.
 */
export function composerPlacement(
  composerId: string | null,
  moving: boolean,
  cardRect: (id: string) => BoxGeometry | null,
  camera: CanvasCamera,
  stage: StageSize,
): ComposerBox | null {
  if (moving || composerId === null) return null;
  const rect = cardRect(composerId);
  if (rect === null) return null;
  const width = Math.min(360, Math.max(280, stage.width - 16));
  const anchor = composerAnchor(rect, camera, width);
  return { left: anchor.left, top: anchor.top, width };
}

/**
 * Where the native composer sits, in screen points: directly under the card,
 * centred on it. The placement depends only on the card, never on the stage,
 * so the panel never flips above or beside a card near the viewport edge and
 * may extend past the window instead.
 */
export function composerAnchor(
  rect: BoxGeometry,
  camera: CanvasCamera,
  panelWidth: number,
  gap = 10,
): ComposerAnchor {
  const screen = camera.toScreen(rect.x, rect.y);
  const width = rect.width * camera.scale;
  const height = rect.height * camera.scale;
  return {
    left: screen.x + width / 2 - panelWidth / 2,
    top: screen.y + height + gap,
  };
}

/**
 * The in-place text editor's anchor: the card body's screen origin, its world
 * size and the camera's scale. The editor lays its text out at world type and
 * the view transform scales it, so its font, wrapping and box are identical
 * to the card's own text at every zoom (scaling a font size instead rounds at
 * fractional zooms and narrows the text column).
 */
export function inlineBodyBox(rect: BoxGeometry, camera: CanvasCamera): InlineBodyBox {
  const origin = camera.toScreen(rect.x + CARD_BODY_INSET, rect.y + CARD_BODY_INSET);
  return {
    left: origin.x,
    top: origin.y,
    width: Math.max(1, rect.width - CARD_BODY_INSET * 2),
    height: Math.max(1, rect.height - CARD_BODY_INSET * 2),
    scale: camera.scale,
  };
}
