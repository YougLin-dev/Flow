import type { CanvasCamera } from "./camera";
import type { BoxGeometry } from "./connection";

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export interface ComposerSize {
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

/**
 * Where the native composer sits, in screen points: under the card when it
 * fits, above it otherwise, then beside it, always clamped to the stage.
 */
export function composerAnchor(
  rect: BoxGeometry,
  camera: CanvasCamera,
  stage: StageSize,
  panel: ComposerSize,
  gap = 10,
  margin = 8,
): ComposerAnchor {
  const screen = camera.toScreen(rect.x, rect.y);
  const width = rect.width * camera.scale;
  const height = rect.height * camera.scale;
  const left = screen.x;
  const right = left + width;
  const top = screen.y;
  const bottom = top + height;
  const fitsBelow = bottom + gap + panel.height <= stage.height - margin;
  const fitsAbove = top - gap - panel.height >= margin;
  const fitsRight = right + gap + panel.width <= stage.width - margin;
  const fitsLeft = left - gap - panel.width >= margin;

  let x = left + width / 2 - panel.width / 2;
  let y = bottom + gap;
  if (!fitsBelow) {
    if (fitsAbove) {
      y = top - gap - panel.height;
    } else if (fitsRight) {
      x = right + gap;
      y = top;
    } else if (fitsLeft) {
      x = left - gap - panel.width;
      y = top;
    } else {
      // Nothing fits (a short window): take the roomiest side so the card
      // stays partly visible beside the panel instead of being covered.
      const rooms = [
        { side: "below", room: stage.height - margin - bottom - gap },
        { side: "above", room: top - gap - margin },
        { side: "right", room: stage.width - margin - right - gap },
        { side: "left", room: left - gap - margin },
      ] as const;
      let best: (typeof rooms)[number] = rooms[0];
      for (const candidate of rooms) {
        if (candidate.room > best.room) best = candidate;
      }
      if (best.side === "above") {
        y = top - gap - panel.height;
      } else if (best.side === "right") {
        x = right + gap;
        y = top;
      } else if (best.side === "left") {
        x = left - gap - panel.width;
        y = top;
      }
    }
  }
  x = Math.min(Math.max(x, margin), Math.max(margin, stage.width - margin - panel.width));
  y = Math.min(Math.max(y, margin), Math.max(margin, stage.height - margin - panel.height));
  return { left: x, top: y };
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
