/**
 * Which offscreen snapshots have to be rasterized instead of replayed as
 * vectors.
 *
 * A plain layer can be replayed straight into the destination: its drawing is
 * the same where it lands. But Canvas compositing only makes sense inside the
 * layer: masks, erasers, blend copies, recorded clears and patterned strokes or
 * text combine with what the layer holds, not with everything already on the
 * destination. Those snapshots become one SVG image drawn once.
 */
import type { Op } from "./op";
import { PatternRecord } from "./paint";
import type { CanvasSnapshot } from "./snapshot";

export function needsRaster(snapshot: CanvasSnapshot, alpha: number, composite: string): boolean {
  // A layer's opacity applies to the composited layer, not to each shape.
  if (alpha !== 1) return true;
  // A blend or Porter-Duff operation applies to the layer as one source.
  if (composite !== "source-over") return true;
  return opsNeedRaster(snapshot.ops);
}

function opsNeedRaster(ops: Op[]): boolean {
  let fillPattern = false;
  let strokePattern = false;
  const saved: { fill: boolean; stroke: boolean }[] = [];
  for (const op of ops) {
    if (op[0] === 0) {
      if (op[1] === "fillStyle") fillPattern = op[2] instanceof PatternRecord;
      else if (op[1] === "strokeStyle") strokePattern = op[2] instanceof PatternRecord;
      // Every composite in the layer combines with the layer, not with the
      // destination it is later drawn onto: nothing here can be replayed
      // straight into the destination.
      else if (op[1] === "globalCompositeOperation" && op[2] !== "source-over") return true;
      continue;
    }
    switch (op[1]) {
      case "save":
        saved.push({ fill: fillPattern, stroke: strokePattern });
        break;
      case "restore": {
        const state = saved.pop();
        if (state) {
          fillPattern = state.fill;
          strokePattern = state.stroke;
        }
        break;
      }
      // NSH emulates pattern fills; strokes and text have no path to clip.
      case "fillText":
        if (fillPattern) return true;
        break;
      case "stroke":
      case "strokeRect":
      case "strokeText":
        if (strokePattern) return true;
        break;
      // A partial clear must only clear what the layer has drawn.
      case "clearRect":
        return true;
      default:
        break;
    }
  }
  return false;
}
