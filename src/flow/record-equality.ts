/**
 * Exact record identity for the scene: a viewport read or a command result
 * that reports identical fields must keep the previous record object, so
 * bindings that read the scene's lists do not re-run for a field-equal read.
 *
 * These comparisons are exact per field. The geometry tolerance stays in
 * `scene.ts`'s `sameRect` (0.01 world units), which decides whether an
 * applied rectangle kept its value; the two precisions are deliberate.
 */
import type { EdgeSummary, NodeSummary } from "@flow/native";
import type { PreviewView } from "./scene";

/**
 * Exhaustive per-field equality; a new NodeSummary field is a compile error
 * at the comparison literal below.
 */
export function sameNode(a: NodeSummary, b: NodeSummary): boolean {
  const comparisons: { [K in keyof NodeSummary]: boolean } = {
    id: a.id === b.id,
    kind: a.kind === b.kind,
    title: a.title === b.title,
    body: a.body === b.body,
    x: a.x === b.x,
    y: a.y === b.y,
    width: a.width === b.width,
    height: a.height === b.height,
    z: a.z === b.z,
    rev: a.rev === b.rev,
    dataJson: a.dataJson === b.dataJson,
    settingsJson: a.settingsJson === b.settingsJson,
    status: a.status === b.status,
    outputBatchId: (a.outputBatchId ?? null) === (b.outputBatchId ?? null),
  };
  return Object.values(comparisons).every(Boolean);
}

/**
 * Exhaustive per-field equality for a connector; a new EdgeSummary field is a
 * compile error at the comparison literal below. An absent optional point and
 * an explicit null describe the same connector.
 */
export function sameEdge(a: EdgeSummary, b: EdgeSummary): boolean {
  const comparisons: { [K in keyof EdgeSummary]: boolean } = {
    id: a.id === b.id,
    fromId: a.fromId === b.fromId,
    toId: a.toId === b.toId,
    kind: a.kind === b.kind,
    dataJson: a.dataJson === b.dataJson,
    fromPort: a.fromPort === b.fromPort,
    toPort: a.toPort === b.toPort,
    portKind: a.portKind === b.portKind,
    fromOffset: a.fromOffset === b.fromOffset,
    toOffset: a.toOffset === b.toOffset,
    fromPoint: samePoint(a.fromPoint ?? null, b.fromPoint ?? null),
    toPoint: samePoint(a.toPoint ?? null, b.toPoint ?? null),
  };
  return Object.values(comparisons).every(Boolean);
}

/**
 * Element-wise preview equality: a reload that returns the same node, count
 * and URLs keeps the previous view object, so image cards do not re-render.
 * Hand-written because the URL list is an array; a new PreviewView field
 * needs a comparison here by hand (the interface is local to `scene.ts`).
 */
export function samePreviewView(a: PreviewView, b: PreviewView): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.count === b.count &&
    a.urls.length === b.urls.length &&
    a.urls.every((url, index) => url === b.urls[index])
  );
}

/**
 * Ordered map identity: same keys in the same order and identical values, so
 * a rebuild that kept every PreviewView object publishes nothing.
 */
export function samePreviewMap(
  a: ReadonlyMap<string, PreviewView>,
  b: ReadonlyMap<string, PreviewView>,
): boolean {
  if (a.size !== b.size) return false;
  const first = [...a];
  const second = [...b];
  for (let index = 0; index < first.length; index += 1) {
    const left = first[index];
    const right = second[index];
    if (!left || !right || left[0] !== right[0] || left[1] !== right[1]) return false;
  }
  return true;
}

interface EdgePointLike {
  readonly x: number;
  readonly y: number;
}

function samePoint(a: EdgePointLike | null, b: EdgePointLike | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y;
}
