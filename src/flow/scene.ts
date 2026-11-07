import { token } from "nsh";
import type { App as LeaferApp } from "@leafer-ui/miniapp";
import {
  Box,
  Group,
  Image as LeaferImage,
  Line,
  Polygon,
  PropertyEvent,
  Rect,
  Text as LeaferText,
} from "@leafer-ui/miniapp";
import type { IUI } from "@leafer-ui/interface";
import type { EdgeSummary, NodeBounds, NodeSummary, SceneSnapshot } from "@flow/native";
import nodeIcon from "../assets/node@2x.png";
import type { FlowAccent } from "./data";

const ACCENTS: readonly FlowAccent[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

interface Card {
  readonly id: string;
  readonly box: Box;
  readonly stripe: Rect;
  readonly title: LeaferText;
  readonly subtitle: LeaferText;
  readonly image: LeaferImage;
  readonly kind: string;
  accent: FlowAccent;
  applied: { x: number; y: number; width: number; height: number };
}

interface EdgeView {
  readonly id: string;
  fromId: string;
  toId: string;
  readonly line: Line;
  readonly arrow: Polygon;
}

interface Palette {
  card: string;
  border: string;
  title: string;
  muted: string;
  edge: string;
  shadow: string;
}

interface NodeData {
  subtitle: string;
  accent: FlowAccent;
}

/**
 * The Leafer side of the flow: it owns the cards and connectors for the nodes
 * the Rust core reports for the current viewport, and reconciles that set as
 * the camera moves. It never needs the whole document in memory.
 */
export class FlowScene {
  readonly world: Group;

  private readonly app: LeaferApp;
  private readonly edgesLayer: Group;
  private readonly cards = new Map<string, Card>();
  private readonly idByBox = new Map<IUI, string>();
  private readonly edges = new Map<string, EdgeView>();
  private palette: Palette;
  private dirtyEdges = false;

  constructor(app: LeaferApp) {
    this.app = app;
    this.palette = readPalette();
    this.world = new Group({ x: 0, y: 0, scale: 1 });
    // Connectors sit under the cards.
    this.edgesLayer = new Group({ opacity: 0.9 });
    this.world.add(this.edgesLayer);
    app.tree.add(this.world);

    app.tree.on("layout.end", () => this.flushEdges());
    app.on("layout.end", () => this.flushEdges());
  }

  /**
   * Reconciles the scene with one viewport snapshot. `maxCards` is the
   * low-zoom budget: the plan calls for a capped, simplified view rather than
   * building all 100k cards. Selected cards stay even when they fall outside
   * the viewport or the budget, so the editor's box remains valid.
   */
  apply(snapshot: SceneSnapshot, options: { maxCards?: number } = {}): void {
    const maxCards = options.maxCards ?? Number.POSITIVE_INFINITY;
    const nodes =
      snapshot.nodes.length > maxCards ? snapshot.nodes.slice(0, maxCards) : snapshot.nodes;
    const seen = new Set(nodes.map((node) => node.id));
    for (const [id, card] of this.cards) {
      if (this.app.editor.list.includes(card.box)) seen.add(id);
    }

    for (const node of nodes) {
      const card = this.cards.get(node.id);
      if (card) {
        this.updateCard(card, node);
      } else {
        this.createCard(node);
      }
    }

    for (const [id, card] of this.cards) {
      if (seen.has(id)) continue;
      card.box.remove();
      this.idByBox.delete(card.box);
      this.cards.delete(id);
    }

    this.applyEdges(snapshot.edges);
    this.markEdgesDirty();
    this.flushEdges();
  }

  /** Applies a command result without another database read. */
  applyChangeSet(changes: {
    changed: NodeSummary[];
    removed: string[];
    edgesChanged: EdgeSummary[];
    edgesRemoved: string[];
  }): void {
    for (const node of changes.changed) {
      const card = this.cards.get(node.id);
      if (card) this.updateCard(card, node);
    }

    for (const id of changes.removed) {
      const card = this.cards.get(id);
      if (!card) continue;
      if (this.app.editor.list.includes(card.box)) this.app.editor.cancel();
      card.box.remove();
      this.idByBox.delete(card.box);
      this.cards.delete(id);
    }

    for (const edge of changes.edgesChanged) {
      this.upsertEdge(edge);
    }
    for (const id of changes.edgesRemoved) {
      this.removeEdge(id);
    }

    this.markEdgesDirty();
    this.flushEdges();
  }

  /** The geometry changed by the editor since the last applied snapshot. */
  commitBounds(): NodeBounds[] {
    const changed: NodeBounds[] = [];
    for (const card of this.cards.values()) {
      const bounds = card.box.getBounds("box", this.world);
      const next = {
        id: card.id,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      if (
        Math.abs(next.x - card.applied.x) > 0.01 ||
        Math.abs(next.y - card.applied.y) > 0.01 ||
        Math.abs(next.width - card.applied.width) > 0.01 ||
        Math.abs(next.height - card.applied.height) > 0.01
      ) {
        changed.push(next);
      }
    }
    return changed;
  }

  /** The document ids of the cards the editor has selected. */
  selectedIds(): string[] {
    const ids: string[] = [];
    this.app.editor.list.forEach((leaf) => {
      if (!(leaf instanceof Box)) return;
      const id = this.idByBox.get(leaf);
      if (id) ids.push(id);
    });
    return ids;
  }

  card(id: string): Box | null {
    return this.cards.get(id)?.box ?? null;
  }

  /** The number of cards currently in the scene. */
  cardCount(): number {
    return this.cards.size;
  }

  /** The number of connectors currently drawn (both endpoints visible). */
  edgeCount(): number {
    let count = 0;
    for (const edge of this.edges.values()) {
      if (edge.line.visible) count += 1;
    }
    return count;
  }

  /** Re-reads the design tokens after the system appearance changes. */
  recolor(): void {
    this.palette = readPalette();
    for (const card of this.cards.values()) {
      this.styleCard(card);
    }
    for (const edge of this.edges.values()) {
      edge.line.stroke = this.palette.edge;
      edge.arrow.fill = this.palette.edge;
    }
    this.markEdgesDirty();
    this.flushEdges();
  }

  private createCard(node: NodeSummary): void {
    const data = nodeData(node);
    const accent = token(data.accent);

    const box = new Box({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      cornerRadius: 16,
      fill: this.palette.card,
      stroke: this.palette.border,
      strokeWidth: 1,
      shadow: { x: 0, y: 10, blur: 26, color: this.palette.shadow },
      draggable: true,
      editable: true,
      resizeChildren: true,
      hoverStyle: { stroke: accent, strokeWidth: 1.5 },
    });

    const stripe = new Rect({
      x: 16,
      y: 18,
      width: 4,
      height: 48,
      cornerRadius: 2,
      fill: accent,
      hittable: false,
    });
    const title = new LeaferText({
      x: 32,
      y: 16,
      width: Math.max(1, node.width - 84),
      text: node.title,
      fontSize: 15,
      fontWeight: 600,
      fill: this.palette.title,
      hittable: false,
    });
    const subtitle = new LeaferText({
      x: 32,
      y: 42,
      width: Math.max(1, node.width - 48),
      text: data.subtitle,
      fontSize: 12,
      fill: this.palette.muted,
      hittable: false,
    });
    const image = new LeaferImage({
      x: node.width - 44,
      y: 18,
      width: 22,
      height: 22,
      url: nodeIcon.url,
      hittable: false,
    });

    box.add(stripe);
    box.add(title);
    box.add(image);
    box.add(subtitle);
    this.world.add(box);

    const card: Card = {
      id: node.id,
      box,
      stripe,
      title,
      subtitle,
      image,
      kind: node.kind,
      accent: data.accent,
      applied: boundsOf(node),
    };
    this.cards.set(node.id, card);
    this.idByBox.set(box, node.id);
    box.on(PropertyEvent.CHANGE, () => {
      this.markEdgesDirty();
    });
  }

  private updateCard(card: Card, node: NodeSummary): void {
    const data = nodeData(node);
    const geometryChanged =
      card.box.x !== node.x ||
      card.box.y !== node.y ||
      card.box.width !== node.width ||
      card.box.height !== node.height;
    const textChanged = card.title.text !== node.title || card.subtitle.text !== data.subtitle;

    card.box.x = node.x;
    card.box.y = node.y;
    card.box.width = node.width;
    card.box.height = node.height;
    card.applied = boundsOf(node);

    if (textChanged) {
      card.title.text = node.title;
      card.subtitle.text = data.subtitle;
    }
    if (geometryChanged) {
      card.title.width = Math.max(1, node.width - 84);
      card.subtitle.width = Math.max(1, node.width - 48);
      card.image.x = node.width - 44;
    }
    if (card.accent !== data.accent) {
      card.accent = data.accent;
      this.styleCard(card);
    }
  }

  private styleCard(card: Card): void {
    const accent = token(card.accent);
    card.box.fill = this.palette.card;
    card.box.stroke = this.palette.border;
    card.box.shadow = { x: 0, y: 10, blur: 26, color: this.palette.shadow };
    card.box.hoverStyle = { stroke: accent, strokeWidth: 1.5 };
    card.stripe.fill = accent;
    card.title.fill = this.palette.title;
    card.subtitle.fill = this.palette.muted;
  }

  private applyEdges(edges: EdgeSummary[]): void {
    const wanted = new Set(edges.map((edge) => edge.id));
    for (const id of this.edges.keys()) {
      if (!wanted.has(id)) this.removeEdge(id);
    }
    for (const edge of edges) {
      this.upsertEdge(edge);
    }
  }

  private upsertEdge(edge: EdgeSummary): void {
    if (!this.cards.has(edge.fromId) || !this.cards.has(edge.toId)) {
      this.removeEdge(edge.id);
      return;
    }

    let view = this.edges.get(edge.id);
    if (!view) {
      const line = new Line({
        points: [0, 0, 0, 0],
        stroke: this.palette.edge,
        strokeWidth: 1.5,
        strokeCap: "round",
        hittable: false,
      });
      const arrow = new Polygon({
        points: [0, 0, -10, -5, -10, 5],
        fill: this.palette.edge,
        hittable: false,
      });
      this.edgesLayer.add(line);
      this.edgesLayer.add(arrow);
      view = { id: edge.id, fromId: edge.fromId, toId: edge.toId, line, arrow };
      this.edges.set(edge.id, view);
    } else {
      view.fromId = edge.fromId;
      view.toId = edge.toId;
    }

    this.markEdgesDirty();
  }

  private removeEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    edge.line.remove();
    edge.arrow.remove();
    this.edges.delete(id);
  }

  private markEdgesDirty(): void {
    this.dirtyEdges = true;
  }

  private flushEdges(): void {
    // `getBounds` can run a layout, which emits `layout.end` again. Clearing
    // the mark first makes the nested call a no-op.
    if (!this.dirtyEdges) return;
    this.dirtyEdges = false;
    for (const edge of this.edges.values()) this.updateEdge(edge);
  }

  private updateEdge(edge: EdgeView): void {
    const from = this.cards.get(edge.fromId)?.box;
    const to = this.cards.get(edge.toId)?.box;

    if (!from || !to) {
      edge.line.visible = false;
      edge.arrow.visible = false;
      return;
    }

    const a = from.getBounds("box", this.world);
    const b = to.getBounds("box", this.world);
    const acx = a.x + a.width / 2;
    const acy = a.y + a.height / 2;
    const bcx = b.x + b.width / 2;
    const bcy = b.y + b.height / 2;

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
      if (bcx >= acx) {
        x1 = a.x + a.width;
        y1 = acy;
        x2 = b.x;
        y2 = bcy;
      } else {
        x1 = a.x;
        y1 = acy;
        x2 = b.x + b.width;
        y2 = bcy;
      }
    } else if (bcy >= acy) {
      x1 = acx;
      y1 = a.y + a.height;
      x2 = bcx;
      y2 = b.y;
    } else {
      x1 = acx;
      y1 = a.y;
      x2 = bcx;
      y2 = b.y + b.height;
    }

    edge.line.visible = true;
    edge.arrow.visible = true;
    edge.line.points = [x1, y1, x2, y2];
    edge.arrow.x = x2;
    edge.arrow.y = y2;
    edge.arrow.rotation = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  }
}

function readPalette(): Palette {
  return {
    card: token("card"),
    border: token("border"),
    title: token("card-foreground"),
    muted: token("muted-foreground"),
    edge: token("border"),
    shadow: token("flow-shadow"),
  };
}

function boundsOf(node: NodeSummary): Card["applied"] {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function nodeData(node: NodeSummary): NodeData {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(node.dataJson);
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  return {
    subtitle: typeof record.subtitle === "string" ? record.subtitle : "",
    accent: isAccent(record.accent) ? record.accent : "chart-1",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAccent(value: unknown): value is FlowAccent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}
