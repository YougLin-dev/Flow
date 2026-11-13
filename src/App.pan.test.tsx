import { expect, test } from "nsh/test";
import { openApp, percentOf, selectedOf } from "./app-test-harness";
import { CONTENT } from "./flow/data";

/** Half the flow's size in world coordinates. */
const HALF_WIDTH = CONTENT.width / 2;
const HALF_HEIGHT = CONTENT.height / 2;

/** How far one arrow press moves the camera, in screen points. */
const ARROW_STEP = 40;

/** Arrow travel that carries a card past the canvas centre at any fit. */
const ARROW_TRAVEL = 320;

type Arrow = "down" | "left" | "right" | "up";

interface ArrowProbe {
  /** How many presses it takes to travel `ARROW_TRAVEL`. */
  presses: number;
  /** A box-select drag that only finds empty canvas after the arrow's pan. */
  drag: { x: number; y: number };
}

/**
 * The presses and box-select for an arrow test: after the flow has moved
 * `ARROW_TRAVEL` points the arrow's way, the box covers the strip it would
 * have entered had the arrow moved it the other way (or not moved it at all).
 */
const arrowProbe = (scale: number, arrow: Arrow): ArrowProbe => {
  const presses = Math.ceil((ARROW_TRAVEL * scale) / ARROW_STEP);
  const travel = presses * ARROW_STEP;
  if (arrow === "up" || arrow === "down") {
    const reach = travel - HALF_HEIGHT * scale + 20;
    return { presses, drag: { x: -HALF_WIDTH * scale, y: arrow === "down" ? reach : -reach } };
  }
  const reach = travel - HALF_WIDTH * scale + 20;
  return { presses, drag: { x: arrow === "right" ? reach : -reach, y: -HALF_HEIGHT * scale } };
};

/** Presses `arrow` and proves the flow moved the arrow's way. */
const expectArrowPan = async (arrow: Arrow): Promise<void> => {
  const app = await openApp();
  await app.waitUntil(() => percentOf(app) > 0);
  const probe = arrowProbe(percentOf(app) / 100, arrow);

  // Each press is its own keydown/keyup, so they are sent one at a time.
  const pressRepeatedly = async (remaining: number): Promise<void> => {
    if (remaining === 0) return;
    await app.keyboard.press(arrow);
    await pressRepeatedly(remaining - 1);
  };
  await pressRepeatedly(probe.presses);
  await app.drag("id:flow-canvas", probe.drag);

  // Empty canvas here means the flow moved the arrow's way; had it moved the
  // other way (or not moved), the box would have hit a card.
  expect(selectedOf(app)).toBe(0);
};

test("pans right with the right arrow", async () => {
  await expectArrowPan("right");
});

test("pans left with the left arrow", async () => {
  await expectArrowPan("left");
});

test("pans up with the up arrow", async () => {
  await expectArrowPan("up");
});

test("pans down with the down arrow", async () => {
  await expectArrowPan("down");
});
