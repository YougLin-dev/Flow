import type { ReplayContext } from "./canvas";

/**
 * Text measurement needs NSH's native context, which only exists while a
 * frame draws. `Platform.canvas` (the offscreen surface Leafer measures
 * through) has no context of its own, so all recording contexts share the
 * frame's context here.
 */
let frameContext: ReplayContext | null = null;

export function setMeasureContext(ctx: ReplayContext | null): void {
  frameContext = ctx;
}

export function measureWithNsh(text: string, font: string): { width: number } | null {
  const ctx = frameContext;
  if (!ctx) return null;
  try {
    const previous = ctx.font;
    ctx.font = font;
    try {
      return ctx.measureText(text);
    } finally {
      ctx.font = previous;
    }
  } catch {
    // NSH's context cannot measure (or cannot restore the font) right now.
    return null;
  }
}
