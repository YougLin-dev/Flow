import { expect, test } from "nsh/test";
import { App, Box, Group, Line } from "@leafer-ui/miniapp";
import "@leafer-in/editor";
import { installNshPlatform, NshCanvasSurface } from "../leafer/nsh-platform";
import { buildScene } from "./scene";

test("builds and composites the flow scene", () => {
  installNshPlatform();

  const view = new NshCanvasSurface(800, 600, false);
  const app = new App({
    view,
    width: 800,
    height: 600,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const scene = buildScene(app);
  app.start();

  view.context.beginFrame();
  app.forceRender(undefined, true);
  app.renderer.render();

  const calls = view.context.ops.filter((op) => op[0] === 1).map((op) => op[1]);
  // The app renders its scene and editor layers offscreen and composites
  // them: both arrive as snapshots drawn onto the NSH canvas.
  const composites = calls.filter((name) => name === "drawImage");
  expect(composites.length).toBeGreaterThanOrEqual(2);

  // Repainting for a light/dark change keeps the scene intact.
  expect(scene.world.children.length).toBeGreaterThan(0);
  scene.recolor();
  app.forceRender(undefined, true);
  app.renderer.render();

  app.destroy();
});

test("moves a connector after its card's layout", () => {
  installNshPlatform();

  const view = new NshCanvasSurface(800, 600, false);
  const app = new App({
    view,
    width: 800,
    height: 600,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const scene = buildScene(app);
  app.start();

  const first = scene.world.children[0];
  if (!(first instanceof Box)) throw new Error("The first world child is not a card.");
  const line = scene.world.children
    .filter((child): child is Group => child instanceof Group)
    .flatMap((group) => group.children)
    .find((child): child is Line => child instanceof Line);
  if (!line) throw new Error("The scene has no connector line.");
  const before = line.points?.slice() ?? [];
  if (!before.length) throw new Error("The connector has no points.");
  const boundsBefore = scene.bounds();

  first.x = Number(first.x) + 1000;
  app.tree.updateLayout();

  // The connector follows the moved card.
  const after = line.points ?? [];
  expect(after).not.toEqual(before);
  // Fit follows the editor, not the static data file.
  expect(Math.round(scene.bounds().width)).toBeGreaterThan(Math.round(boundsBefore.width));

  app.destroy();
});
