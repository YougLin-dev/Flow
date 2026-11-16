/**
 * World-space hit tests over a `SceneReader`: the topmost card under a point
 * and the nearest connector. They are free functions because they read the
 * scene through its public surface; the scene model keeps to reconciling
 * records.
 */
import { containsPoint } from "../../../shared";
import {
  connectionBounds,
  distanceToConnection,
  EDGE_HIT_DISTANCE,
} from "../../geometry/connection";
import { CARD_TITLE_BAND } from "../cards/card-layout";
import type { SceneReader } from "./scene-types";

/** The topmost card under a world point. `withTitle` also accepts the title
 * row above the card, for a menu opened on the card's own chrome. */
export function hitNode(
  scene: SceneReader,
  x: number,
  y: number,
  withTitle = false,
): string | null {
  let hit: { id: string; z: number } | null = null;
  for (const node of scene.nodes()) {
    const rect = scene.cardRect(node.id);
    if (!rect) continue;
    const top = rect.y - (withTitle ? CARD_TITLE_BAND : 0);
    const inside = x >= rect.x && x <= rect.x + rect.width && y >= top && y <= rect.y + rect.height;
    if (!inside) continue;
    const depth = scene.cardDepth(node.id);
    if (hit === null || depth >= hit.z) hit = { id: node.id, z: depth };
  }
  return hit?.id ?? null;
}

/** The connector nearest a world point, if any. */
export function hitEdge(scene: SceneReader, x: number, y: number): string | null {
  let nearest: { id: string; distance: number } | null = null;
  for (const edge of scene.edges()) {
    const ports = scene.edgePorts(edge);
    if (!ports) continue;
    // A cubic and its samples lie inside the control-point box; a point
    // beyond the hit distance of that box cannot reach the curve. The exact
    // sample still decides, and the box comparison stays inclusive.
    const box = connectionBounds(ports.from, ports.to);
    if (!containsPoint(box, x, y, EDGE_HIT_DISTANCE)) continue;
    const distance = distanceToConnection(ports.from, ports.to, { x, y });
    if (distance <= EDGE_HIT_DISTANCE && (!nearest || distance < nearest.distance)) {
      nearest = { id: edge.id, distance };
    }
  }
  return nearest?.id ?? null;
}
