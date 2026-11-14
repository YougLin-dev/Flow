/** Shared scene and menu fixtures for the context-menu and flow-effects tests. */
import type { EdgeSummary, NodeSummary } from "@flow/native";
import { CanvasCamera } from "../../model/camera";
import { CanvasController } from "../canvas-controller";
import { CanvasMenuController } from "../context-menu";
import { FlowScene } from "../../model/scene/scene";

export function node(id: string, x: number, y: number): NodeSummary {
  return {
    id,
    kind: "text",
    title: id,
    body: id,
    x,
    y,
    width: 200,
    height: 84,
    z: 0,
    rev: 1,
    dataJson: "{}",
    settingsJson: "{}",
    status: "idle",
    outputBatchId: null,
  };
}

export function edge(id: string, fromId: string, toId: string): EdgeSummary {
  return {
    id,
    fromId,
    toId,
    fromPort: "text",
    toPort: "prompt",
    portKind: "text",
    fromOffset: 42,
    toOffset: 28,
    kind: "flow",
    dataJson: "{}",
  };
}

export function menuWith(scene = new FlowScene()): {
  menu: CanvasMenuController;
  controller: CanvasController;
  camera: CanvasCamera;
  actions: string[];
} {
  const camera = new CanvasCamera();
  const actions: string[] = [];
  const controller = new CanvasController({
    scene: () => scene,
    camera: () => camera,
    panBy: () => undefined,
    commitBounds: () => undefined,
    selectEdge: () => undefined,
    reconnectEdge: () => undefined,
    connectNodes: () => undefined,
    openInline: () => undefined,
    onCardPress: () => undefined,
  });
  const menu = new CanvasMenuController({
    camera: () => camera,
    controller: () => controller,
    scene: () => scene,
    addNode: (kind) => actions.push(`add:${kind}`),
    copyNode: (id) => actions.push(`copy:${id}`),
    deleteNode: (id) => actions.push(`delete:${id}`),
    editBody: (id) => actions.push(`edit:${id}`),
    selectEdge: (id) => {
      scene.selectEdge(id);
      scene.select([]);
    },
    deleteEdge: (id) => actions.push(`delete-edge:${id}`),
  });
  return { menu, controller, camera, actions };
}

export function sceneWithCard(): FlowScene {
  const scene = new FlowScene();
  scene.apply({ rev: 1, nodes: [node("card", 40, 40)], edges: [] });
  return scene;
}

/** Two text cards joined by one connector; its curve passes (320, 75). */
export function sceneWithEdge(): FlowScene {
  const scene = new FlowScene();
  scene.apply({
    rev: 1,
    nodes: [node("source", 40, 40), node("target", 400, 40)],
    edges: [edge("line", "source", "target")],
  });
  return scene;
}
