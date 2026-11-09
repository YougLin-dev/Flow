/**
 * The scene model behind the native canvas: the nodes and edges the document
 * reports for the viewport, the user's selection, transient drag geometry and
 * the image previews the page loaded. It owns no views; the canvas components
 * read its signals and the page drives its commands.
 */
import { signal } from "nsh";
import type { EdgeSummary, NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import {
  type BoxGeometry,
  distanceToConnection,
  EDGE_HIT_DISTANCE,
  type Point,
  type PortSide,
  portPoint,
  portZone,
} from "./connection";

/** The URLs a card's image body should show, loaded by the page. */
export interface PreviewView {
  readonly nodeId: string;
  readonly urls: readonly string[];
  readonly count: number;
}

export interface ConnectionPreview {
  readonly from: Point;
  readonly to: Point;
}

export class FlowScene {
  /** The cards on the canvas, in creation order. */
  readonly nodes = signal<readonly NodeSummary[]>([]);
  readonly edges = signal<readonly EdgeSummary[]>([]);
  readonly previews = signal<ReadonlyMap<string, PreviewView>>(new Map());
  /** Geometry being dragged or resized, ahead of the document. */
  readonly overrides = signal<ReadonlyMap<string, BoxGeometry>>(new Map());
  /** The document ids of the selected cards. */
  readonly selection = signal<readonly string[]>([]);
  readonly selectedEdge = signal<string | null>(null);
  readonly connectionPreview = signal<ConnectionPreview | null>(null);
  /** The card a pulled connector is snapped to, highlighted like hover. */
  readonly connectionTarget = signal<string | null>(null);

  private readonly byId = new Map<string, NodeSummary>();
  private readonly edgeById = new Map<string, EdgeSummary>();
  private readonly applied = new Map<string, BoxGeometry>();

  /** Reconciles the scene with one viewport snapshot. */
  apply(snapshot: SceneSnapshot, options: { maxCards?: number } = {}): void {
    const maxCards = options.maxCards ?? Number.POSITIVE_INFINITY;
    const nodes =
      snapshot.nodes.length > maxCards ? snapshot.nodes.slice(0, maxCards) : snapshot.nodes;
    const seen = new Set(nodes.map((node) => node.id));
    for (const id of this.selection()) seen.add(id);

    for (const node of nodes) {
      this.byId.set(node.id, node);
      this.applied.set(node.id, rectOfNode(node));
    }
    for (const [id] of this.byId) {
      if (seen.has(id)) continue;
      this.byId.delete(id);
      this.applied.delete(id);
      this.dropOverride(id);
    }

    // A selection pinned past the viewport keeps the connectors between its
    // cards even when the snapshot no longer reports them.
    const pinned = new Set(this.selection());
    const keptEdges = [...this.edgeById.values()].filter(
      (edge) => pinned.has(edge.fromId) && pinned.has(edge.toId),
    );
    this.edgeById.clear();
    for (const edge of snapshot.edges) this.edgeById.set(edge.id, edge);
    for (const edge of keptEdges) this.edgeById.set(edge.id, edge);
    this.prune();
  }

  /** Applies a command result without another database read. */
  applyChangeSet(changes: {
    changed: NodeSummary[];
    removed: string[];
    edgesChanged: EdgeSummary[];
    edgesRemoved: string[];
  }): void {
    for (const node of changes.changed) {
      this.byId.set(node.id, node);
      this.applied.set(node.id, rectOfNode(node));
      const override = this.overrides().get(node.id);
      if (override && sameRect(override, rectOfNode(node))) this.dropOverride(node.id);
    }
    for (const id of changes.removed) {
      this.byId.delete(id);
      this.applied.delete(id);
      this.dropOverride(id);
    }
    for (const edge of changes.edgesChanged) this.edgeById.set(edge.id, edge);
    for (const id of changes.edgesRemoved) this.edgeById.delete(id);
    this.prune();
  }

  /** Replaces the image thumbnails the page loaded for visible cards. */
  applyPreviews(previews: readonly PreviewView[]): void {
    const next = new Map<string, PreviewView>();
    for (const preview of previews) {
      if (this.byId.has(preview.nodeId)) next.set(preview.nodeId, preview);
    }
    this.previews.set(next);
  }

  /** The geometry changed by a drag or resize since the last snapshot. */
  commitBounds(): NodeBounds[] {
    const changed: NodeBounds[] = [];
    for (const [id, rect] of this.overrides()) {
      const applied = this.applied.get(id);
      if (!applied) continue;
      if (!sameRect(applied, rect)) changed.push({ id, ...rect });
    }
    return changed;
  }

  /** Drops every transient geometry (a failed commit, or a cancelled drag). */
  clearOverrides(): void {
    if (this.overrides().size === 0) return;
    this.overrides.set(new Map());
  }

  /** Replaces the overrides in one write; the drag controller builds them. */
  setOverrides(next: ReadonlyMap<string, BoxGeometry>): void {
    this.overrides.set(new Map(next));
  }

  selectedIds(): readonly string[] {
    return this.selection();
  }

  /** Replaces the selection, ignoring ids the scene does not have. */
  select(ids: readonly string[]): void {
    const next: string[] = [];
    for (const id of ids) {
      if (this.byId.has(id) && !next.includes(id)) next.push(id);
    }
    // Selecting cards is a different selection than an edge; leaving a stale
    // edge selected would make Delete act on the wrong thing.
    if (next.length > 0 && this.selectedEdge() !== null) this.selectedEdge.set(null);
    const current = this.selection();
    if (next.length === current.length && next.every((id, index) => id === current[index])) return;
    this.selection.set(next);
  }

  toggleSelected(id: string): void {
    const current = this.selection();
    this.select(current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  selectEdge(id: string | null): void {
    if (this.selectedEdge() === id) return;
    this.selectedEdge.set(id);
  }

  /** The world rectangle of a card, including a drag in progress. */
  cardRect(id: string): BoxGeometry | null {
    // Read the nodes signal so a binding that positions a card or connector
    // recomputes when a change set moves it, not only during an override.
    this.nodes();
    const override = this.overrides().get(id);
    if (override) return override;
    const node = this.byId.get(id);
    return node ? rectOfNode(node) : null;
  }

  /** The world point of a card's input or output port. */
  portWorld(id: string, side: PortSide): Point | null {
    const rect = this.cardRect(id);
    return rect ? portPoint(rect, side) : null;
  }

  /**
   * The side zone under a world point, with the plus button's followed
   * position. The topmost card owns the hit: a card under the pointer hides a
   * lower card's plus, just as it hides the card it belongs to.
   */
  portZoneAt(x: number, y: number): { nodeId: string; side: PortSide; point: Point } | null {
    let hit: { nodeId: string; side: PortSide; point: Point; z: number } | null = null;
    for (const node of this.byId.values()) {
      const rect = this.cardRect(node.id);
      if (!rect) continue;
      for (const side of ["out", "in"] as const) {
        const point = portZone(rect, side, x, y);
        if (point !== null && (hit === null || node.z >= hit.z)) {
          hit = { nodeId: node.id, side, point, z: node.z };
        }
      }
    }
    if (hit === null) return null;
    const under = this.nodeAt(x, y);
    if (under !== null && under !== hit.nodeId) {
      const underNode = this.byId.get(under);
      if (underNode !== undefined && underNode.z >= hit.z) return null;
    }
    return { nodeId: hit.nodeId, side: hit.side, point: hit.point };
  }

  /** The kind of a card in the scene. */
  kindOf(id: string): string | null {
    return this.byId.get(id)?.kind ?? null;
  }

  /** The topmost card under a world point. */
  nodeAt(x: number, y: number): string | null {
    let hit: { id: string; z: number } | null = null;
    for (const node of this.byId.values()) {
      const rect = this.cardRect(node.id);
      if (!rect) continue;
      const inside =
        x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
      if (inside && (hit === null || node.z >= hit.z)) hit = { id: node.id, z: node.z };
    }
    return hit?.id ?? null;
  }

  /** The connector near a world point, if any. */
  edgeAt(x: number, y: number): string | null {
    let nearest: { id: string; distance: number } | null = null;
    for (const edge of this.edgeById.values()) {
      const from = this.portWorld(edge.fromId, "out");
      const to = this.portWorld(edge.toId, "in");
      if (!from || !to) continue;
      const distance = distanceToConnection(from, to, { x, y });
      if (distance <= EDGE_HIT_DISTANCE && (!nearest || distance < nearest.distance)) {
        nearest = { id: edge.id, distance };
      }
    }
    return nearest?.id ?? null;
  }

  /** One connector's current endpoints. */
  edgeEndpoints(id: string): { fromId: string; toId: string } | null {
    const edge = this.edgeById.get(id);
    return edge ? { fromId: edge.fromId, toId: edge.toId } : null;
  }

  /** Draws the temporary connector while the user drags from a port. */
  setConnectionPreview(from: Point | null, to: Point | null): void {
    if (!from || !to) {
      if (this.connectionPreview() !== null) this.connectionPreview.set(null);
      return;
    }
    this.connectionPreview.set({ from, to });
  }

  /** Highlights the card a pulled connector would land on. */
  setConnectionTarget(id: string | null): void {
    if (this.connectionTarget() === id) return;
    this.connectionTarget.set(id);
  }

  /** Image cards with a current batch, for the page's preview reads. */
  previewTargets(): { id: string; batchId: string }[] {
    const targets: { id: string; batchId: string }[] = [];
    for (const node of this.byId.values()) {
      if (node.kind === "image" && node.outputBatchId) {
        targets.push({ id: node.id, batchId: node.outputBatchId });
      }
    }
    return targets;
  }

  /** The number of cards currently in the scene. */
  cardCount(): number {
    return this.byId.size;
  }

  /** The number of connectors currently drawn (both endpoints present). */
  edgeCount(): number {
    return this.edgeById.size;
  }

  private prune(): void {
    for (const [id, edge] of this.edgeById) {
      if (!this.byId.has(edge.fromId) || !this.byId.has(edge.toId)) this.edgeById.delete(id);
    }
    const selected = this.selectedEdge();
    if (selected !== null && !this.edgeById.has(selected)) this.selectedEdge.set(null);
    const target = this.connectionTarget();
    if (target !== null && !this.byId.has(target)) this.connectionTarget.set(null);
    const keep = new Set(this.selection().filter((id) => this.byId.has(id)));
    if (keep.size !== this.selection().length) this.selection.set([...keep]);
    for (const id of this.overrides().keys()) {
      if (!this.byId.has(id)) this.dropOverride(id);
    }
    this.nodes.set([...this.byId.values()]);
    this.edges.set([...this.edgeById.values()]);
  }

  private dropOverride(id: string): void {
    const current = this.overrides();
    if (!current.has(id)) return;
    const next = new Map(current);
    next.delete(id);
    this.overrides.set(next);
  }
}

function rectOfNode(node: NodeSummary): BoxGeometry {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function sameRect(a: BoxGeometry, b: BoxGeometry): boolean {
  return (
    Math.abs(a.x - b.x) <= 0.01 &&
    Math.abs(a.y - b.y) <= 0.01 &&
    Math.abs(a.width - b.width) <= 0.01 &&
    Math.abs(a.height - b.height) <= 0.01
  );
}
