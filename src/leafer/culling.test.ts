import { expect, test } from "nsh/test";
import { Group, Leafer, Rect } from "@leafer-ui/miniapp";
import { installNshPlatform, NshCanvasSurface } from "./nsh-platform";

test("culls elements outside the viewport", () => {
  installNshPlatform();
  const view = new NshCanvasSurface(800, 600, false);
  const app = new Leafer({
    view,
    width: 800,
    height: 600,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
  });
  const world = new Group({ x: 0, y: 0, scale: 1 });
  app.add(world);
  for (let i = 0; i < 500; i++) {
    world.add(
      new Rect({
        x: (i % 25) * 1000,
        y: Math.floor(i / 25) * 1000,
        width: 100,
        height: 60,
        fill: i === 0 ? "#ff0000" : "#336699",
      }),
    );
  }
  app.start();
  const ops = view.context.ops.length;
  expect(ops).toBeLessThan(500);

  // Moving the camera far past every node leaves nothing to draw.
  world.x = -100000;
  world.y = -100000;
  view.context.beginFrame();
  app.forceRender(undefined, true);
  expect(view.context.ops.length).toBeLessThan(100);

  app.destroy();
});
