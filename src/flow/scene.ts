/**
 * The scene model behind the native canvas: the nodes and edges the document
 * reports for the viewport, the user's selection, transient drag geometry and
 * the image previews the page loaded. It owns no views; the canvas components
 * read its signals and the page drives its commands.
 */
import { batch, signal, type Signal, untracked } from "nsh";
import type { EdgeSummary, NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import {
  type BoxGeometry,
  connectionBounds,
  distanceToConnection,
  EDGE_HIT_DISTANCE,
  type Point,
  PORT_CENTER_GAP,
  portCenter,
} from "./connection";
import { CARD_TITLE_BAND } from "./card-layout";
import { KeyedFlags } from "./keyed-flags";
import type { PortKind } from "./node-kinds";
import { sameEdge, sameNode, samePreviewMap, samePreviewView } from "./record-equality";
import { edgePortOffsets } from "./scene-ports";
import { containsPoint } from "./selection";

/** The URLs a card's image body should show, loaded by the page. */
export interface PreviewView {
  readonly nodeId: string;
  readonly urls: readonly string[];
  readonly count: number;
}

export interface ConnectionPreview {
  readonly from: Point;
  readonly to: Point;
  readonly portKind: PortKind;
}

export class FlowScene {
  /** The cards on the canvas, in creation order. */
  readonly nodes = signal<readonly NodeSummary[]>([]);
  readonly edges = signal<readonly EdgeSummary[]>([]);
  readonly previews = signal<ReadonlyMap<string, PreviewView>>(new Map());
  /** Geometry being dragged or resized, ahead of the document. */
  private readonly overrideRects = new Map<string, BoxGeometry>();
  /** A card's effective rect as a signal of its own; a reader subscribes to
   * exactly the ids it reads, including ids not in the scene yet (a
   * connector's far endpoint). */
  private readonly rectSignals = new Map<string, Signal<BoxGeometry | null>>();
  /** The document ids of the selected cards. */
  readonly selection = signal<readonly string[]>([]);
  readonly selectedEdge = signal<string | null>(null);
  /** The temporary connectors while one or more ends are dragged. */
  readonly connectionPreviews = signal<readonly ConnectionPreview[] | null>(null);
  /** The card a pulled connector is snapped to, taking the accent border. */
  readonly connectionTarget = signal<string | null>(null);

  private readonly byId = new Map<string, NodeSummary>();
  private readonly edgeById = new Map<string, EdgeSummary>();
  /** The directional pairs the edge map holds, built on the first query. */
  private edgePairs: Set<string> | null = null;
  /** Incoming edges per input port, rebuilt only when the edge list changes. */
  private incomingCache: {
    readonly edges: readonly EdgeSummary[];
    readonly counts: ReadonlyMap<string, number>;
  } | null = null;
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
      const before = this.edgePairs === null ? null : topologyPairs(this.edgeById.values());
      const maxCards = options.maxCards ?? Number.POSITIVE_INFINITY;
      const nodes =
        snapshot.nodes.length > maxCards ? snapshot.nodes.slice(0, maxCards) : snapshot.nodes;
      const seen = new Set(nodes.map((node) => node.id));
      for (const id of this.selection()) seen.add(id);

      for (const node of nodes) {
        const previous = this.byId.get(node.id);
        this.byId.set(
          node.id,
          previous !== undefined && sameNode(previous, node) ? previous : node,
        );
        this.setApplied(node);
      }
      for (const [id] of this.byId) {
        if (seen.has(id)) continue;
        this.byId.delete(id);
        this.applied.delete(id);
        this.dropOverride(id);
        // A connector reading this far endpoint falls back to the edge's
        // anchor; wake it with the card's absence.
        this.setRectSignal(id, null);
      }

      // A selected card is pinned past the viewport, so keep its connectors
      // even when the snapshot no longer reports them: the edge carries the
      // far port, and the pinned card supplies the near one. A mid-drag read
      // sees only committed geometry, which may lie outside its rect.
      const pinned = new Set(this.selection());
      const keptEdges = [...this.edgeById.values()].filter(
        (edge) => pinned.has(edge.fromId) || pinned.has(edge.toId),
      );
      // Keep each record object when its fields did not change, so a binding
      // reading the lists wakes only for a real change.
      const retained = new Map<string, EdgeSummary>();
      for (const edge of snapshot.edges) {
        const previous = this.edgeById.get(edge.id);
        retained.set(edge.id, previous !== undefined && sameEdge(previous, edge) ? previous : edge);
      }
      this.edgeById.clear();
      for (const [id, edge] of retained) this.edgeById.set(id, edge);
      // A pinned card's cached connectors fill in the ones the snapshot no
      // longer reports, but never replace a fresh record: the fresh one may
      // carry corrected far anchors, and re-inserting the stale one would
      // undo that correction.
      for (const edge of keptEdges) {
        if (!this.edgeById.has(edge.id)) this.edgeById.set(edge.id, edge);
      }
      this.prune();
      // Keep the lazy index when the read left its pairs alone; anchors and
      // record identity do not change which pairs are connected.
      if (before !== null && !samePairs(before, topologyPairs(this.edgeById.values()))) {
        this.edgePairs = null;
      }
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
        const previous = this.byId.get(node.id);
        this.byId.set(
          node.id,
          previous !== undefined && sameNode(previous, node) ? previous : node,
        );
        this.setApplied(node);
        const override = this.overrideRects.get(node.id);
        if (override && sameRect(override, rectOfNode(node))) this.dropOverride(node.id);
      }
      for (const id of changes.removed) {
        this.byId.delete(id);
        this.applied.delete(id);
        this.dropOverride(id);
        this.setRectSignal(id, null);
      }
      for (const edge of changes.edgesChanged) {
        // A command's edge carries no far anchors; keep the ones the viewport
        // read resolved for it, so a reconnect does not blank the connector.
        const previous = this.edgeById.get(edge.id);
        if (
          this.edgePairs !== null &&
          (previous === undefined || previous.fromId !== edge.fromId || previous.toId !== edge.toId)
        ) {
          this.edgePairs = null;
        }
        const merged =
          previous === undefined
            ? edge
            : {
                ...edge,
                fromPoint: edge.fromPoint ?? previous.fromPoint ?? null,
                toPoint: edge.toPoint ?? previous.toPoint ?? null,
              };
        this.edgeById.set(
          edge.id,
          previous !== undefined && sameEdge(previous, merged) ? previous : merged,
        );
      }
      for (const id of changes.edgesRemoved) {
        if (this.edgeById.delete(id)) this.edgePairs = null;
      }
      this.prune();
    });
  }

  /** Replaces the image thumbnails the page loaded for visible cards. */
  applyPreviews(previews: readonly PreviewView[]): void {
    const current = untracked(() => this.previews());
    const next = new Map<string, PreviewView>();
    for (const preview of previews) {
      if (!this.byId.has(preview.nodeId)) continue;
      const previous = current.get(preview.nodeId);
      next.set(
        preview.nodeId,
        previous !== undefined && samePreviewView(previous, preview) ? previous : preview,
      );
    }
    // Keep the published map when every entry kept its identity and order, so
    // an unchanged reload wakes no image card.
    if (samePreviewMap(current, next)) return;
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
    const ids = [...this.overrideRects.keys()];
    // Every card is restored together, so the connector layer re-records once.
    batch(() => {
      this.overrideRects.clear();
      for (const id of ids) this.setRectSignal(id, this.applied.get(id) ?? null);
    });
  }

  /** Replaces the overrides in one write; the drag controller builds them. */
  setOverrides(next: ReadonlyMap<string, BoxGeometry>): void {
    // One gesture step's geometry is one state; per-card signals define
    // notification granularity, not update rounds. A drag keeps the same id
    // set every step, so the removed-id pass usually runs empty and no
    // union set is built per pointer move.
    batch(() => {
      for (const id of this.overrideRects.keys()) {
        if (!next.has(id)) this.setRectSignal(id, this.applied.get(id) ?? null);
      }
      this.overrideRects.clear();
      for (const [id, rect] of next) {
        this.overrideRects.set(id, rect);
        this.setRectSignal(id, rect);
      }
    });
  }

  selectedIds(): readonly string[] {
    return this.selection();
  }

  /** How many edges enter each input port, keyed `toId\0toPort`. A frame
   * drag resolves group ports on every move; the count is one map per edge
   * list, not one scan per move. */
  incomingByPort(): ReadonlyMap<string, number> {
    const edges = this.edges();
    if (this.incomingCache !== null && this.incomingCache.edges === edges) {
      return this.incomingCache.counts;
    }
    const counts = new Map<string, number>();
    for (const edge of edges) {
      const key = `${edge.toId}\u0000${edge.toPort}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.incomingCache = { edges, counts };
    return counts;
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
    return this.rectSignal(id)();
  }

  /** A card's effective rect as a signal of its own; a reader subscribes to
   * exactly the ids it reads, including ids not in the scene yet (a
   * connector's far endpoint). */
  private rectSignal(id: string): Signal<BoxGeometry | null> {
    let rect = this.rectSignals.get(id);
    if (!rect) {
      rect = signal<BoxGeometry | null>(this.effectiveRect(id));
      this.rectSignals.set(id, rect);
    }
    return rect;
  }

  /** The rect a card currently has: transient geometry ahead of the document. */
  private effectiveRect(id: string): BoxGeometry | null {
    return this.overrideRects.get(id) ?? this.applied.get(id) ?? null;
  }

  /** Publishes a card's new effective rect when a reader holds its signal;
   * the lazy accessor above starts a new reader from current state. */
  private setRectSignal(id: string, rect: BoxGeometry | null): void {
    const current = this.rectSignals.get(id);
    if (!current || untracked(() => current()) === rect) return;
    current.set(rect);
  }

  /** Keeps `id`'s applied rect the same object while it does not move, so a
   * viewport read does not invalidate every card's geometry bindings. */
  private setApplied(node: NodeSummary): void {
    const rect = rectOfNode(node);
    const previous = this.applied.get(node.id);
    const kept = previous && sameRect(previous, rect) ? previous : rect;
    this.applied.set(node.id, kept);
    // A transient override stays authoritative; dropping it publishes the
    // applied rect then.
    if (kept !== previous && !this.overrideRects.has(node.id)) {
      this.setRectSignal(node.id, kept);
    }
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

  /** The zIndex a card draws at; the selected group is above everything. A
   * marquee passes the card's 1-based preview rank, which raises the cards it
   * covers in sweep order exactly as the selection they become will. */
  cardZ(id: string, previewRank?: number): number {
    // Track snapshot replacement and selection changes.
    this.nodes();
    if (previewRank !== undefined) return this.baseZ + previewRank + 1;
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

  /** Above every selected card: the frame's outline and wash stay on top of
   * the group it frames. */
  frameZ(): number {
    this.nodes();
    return this.baseZ + this.selectionRanks().size + 2;
  }

  /** Above every card and the frame: a pulled connector. */
  previewZ(): number {
    this.nodes();
    return this.baseZ + this.selectionRanks().size + 4;
  }

  /** Above the frame: its group ports stay grabbable through the wash. */
  selectionPortsZ(): number {
    this.nodes();
    return this.baseZ + this.selectionRanks().size + 3;
  }

  /**
   * The world rectangle around the selected cards, titles included, or null
   * when none are selected. The selection frame draws it with the world.
   */
  selectionBounds(): BoxGeometry | null {
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

  /** The kind of a card in the scene. */
  kindOf(id: string): string | null {
    return this.byId.get(id)?.kind ?? null;
  }

  /** One card by id, when the scene holds it. */
  node(id: string): NodeSummary | null {
    return this.byId.get(id) ?? null;
  }

  /** One connector by id, when the scene holds it. */
  edge(id: string): EdgeSummary | null {
    return this.edgeById.get(id) ?? null;
  }

  /**
   * The topmost card under a world point. `withTitle` also accepts the title
   * row above the card, for a menu opened on the card's own chrome.
   */
  nodeAt(x: number, y: number, withTitle = false): string | null {
    let hit: { id: string; z: number } | null = null;
    for (const node of this.byId.values()) {
      const rect = this.cardRect(node.id);
      if (!rect) continue;
      const top = rect.y - (withTitle ? CARD_TITLE_BAND : 0);
      const inside =
        x >= rect.x && x <= rect.x + rect.width && y >= top && y <= rect.y + rect.height;
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

  /** One connector's current endpoints. */
  edgeEndpoints(id: string): { fromId: string; toId: string } | null {
    const edge = this.edgeById.get(id);
    return edge ? { fromId: edge.fromId, toId: edge.toId } : null;
  }

  /**
   * A connector's endpoints: a live card's port icon when its card is in the
   * scene, else the port the read carried for the card beyond it, moved from
   * the card's edge out to where that icon sits. The line therefore touches
   * the port, not the card border, whichever end is visible.
   */
  edgePorts(edge: EdgeSummary): { from: Point; to: Point } | null {
    const fromRect = this.cardRect(edge.fromId);
    const toRect = this.cardRect(edge.toId);
    const offsets = edgePortOffsets(this, edge);
    const from = fromRect
      ? portCenter(fromRect, "out", offsets.from)
      : edge.fromPoint && { x: edge.fromPoint.x + PORT_CENTER_GAP, y: edge.fromPoint.y };
    const to = toRect
      ? portCenter(toRect, "in", offsets.to)
      : edge.toPoint && { x: edge.toPoint.x - PORT_CENTER_GAP, y: edge.toPoint.y };
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
    // This convenience pair has no port type; text is the neutral default.
    this.setConnectionPreviews([{ from, to, portKind: "text" }]);
  }

  /** Whether a connector from `fromId` to `toId` is already in the scene. */
  hasEdge(fromId: string, toId: string): boolean {
    return this.edgePairIndex().has(pairKey(fromId, toId));
  }

  /** The edge map's pairs, built once and invalidated by topology changes. */
  private edgePairIndex(): Set<string> {
    if (this.edgePairs === null) {
      this.edgePairs = topologyPairs(this.edgeById.values());
    }
    return this.edgePairs;
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
      if (this.edgePorts(edge) === null && this.edgeById.delete(id)) this.edgePairs = null;
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
    // Publish only a list that differs from the current one. Record identity
    // is preserved above, so an unchanged read leaves both signals untouched.
    const nextNodes = [...this.byId.values()];
    const currentNodes = untracked(() => this.nodes());
    const nodesChanged =
      nextNodes.length !== currentNodes.length ||
      nextNodes.some((node, index) => node !== currentNodes[index]);
    if (nodesChanged) this.nodes.set(nextNodes);
    const nextEdges = [...this.edgeById.values()];
    const currentEdges = untracked(() => this.edges());
    const edgesChanged =
      nextEdges.length !== currentEdges.length ||
      nextEdges.some((edge, index) => edge !== currentEdges[index]);
    if (edgesChanged) this.edges.set(nextEdges);
    const live = new Set(this.byId.keys());
    this.selectedFlags.retain(live);
    this.targetFlags.retain(live);
  }

  private dropOverride(id: string): void {
    if (!this.overrideRects.delete(id)) return;
    this.setRectSignal(id, this.applied.get(id) ?? null);
  }
}

/** A directional, collision-free key for a connector's pair. */
function pairKey(fromId: string, toId: string): string {
  return `${fromId.length}:${fromId}${toId}`;
}

/** The pairs an edge map currently contains, for cache retention checks. */
function topologyPairs(edges: Iterable<EdgeSummary>): Set<string> {
  const pairs = new Set<string>();
  for (const edge of edges) pairs.add(pairKey(edge.fromId, edge.toId));
  return pairs;
}

function samePairs(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
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
      first.to.y !== second.to.y ||
      first.portKind !== second.portKind
    ) {
      return false;
    }
  }
  return true;
}
