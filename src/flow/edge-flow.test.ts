import { expect, test } from "nsh/test";
import type { EdgeSummary } from "@flow/native";
import {
  cometRuns,
  cometShown,
  edgeFlows,
  FLOW_HEAD_ALPHA,
  FLOW_SEGMENTS,
  FLOW_TRAIL,
  type FlowPass,
  flowingEdgeCount,
  flowPass,
} from "./edge-flow";

function edge(fromId: string, toId: string): EdgeSummary {
  return {
    id: `${fromId}-${toId}`,
    fromId,
    toId,
    fromPort: null,
    toPort: null,
    kind: "flow",
    dataJson: "{}",
  };
}

/** A pass's value at `wave`, as `interpolate` computes it: linear between
 * the knots, clamped outside them. */
function alphaAt(pass: FlowPass, wave: number): number {
  const { inputRange, outputRange } = pass;
  if (wave <= inputRange[0]) return outputRange[0];
  if (wave >= inputRange[inputRange.length - 1]) return outputRange[outputRange.length - 1];
  for (let index = 1; index < inputRange.length; index += 1) {
    if (wave <= inputRange[index]) {
      const from = inputRange[index - 1];
      const to = inputRange[index];
      const t = (wave - from) / (to - from);
      return outputRange[index - 1] + (outputRange[index] - outputRange[index - 1]) * t;
    }
  }
  return outputRange[outputRange.length - 1];
}

/** The index of the brightest lit piece at `wave`, or -1 when nothing is
 * lit. */
function headAt(wave: number): number {
  let head = -1;
  let best = 0;
  for (let index = 0; index < FLOW_SEGMENTS; index += 1) {
    const alpha = alphaAt(flowPass(index), wave);
    if (alpha > best + 1e-9) {
      best = alpha;
      head = index;
    }
  }
  return head;
}

function litCount(wave: number): number {
  let count = 0;
  for (let index = 0; index < FLOW_SEGMENTS; index += 1) {
    if (alphaAt(flowPass(index), wave) > 0) count += 1;
  }
  return count;
}

test("flows a connector with a selected card at either end", () => {
  const selected = new Set(["a"]);

  // An incoming connector (the selected card is its target) and an outgoing
  // one (its source) both flow.
  expect(edgeFlows(edge("b", "a"), selected)).toBe(true);
  expect(edgeFlows(edge("a", "b"), selected)).toBe(true);
  expect(edgeFlows(edge("b", "c"), selected)).toBe(false);
  expect(edgeFlows(edge("b", "c"), new Set())).toBe(false);
});

test("flows a connector between two selected cards", () => {
  expect(edgeFlows(edge("a", "b"), new Set(["a", "b"]))).toBe(true);
});

test("counts only connectors touching the selection, once each", () => {
  const edges = [edge("a", "b"), edge("c", "a"), edge("a", "d"), edge("c", "d")];
  expect(flowingEdgeCount(edges, new Set())).toBe(0);
  expect(flowingEdgeCount(edges, new Set(["e"]))).toBe(0);
  expect(flowingEdgeCount(edges, new Set(["a"]))).toBe(3);
  expect(flowingEdgeCount([edge("a", "b")], new Set(["a", "b"]))).toBe(1);
  expect(flowingEdgeCount(edges, new Set(["a", "b", "c"]))).toBe(4);
});

test("runs the comet only for flowing connectors with motion allowed", () => {
  expect(cometRuns(0, false)).toBe(false);
  expect(cometRuns(1, true)).toBe(false);
  expect(cometRuns(0, true)).toBe(false);
  expect(cometRuns(1, false)).toBe(true);
});

test("suppresses the comet above the limit during camera or card movement", () => {
  for (const activity of [
    { dragging: true, paused: false },
    { dragging: false, paused: true },
    { dragging: true, paused: true },
  ]) {
    expect(cometShown({ flowing: 5, reducedMotion: false, limit: 4, ...activity })).toBe(false);
    expect(cometShown({ flowing: 4, reducedMotion: false, limit: 4, ...activity })).toBe(true);
  }
  expect(
    cometShown({
      flowing: 5,
      reducedMotion: false,
      dragging: false,
      paused: false,
      limit: 4,
    }),
  ).toBe(true);
  for (const flowing of [0, 1, 4, 5]) {
    expect(
      cometShown({ flowing, reducedMotion: true, dragging: false, paused: false, limit: 4 }),
    ).toBe(false);
  }
});

test("a piece lights when the comet's head reaches it and fades behind it", () => {
  const pass = flowPass(FLOW_SEGMENTS / 2);
  const [tail, head] = pass.inputRange;
  // Dark ahead of the comet, and dark once its trail has left the piece.
  expect(alphaAt(pass, 1)).toBe(0);
  expect(alphaAt(pass, head + 0.01)).toBe(0);
  expect(alphaAt(pass, tail)).toBe(0);
  // The head's alpha where the head is, fading evenly behind it.
  expect(Math.abs(alphaAt(pass, head) - FLOW_HEAD_ALPHA) < 1e-9).toBe(true);
  const middle = alphaAt(pass, (tail + head) / 2);
  expect(middle > 0 && middle < FLOW_HEAD_ALPHA).toBe(true);
});

test("the comet's head sweeps from the source to the target", () => {
  // Nothing is lit at either end of the cycle, so a comet enters and leaves
  // cleanly.
  expect(headAt(1)).toBe(-1);
  expect(headAt(-1)).toBe(-1);
  // As the wave falls, the head only moves toward the target.
  let previous = -1;
  for (let wave = 0.95; wave > -0.95; wave -= 0.05) {
    const head = headAt(wave);
    expect(head >= previous).toBe(true);
    previous = head;
  }
  expect(previous > FLOW_SEGMENTS / 2).toBe(true);
});

test("a step lights only the trail's pieces", () => {
  // The trail's share of the connector bounds how much a step can repaint:
  // a few short pieces, not the whole curve.
  const most = Math.ceil(FLOW_TRAIL * FLOW_SEGMENTS) + 1;
  for (let wave = 0.95; wave > -0.95; wave -= 0.05) {
    expect(litCount(wave) <= most).toBe(true);
  }
});
