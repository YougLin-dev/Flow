import type { CanvasCamera } from "./camera";
import type { BoxGeometry } from "./connection";

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export interface ComposerAnchor {
  readonly left: number;
  readonly top: number;
}

export interface InlineAnchor {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
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

/** The inline editor's box for `inlineId`, or null when it has no card. */
export function inlinePlacement(
  inlineId: string | null,
  cardRect: (id: string) => BoxGeometry | null,
  camera: CanvasCamera,
  stage: StageSize,
): InlineAnchor | null {
  if (inlineId === null) return null;
  const rect = cardRect(inlineId);
  return rect === null ? null : inlineAnchor(rect, camera, stage);
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

/** The text editor's rect, laid inside a text node's card body. */
export function inlineAnchor(
  rect: BoxGeometry,
  camera: CanvasCamera,
  stage: StageSize,
): InlineAnchor {
  const scale = camera.scale;
  const screen = camera.toScreen(rect.x, rect.y);
  const margin = 8;
  const width = Math.min(
    Math.max(220, rect.width * scale - 24 * scale),
    Math.max(1, stage.width - margin * 2),
  );
  const height = Math.min(
    Math.max(120, rect.height * scale - 64 * scale),
    Math.max(1, stage.height - margin * 2),
  );
  return {
    left: clamp(screen.x + 12 * scale, margin, Math.max(margin, stage.width - width - margin)),
    top: clamp(screen.y + 48 * scale, margin, Math.max(margin, stage.height - height - margin)),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
