import { expect, test } from "nsh/test";
import type { EdgeSummary } from "@flow/native";
import {
  edgeFlows,
  FLOW_CYCLE_MS,
  FLOW_HEAD_ALPHA,
  FLOW_SEGMENTS,
  FLOW_STEP_MS,
  FLOW_TRAIL,
  type FlowPass,
  flowPass,
  flowWave,
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

test("the wave steps from nothing lit to the tail leaving, then starts over", () => {
  expect(flowWave(0)).toBe(1);
  expect(Math.abs(flowWave(FLOW_CYCLE_MS / 2)) < 1e-9).toBe(true);
  expect(Math.abs(flowWave(FLOW_CYCLE_MS) - 1) < 1e-9).toBe(true);
  // A clock that jumps backwards keeps the phase on the cycle instead of
  // overshooting its start.
  expect(Math.abs(flowWave(-FLOW_CYCLE_MS / 2)) < 1e-9).toBe(true);
  // Within a cycle the wave only moves toward the tail, and a step's jump
  // is a small share of its body, so the light reads as moving rather than
  // jumping.
  let previous = flowWave(0);
  for (let elapsed = FLOW_STEP_MS; elapsed < FLOW_CYCLE_MS; elapsed += FLOW_STEP_MS) {
    const next = flowWave(elapsed);
    expect(next).toBeLessThan(previous);
    expect(previous - next).toBeLessThan(0.1);
    previous = next;
  }
  expect(previous).toBeLessThan(-0.9);
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
