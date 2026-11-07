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
import nodeIcon from "../assets/node@2x.png";
import { EDGES, NODE_HEIGHT, NODE_WIDTH, NODES, type FlowAccent } from "./data";

export interface FlowScene {
  /** The group the camera moves; Leafer culls what it leaves outside. */
  readonly world: Group;
  /** Re-reads the theme tokens and repaints the scene (light/dark changes). */
  readonly recolor: () => void;
}

/**
 * Adds the flow to `app`'s scene layer and returns the camera's group.
 *
 * The colors come from theme tokens: the canvas is app content, so it follows
 * the same design system as the native views around it. `recolor` applies
 * them again when the system's appearance changes, because Leafer nodes do
 * not read token classes the way NSH views do.
 */
export function buildScene(app: LeaferApp): FlowScene {
  const colors = () => ({
    card: token("card"),
    border: token("border"),
    title: token("foreground"),
    muted: token("muted-foreground"),
    edge: token("border"),
    shadow: token("flow-shadow"),
  });
  const initial = colors();

  const world = new Group({ x: 0, y: 0, scale: 1 });
  app.tree.add(world);

  const cards: {
    box: Box;
    stripe: Rect;
    title: LeaferText;
    subtitle: LeaferText;
    accent: FlowAccent;
  }[] = [];

  const boxes: Box[] = NODES.map((spec) => {
    const accent = token(spec.accent);
    const box = new Box({
      x: spec.x,
      y: spec.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      cornerRadius: 16,
      fill: initial.card,
      stroke: initial.border,
      strokeWidth: 1,
      shadow: { x: 0, y: 10, blur: 26, color: initial.shadow },
      draggable: true,
      editable: true,
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
      width: NODE_WIDTH - 84,
      text: spec.title,
      fontSize: 15,
      fontWeight: 600,
      fill: initial.title,
      hittable: false,
    });
    const subtitle = new LeaferText({
      x: 32,
      y: 42,
      width: NODE_WIDTH - 48,
      text: spec.subtitle,
      fontSize: 12,
      fill: initial.muted,
      hittable: false,
    });

    box.add(stripe);
    box.add(title);
    box.add(
      new LeaferImage({
        x: NODE_WIDTH - 44,
        y: 18,
        width: 22,
        height: 22,
        url: nodeIcon.url,
        hittable: false,
      }),
    );
    box.add(subtitle);

    world.add(box);
    cards.push({ box, stripe, title, subtitle, accent: spec.accent });
    return box;
  });

  // A group with opacity takes Leafer's offscreen compositing path; it also
  // keeps the connectors a little quieter than the cards.
  const edges = new Group({ opacity: 0.9 });
  world.add(edges);
  const connectors: { line: Line; arrow: Polygon }[] = [];

  for (const [fromIndex, toIndex] of EDGES) {
    const from = boxes[fromIndex];
    const to = boxes[toIndex];

    const line = new Line({
      points: [0, 0, 0, 0],
      stroke: initial.edge,
      strokeWidth: 1.5,
      strokeCap: "round",
      hittable: false,
    });
    const arrow = new Polygon({
      points: [0, 0, -10, -5, -10, 5],
      fill: initial.edge,
      hittable: false,
    });
    edges.add(line);
    edges.add(arrow);
    connectors.push({ line, arrow });

    const update = (): void => {
      const a = from.getBounds("box", world);
      const b = to.getBounds("box", world);
      const acx = a.x + a.width / 2;
      const acy = a.y + a.height / 2;
      const bcx = b.x + b.width / 2;
      const bcy = b.y + b.height / 2;

      let x1: number;
      let y1: number;
      let x2: number;
      let y2: number;
      if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
        // Left to right (or right to left): leave from a side.
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
      } else {
        // Above to below (or below to above): leave from the top or bottom.
        if (bcy >= acy) {
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
      }

      line.points = [x1, y1, x2, y2];
      arrow.x = x2;
      arrow.y = y2;
      arrow.rotation = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    };

    // Fires while cards are dragged and when the editor moves or resizes them.
    from.on(PropertyEvent.CHANGE, update);
    to.on(PropertyEvent.CHANGE, update);
    update();
  }

  const recolor = (): void => {
    const next = colors();
    for (const card of cards) {
      const accent = token(card.accent);
      card.box.fill = next.card;
      card.box.stroke = next.border;
      card.box.shadow = { x: 0, y: 10, blur: 26, color: next.shadow };
      card.box.hoverStyle = { stroke: accent, strokeWidth: 1.5 };
      card.stripe.fill = accent;
      card.title.fill = next.title;
      card.subtitle.fill = next.muted;
    }
    for (const { line, arrow } of connectors) {
      line.stroke = next.edge;
      arrow.fill = next.edge;
    }
  };

  return { world, recolor };
}
