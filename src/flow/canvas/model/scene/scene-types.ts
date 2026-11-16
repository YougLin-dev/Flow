/**
 * The shapes the scene model and its free functions exchange. Keeping them
 * here lets the helpers read a narrow `SceneReader` instead of the
 * `FlowScene` class, which breaks the scene ↔ helper import cycles.
 */
import type { BoxGeometry, EdgeSummary, NodeSummary, Point } from "../../../shared";
import type { PortKind } from "../../../nodes";

/** The URLs a card's image body should show, loaded by the page. */
export interface PreviewView {
  readonly nodeId: string;
  readonly urls: readonly string[];
  readonly count: number;
}

/** A connector being pulled, in world points. */
export interface ConnectionPreview {
  readonly from: Point;
  readonly to: Point;
  readonly portKind: PortKind;
}

/**
 * The scene surface the model's free functions read. `FlowScene` satisfies
 * it implicitly through its public signals and queries.
 */
export interface SceneReader {
  node(id: string): NodeSummary | null;
  nodes(): readonly NodeSummary[];
  edges(): readonly EdgeSummary[];
  selection(): readonly string[];
  cardRect(id: string): BoxGeometry | null;
  cardDepth(id: string): number;
  edgePorts(edge: EdgeSummary): { from: Point; to: Point } | null;
  incomingByPort(): ReadonlyMap<string, number>;
}
