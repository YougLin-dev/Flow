/**
 * The page root's pointer input: what the composer, its dock and the other
 * page views receive, since they sit above the canvas overlay and the canvas
 * never sees it.
 */
import { platform, type ContextMenuEvent, type MouseEvent, type WheelEvent } from "nsh";
import { wheelNotches, wheelZoomFactor } from "./camera";
import type { ContextMenuPoint } from "./context-menu";

/** The menu controller's page-chrome entry points; a fake stands in for tests. */
export interface ChromeMenu {
  pressChrome(at: ContextMenuPoint): void;
  moveChrome(at: ContextMenuPoint, held: boolean): void;
  release(): void;
}

/** The page root's handlers; the canvas overlay and the minimap keep their own. */
export interface PageChromeHandlers {
  readonly onContextMenu: (event: ContextMenuEvent) => void;
  readonly onMouseMove: (event: MouseEvent) => void;
  readonly onMouseUp: () => void;
  readonly onWheel: (event: WheelEvent) => void;
}

/**
 * A view whose own wheel must not reach the page: a multiline field, which
 * scrolls itself natively, or an open menu. A listener around such a view
 * only observes the wheel — NSH still calls it while the field scrolls — so
 * the page root would zoom the canvas at the same time. The view listens
 * itself instead, which is how NSH decides a wheel's owner, and this handler
 * deliberately does nothing.
 */
export const keepsWheel = (): void => undefined;

/**
 * Forwards input over the page's own views: a secondary drag pans the canvas
 * and a still press opens no menu; the wheel zooms about the pointer. NSH
 * gives the wheel to the nearest listener, so a scrollable view under the
 * pointer still keeps its own scroll.
 */
export function pageChromeHandlers(
  menu: ChromeMenu,
  zoom: (factor: number, x: number, y: number) => void,
): PageChromeHandlers {
  return {
    onContextMenu: (event) => menu.pressChrome(event.position),
    onMouseMove: (event) => menu.moveChrome(event.position, event.pressedButton !== null),
    onMouseUp: () => menu.release(),
    onWheel: (event) => {
      const notches = wheelNotches(event.delta.y, event.deltaMode, platform.os);
      if (notches !== 0) zoom(wheelZoomFactor(notches), event.position.x, event.position.y);
    },
  };
}
