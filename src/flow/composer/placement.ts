import { screenRectOf, type CanvasCamera } from "../canvas";
import type { BoxGeometry, StageSize } from "../shared";

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
  const screen = screenRectOf(camera, rect);
  return {
    left: screen.x + screen.width / 2 - panelWidth / 2,
    top: screen.y + screen.height + gap,
  };
}
