/**
 * Where a port's hover bubble sits: beside the icon on the side away from the
 * card, unless `placement` names a side. A bubble that would leave the stage
 * flips to the opposite side, then clamps inside the margin.
 */
import type { CameraSize } from "./camera";
import type { Point, PortSide } from "./connection";

/** The side of the port icon a bubble prefers. */
export type TipSide = "left" | "right" | "above" | "below";
/** `auto` puts inputs on the left and outputs on the right. */
export type TipPlacement = TipSide | "auto";

export interface TipBox {
  readonly left: number;
  readonly top: number;
  readonly side: TipSide;
}

export interface TipBoxInput {
  /** The port icon's centre in stage points. */
  readonly center: Point;
  readonly width: number;
  readonly height: number;
  readonly stage: CameraSize;
  readonly portSide: PortSide;
  readonly placement: TipPlacement;
  /** Between the icon and the bubble. */
  readonly gap: number;
  /** The bubble never comes closer than this to the stage edges. */
  readonly margin: number;
}

export function tooltipBox(input: TipBoxInput): TipBox {
  const preferred =
    input.placement === "auto" ? (input.portSide === "in" ? "left" : "right") : input.placement;
  const flipped = opposite(preferred);
  const side = fits(preferred, input) ? preferred : fits(flipped, input) ? flipped : preferred;
  return clamp(position(side, input), input);
}

/** The first-frame pill width estimate for `title` at the bubble's 11px font;
 * the bubble's measured layout replaces it, so the error never shows as
 * padding. */
export function tipWidth(title: string): number {
  let units = 0;
  for (const char of title) {
    units += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 11.5 : 6.4;
  }
  return Math.ceil(Math.min(360, Math.max(46, units + 22)));
}

const OPPOSITE: Record<TipSide, TipSide> = {
  left: "right",
  right: "left",
  above: "below",
  below: "above",
};

function opposite(side: TipSide): TipSide {
  return OPPOSITE[side];
}

function fits(side: TipSide, input: TipBoxInput): boolean {
  const { center, width, height, stage, gap, margin } = input;
  if (side === "left") return center.x - gap - width >= margin;
  if (side === "right") return center.x + gap + width <= stage.width - margin;
  if (side === "above") return center.y - gap - height >= margin;
  return center.y + gap + height <= stage.height - margin;
}

function position(side: TipSide, input: TipBoxInput): TipBox {
  const { center, width, height, gap } = input;
  if (side === "left") return { left: center.x - gap - width, top: center.y - height / 2, side };
  if (side === "right") return { left: center.x + gap, top: center.y - height / 2, side };
  if (side === "above") return { left: center.x - width / 2, top: center.y - gap - height, side };
  return { left: center.x - width / 2, top: center.y + gap, side };
}

function clamp(box: TipBox, input: TipBoxInput): TipBox {
  const { width, height, stage, margin } = input;
  return {
    left: Math.max(margin, Math.min(stage.width - margin - width, box.left)),
    top: Math.max(margin, Math.min(stage.height - margin - height, box.top)),
    side: box.side,
  };
}
