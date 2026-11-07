import { expect, test } from "nsh/test";
import { App } from "@leafer-ui/miniapp";
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
