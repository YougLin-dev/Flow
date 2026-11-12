/**
 * A marquee sweep previews the selection it will write: the covered cards
 * take the zIndex ranks their selection will have, so the preview and the
 * settled state share one stacking.
 */
import { expect, test } from "nsh/test";
import type { NodeSummary, SceneSnapshot } from "@flow/native";
import { FlowScene } from "./scene";

function node(id: string, x: number, y: number, z = 0): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: id,
    x,
    y,
    width: 200,
    height: 84,
    z,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
  };
}

function snapshot(nodes: NodeSummary[]): SceneSnapshot {
  return { rev: 1, nodes, edges: [] };
}

test("raises marquee-previewed cards in sweep order", () => {
  const scene = new FlowScene();
  // a's document z puts it above b while neither is selected.
  scene.apply(snapshot([node("a", 0, 0, 5), node("b", 50, 40)]));
  expect(scene.cardZ("b")).toBeLessThan(scene.cardZ("a"));

  // The preview ranks lift the covered cards just as the release's selection
  // will, in the order the box swept them.
  expect(scene.cardZ("b", 1)).toBeGreaterThan(scene.cardZ("a"));
  expect(scene.cardZ("a", 2)).toBeGreaterThan(scene.cardZ("b", 1));
});
