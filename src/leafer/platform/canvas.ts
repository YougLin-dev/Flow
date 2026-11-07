import type { CanvasRenderingContext2D } from "nsh";

/** The NSH context a frame replays onto. */
export type ReplayContext = CanvasRenderingContext2D;

/** A gradient built on that context. */
export type GradientPaint = ReturnType<CanvasRenderingContext2D["createLinearGradient"]>;
