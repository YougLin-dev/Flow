/**
 * A card's rectangle split by what a style needs: its position and its
 * size. A drag writes the whole rectangle on every pointer move; the two
 * memos change as their own fields do, so a pure move only wakes the card's
 * position style and a resize only the styles that depend on its size.
 */
import { type Accessor, computed } from "nsh";
import { CARD_TITLE_BAND, CARD_TITLE_HEIGHT } from "./card-layout";
import { type BoxGeometry, type Point, type PortSide, portButtonPoint } from "./connection";

export interface CardSize {
  readonly width: number;
  readonly height: number;
}

/** A card's chrome in card-local points: the card's root carries its world
 * position, so the chrome's styles never see it. */
export interface CardLayout {
  readonly title: BoxGeometry;
  readonly body: BoxGeometry;
}

/** The chrome of a card `size` big, in card-local points. */
export function cardLocalLayout(size: CardSize): CardLayout {
  return {
    title: { x: 0, y: -CARD_TITLE_BAND, width: size.width, height: CARD_TITLE_HEIGHT },
    body: { x: 0, y: 0, width: size.width, height: size.height },
  };
}

/** The card-local rest position of a side's plus button. */
export function cardPlusPoint(size: CardSize, side: PortSide): Point {
  return portButtonPoint({ x: 0, y: 0, width: size.width, height: size.height }, side);
}

/** `point` in the card's local points, the card's top-left at `origin`. */
export function toCardLocal(point: Point, origin: Point): Point {
  return { x: point.x - origin.x, y: point.y - origin.y };
}

function samePosition(a: Point | null, b: Point | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.x === b.x && a.y === b.y;
}

function sameSize(a: CardSize | null, b: CardSize | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.width === b.width && a.height === b.height;
}

/**
 * A card's rectangle as two accessors: its position notifies only when x or
 * y moves, its size only when width or height does. Both fall back to null
 * when the card has no rectangle.
 */
export class CardGeometry {
  readonly position: Accessor<Point | null>;
  readonly size: Accessor<CardSize | null>;

  constructor(rect: () => BoxGeometry | null) {
    this.position = computed(
      () => {
        const value = rect();
        return value === null ? null : { x: value.x, y: value.y };
      },
      { equals: samePosition },
    );
    this.size = computed(
      () => {
        const value = rect();
        return value === null ? null : { width: value.width, height: value.height };
      },
      { equals: sameSize },
    );
  }
}
