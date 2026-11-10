/**
 * The scene model behind the native canvas: the nodes and edges the document
 * reports for the viewport, the user's selection, transient drag geometry and
 * the image previews the page loaded. It owns no views; the canvas components
 * read its signals and the page drives its commands.
 */
import { batch, signal, type Signal } from "nsh";
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
import { CARD_TITLE_BAND } from "./card-layout";
import { KeyedFlags } from "./keyed-flags";

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
  private readonly overrideRects = new Map<string, BoxGeometry>();
  /** The overrides read per card: a drag invalidates the cards it moves (and
   * their connectors), not every binding that positions a card. */
  private readonly overrideSignals = new Map<string, Signal<BoxGeometry | undefined>>();
  /** The document ids of the selected cards. */
  readonly selection = signal<readonly string[]>([]);
  readonly selectedEdge = signal<string | null>(null);
  /** The temporary connectors while one or more ends are dragged. */
  readonly connectionPreviews = signal<readonly ConnectionPreview[] | null>(null);
  /** The card a pulled connector is snapped to, highlighted like hover. */
  readonly connectionTarget = signal<string | null>(null);

  private readonly byId = new Map<string, NodeSummary>();
  private readonly edgeById = new Map<string, EdgeSummary>();
  private readonly applied = new Map<string, BoxGeometry>();
  private readonly selectedFlags = new KeyedFlags();
  private readonly targetFlags = new KeyedFlags();
  /** The selection the ranks were built from, and its 1-based ranks. */
  private ranksFor: readonly string[] | null = null;
  private readonly ranks = new Map<string, number>();
  /** A stacking base above every card's own z; selected cards start here. */
  private baseZ = 1;

  /** Reconciles the scene with one viewport snapshot. */
  apply(snapshot: SceneSnapshot, options: { maxCards?: number } = {}): void {
    // Readers must never see new nodes with old edges.
    batch(() => {
      const maxCards = options.maxCards ?? Number.POSITIVE_INFINITY;
      const nodes =
        snapshot.nodes.length > maxCards ? snapshot.nodes.slice(0, maxCards) : snapshot.nodes;
      const seen = new Set(nodes.map((node) => node.id));
      for (const id of this.selection()) seen.add(id);

      for (const node of nodes) {
        this.byId.set(node.id, node);
        this.setApplied(node);
      }
      for (const [id] of this.byId) {
        if (seen.has(id)) continue;
        this.byId.delete(id);
        this.applied.delete(id);
        this.dropOverride(id);
      }

      // A selected card is pinned past the viewport, so keep its connectors
      // even when the snapshot no longer reports them: the edge carries the
      // far port, and the pinned card supplies the near one. A mid-drag read
      // sees only committed geometry, which may lie outside its rect.
      const pinned = new Set(this.selection());
      const keptEdges = [...this.edgeById.values()].filter(
        (edge) => pinned.has(edge.fromId) || pinned.has(edge.toId),
      );
      this.edgeById.clear();
      for (const edge of snapshot.edges) this.edgeById.set(edge.id, edge);
      for (const edge of keptEdges) this.edgeById.set(edge.id, edge);
      this.prune();
    });
  }

  /** Applies a command result without another database read. */
  applyChangeSet(changes: {
    changed: NodeSummary[];
    removed: string[];
    edgesChanged: EdgeSummary[];
    edgesRemoved: string[];
  }): void {
    // The cards, connectors and resolved overrides are one command result.
    batch(() => {
      for (const node of changes.changed) {
        this.byId.set(node.id, node);
        this.setApplied(node);
        const override = this.overrideRects.get(node.id);
        if (override && sameRect(override, rectOfNode(node))) this.dropOverride(node.id);
      }
      for (const id of changes.removed) {
        this.byId.delete(id);
        this.applied.delete(id);
        this.dropOverride(id);
      }
      for (const edge of changes.edgesChanged) {
        // A command's edge carries no far anchors; keep the ones the viewport
        // read resolved for it, so a reconnect does not blank the connector.
        const previous = this.edgeById.get(edge.id);
        this.edgeById.set(
          edge.id,
          previous === undefined
            ? edge
            : {
                ...edge,
                fromPoint: edge.fromPoint ?? previous.fromPoint ?? null,
                toPoint: edge.toPoint ?? previous.toPoint ?? null,
              },
        );
      }
      for (const id of changes.edgesRemoved) this.edgeById.delete(id);
      this.prune();
    });
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
    for (const [id, rect] of this.overrideRects) {
      const applied = this.applied.get(id);
      if (!applied) continue;
      if (!sameRect(applied, rect)) changed.push({ id, ...rect });
    }
    return changed;
  }

  /** The transient geometry being dragged or resized, ahead of the document. */
  overrides(): ReadonlyMap<string, BoxGeometry> {
    return this.overrideRects;
  }

  /** Drops every transient geometry (a failed commit, or a cancelled drag). */
  clearOverrides(): void {
    if (this.overrideRects.size === 0) return;
    // Every card is restored together, so the connector layer re-records once.
    batch(() => {
      this.overrideRects.clear();
      for (const override of this.overrideSignals.values()) override.set(undefined);
    });
  }

  /** Replaces the overrides in one write; the drag controller builds them. */
  setOverrides(next: ReadonlyMap<string, BoxGeometry>): void {
    // One gesture step's geometry is one state; per-card signals define
    // notification granularity, not update rounds.
    batch(() => {
      const ids = new Set([...this.overrideRects.keys(), ...next.keys()]);
      this.overrideRects.clear();
      for (const [id, rect] of next) this.overrideRects.set(id, rect);
      // Only the cards whose geometry changed hear of it; the cards reading
      // their own rect stay untouched, which keeps a drag's re-render to what
      // it moves.
      for (const id of ids) this.overrideSignals.get(id)?.set(next.get(id));
    });
  }

  selectedIds(): readonly string[] {
    return this.selection();
  }

  /** Replaces the selection, ignoring ids the scene does not have. */
  select(ids: readonly string[]): void {
    // The card selection and cleared edge selection are one selection state.
    batch(() => {
      const next: string[] = [];
      for (const id of ids) {
        if (this.byId.has(id) && !next.includes(id)) next.push(id);
      }
      // Selecting cards is a different selection than an edge; leaving a stale
      // edge selected would make Delete act on the wrong thing.
      if (next.length > 0 && this.selectedEdge() !== null) this.selectedEdge.set(null);
      const current = this.selection();
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        this.selectedFlags.set(next);
        return;
      }
      this.selection.set(next);
      this.selectedFlags.set(next);
    });
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
    const override = this.overrideSignal(id)();
    if (override) return override;
    return this.applied.get(id) ?? null;
  }

  /** `id`'s override as a signal of its own, so a drag's write reaches only
   * the cards it moves. */
  private overrideSignal(id: string): Signal<BoxGeometry | undefined> {
    let override = this.overrideSignals.get(id);
    if (!override) {
      override = signal<BoxGeometry | undefined>(this.overrideRects.get(id));
      this.overrideSignals.set(id, override);
    }
    return override;
  }

  /** Keeps `id`'s applied rect the same object while it does not move, so a
   * viewport read does not invalidate every card's geometry bindings. */
  private setApplied(node: NodeSummary): void {
    const rect = rectOfNode(node);
    const previous = this.applied.get(node.id);
    this.applied.set(node.id, previous && sameRect(previous, rect) ? previous : rect);
  }

  /**
   * A card's stacking depth: selected cards sit above every unselected one,
   * in the order they joined the selection. Hit tests use the same depth, so
   * the card that draws on top is also the card that takes the press.
   */
  cardDepth(id: string): number {
    const rank = this.selectionRanks().get(id);
    if (rank !== undefined) return this.baseZ + rank;
    return this.byId.get(id)?.z ?? 0;
  }

  /** The zIndex a card draws at; the selected group is above everything. */
  cardZ(id: string): number {
    // Track snapshot replacement and selection changes.
    this.nodes();
    return this.cardDepth(id) + 1;
  }

  /** Whether `id` is in the current selection (ranks-map lookup, O(1)). */
  isSelected(id: string): boolean {
    return this.selectionRanks().has(id);
  }

  /** Whether `id` is selected, waking only when this card's flag flips. */
  isSelectedKeyed(id: string): boolean {
    return this.selectedFlags.has(id);
  }

  /** Whether `id` is the connection target of this card alone. */
  isConnectionTarget(id: string): boolean {
    return this.targetFlags.has(id);
  }

  /** Between unselected cards and the elevated selection: the frame. */
  frameZ(): number {
    this.nodes();
    return this.baseZ + 1;
  }

  /** Above every card, including an elevated selection: a pulled connector. */
  previewZ(): number {
    this.nodes();
    return this.baseZ + this.selectionRanks().size + 3;
  }

  /** Above the elevated selection and its frame: the merged plus buttons. */
  framePlusZ(): number {
    this.nodes();
    return this.baseZ + this.selectionRanks().size + 2;
  }

  /**
   * The world rectangle around the selected cards, titles included, or null
   * when none are selected. The selection frame draws it with the world.
   */
  selectionBounds(): BoxGeometry | null {
    this.nodes();
    const ids = this.selection();
    if (ids.length === 0) return null;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const rect = this.cardRect(id);
      if (!rect) continue;
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y - CARD_TITLE_BAND);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /**
   * The selection ranks, rebuilt when the selection's signal value changes.
   * A depth read always matches the selection the app is showing, even when
   * a binding runs in the middle of the selection write.
   */
  private selectionRanks(): ReadonlyMap<string, number> {
    const selection = this.selection();
    if (selection !== this.ranksFor) {
      this.ranksFor = selection;
      this.ranks.clear();
      selection.forEach((id, index) => this.ranks.set(id, index + 1));
    }
    return this.ranks;
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
      const depth = this.cardDepth(node.id);
      for (const side of ["out", "in"] as const) {
        const point = portZone(rect, side, x, y);
        if (point !== null && (hit === null || depth >= hit.z)) {
          hit = { nodeId: node.id, side, point, z: depth };
        }
      }
    }
    if (hit === null) return null;
    const under = this.nodeAt(x, y);
    if (under !== null && under !== hit.nodeId) {
      if (this.cardDepth(under) >= hit.z) return null;
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
      if (!inside) continue;
      const depth = this.cardDepth(node.id);
      if (hit === null || depth >= hit.z) hit = { id: node.id, z: depth };
    }
    return hit?.id ?? null;
  }

  /** The connector near a world point, if any. */
  edgeAt(x: number, y: number): string | null {
    let nearest: { id: string; distance: number } | null = null;
    for (const edge of this.edgeById.values()) {
      const ports = this.edgePorts(edge);
      if (!ports) continue;
      const distance = distanceToConnection(ports.from, ports.to, { x, y });
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

  /**
   * A connector's endpoints: a live card's port when its card is in the
   * scene, else the port the read carried for the card beyond it.
   */
  edgePorts(edge: EdgeSummary): { from: Point; to: Point } | null {
    const from = this.portWorld(edge.fromId, "out") ?? edge.fromPoint;
    const to = this.portWorld(edge.toId, "in") ?? edge.toPoint;
    return from && to ? { from, to } : null;
  }

  /** The first preview line, for the single-connector gesture. */
  connectionPreview(): ConnectionPreview | null {
    return this.connectionPreviews()?.[0] ?? null;
  }

  /** Draws the temporary connectors while one or more ends are dragged. */
  setConnectionPreviews(previews: readonly ConnectionPreview[] | null): void {
    if (!previews || previews.length === 0) {
      if (this.connectionPreviews() !== null) this.connectionPreviews.set(null);
      return;
    }
    const current = this.connectionPreviews();
    if (current !== null && samePreviews(current, previews)) return;
    this.connectionPreviews.set(previews);
  }

  /** Draws one temporary connector while a single end is dragged. */
  setConnectionPreview(from: Point | null, to: Point | null): void {
    if (!from || !to) {
      this.setConnectionPreviews(null);
      return;
    }
    this.setConnectionPreviews([{ from, to }]);
  }

  /** Whether a connector from `fromId` to `toId` is already in the scene. */
  hasEdge(fromId: string, toId: string): boolean {
    for (const edge of this.edgeById.values()) {
      if (edge.fromId === fromId && edge.toId === toId) return true;
    }
    return false;
  }

  /** Highlights the card a pulled connector would land on. */
  setConnectionTarget(id: string | null): void {
    if (this.connectionTarget() === id) return;
    this.connectionTarget.set(id);
    this.targetFlags.set(id === null ? [] : [id]);
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
      // The read carries both ports for every connector it reports, including
      // one whose curve crosses the viewport while both of its cards are
      // outside the read. Without either port there is nothing to draw.
      if (this.edgePorts(edge) === null) this.edgeById.delete(id);
    }
    const selected = this.selectedEdge();
    if (selected !== null && !this.edgeById.has(selected)) this.selectedEdge.set(null);
    const target = this.connectionTarget();
    if (target !== null && !this.byId.has(target)) this.setConnectionTarget(null);
    const keep = new Set(this.selection().filter((id) => this.byId.has(id)));
    if (keep.size !== this.selection().length) this.select([...keep]);
    // The elevation base follows the highest document z in the scene.
    let maxZ = 0;
    for (const node of this.byId.values()) if (node.z > maxZ) maxZ = node.z;
    this.baseZ = maxZ + 1;
    for (const id of this.overrideRects.keys()) {
      if (!this.byId.has(id)) this.dropOverride(id);
    }
    this.nodes.set([...this.byId.values()]);
    this.edges.set([...this.edgeById.values()]);
    const live = new Set(this.byId.keys());
    this.selectedFlags.retain(live);
    this.targetFlags.retain(live);
  }

  private dropOverride(id: string): void {
    if (!this.overrideRects.delete(id)) return;
    this.overrideSignals.get(id)?.set(undefined);
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

function samePreviews(a: readonly ConnectionPreview[], b: readonly ConnectionPreview[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const first = a[index];
    const second = b[index];
    if (!first || !second) return false;
    if (
      first.from.x !== second.from.x ||
      first.from.y !== second.from.y ||
      first.to.x !== second.to.x ||
      first.to.y !== second.to.y
    ) {
      return false;
    }
  }
  return true;
}
