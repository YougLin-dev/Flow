import { expect, test } from "nsh/test";
import { App, Group, Rect, RenderEvent } from "@leafer-ui/miniapp";
import "@leafer-in/editor";
import { refreshEditBox } from "./editor-box";
import { installNshPlatform, NshCanvasSurface, pointerData } from "./nsh-platform";

function appWithRect(): { app: App; view: NshCanvasSurface; rect: Rect } {
  installNshPlatform();
  const view = new NshCanvasSurface(400, 300, false);
  const app = new App({
    view,
    width: 400,
    height: 300,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const rect = new Rect({
    x: 50,
    y: 50,
    width: 100,
    height: 60,
    fill: "#ff5a5f",
    draggable: true,
    editable: true,
  });
  app.tree.add(rect);
  app.start();
  return { app, view, rect };
}

function interactionOf(app: App): NonNullable<App["interaction"]> {
  const interaction = app.interaction;
  if (!interaction) throw new Error("Leafer created no interaction.");
  return interaction;
}

function surfaceOf(canvas: { view: unknown }): NshCanvasSurface {
  const view = canvas.view;
  if (!(view instanceof NshCanvasSurface)) throw new Error("Expected an NSH canvas.");
  return view;
}

test("selects an element on press", () => {
  const { app, rect } = appWithRect();
  const interaction = interactionOf(app);

  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));

  expect(app.editor.editing).toBe(true);
  expect(app.editor.list.length).toBe(1);
  expect(app.editor.list[0] === rect).toBe(true);

  app.destroy();
});

test("adds and removes elements with Shift", async () => {
  const { app, rect } = appWithRect();
  const other = new Rect({
    x: 250,
    y: 180,
    width: 80,
    height: 50,
    fill: "#336699",
    editable: true,
  });
  app.tree.add(other);
  const interaction = interactionOf(app);

  // Leafer counts presses this close together as a double click.
  const apart = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));
  expect(app.editor.list.length).toBe(1);
  await apart();

  interaction.pointerMove(pointerData(290, 205, { shiftKey: true }));
  interaction.pointerDown(pointerData(290, 205, { shiftKey: true }));
  interaction.pointerUp(pointerData(290, 205, { shiftKey: true }));
  await apart();

  expect(app.editor.list.length).toBe(2);
  expect(app.editor.list.includes(rect)).toBe(true);
  expect(app.editor.list.includes(other)).toBe(true);

  // Shift-clicking a selected element takes it out again.
  interaction.pointerMove(pointerData(290, 205, { shiftKey: true }));
  interaction.pointerDown(pointerData(290, 205, { shiftKey: true }));
  interaction.pointerUp(pointerData(290, 205, { shiftKey: true }));
  await apart();

  expect(app.editor.list.length).toBe(1);
  expect(app.editor.list[0] === rect).toBe(true);

  app.destroy();
});

test("moves a selected element by dragging it", () => {
  const { app, rect } = appWithRect();
  const interaction = interactionOf(app);

  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));

  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerMove(pointerData(120, 90));
  interaction.pointerMove(pointerData(140, 100));
  interaction.pointerUp(pointerData(140, 100));

  expect(Math.round(Number(rect.x))).toBe(90);
  expect(Math.round(Number(rect.y))).toBe(70);

  app.destroy();
});

test("keeps the edit box on the element while it moves", () => {
  const { app, rect } = appWithRect();
  const interaction = interactionOf(app);

  // select, then drag the element
  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerMove(pointerData(140, 100));
  interaction.pointerMove(pointerData(180, 120));
  interaction.pointerUp(pointerData(180, 120));

  // one frame the way LeaferView draws it: the app announces the children's
  // render, so the editor updates its box before the sky draws.
  app.emit(RenderEvent.CHILD_START, app);
  app.forceRender(undefined, true);
  app.emit(RenderEvent.CHILD_END, app);
  app.renderer.render();

  const box = app.editor.editBox.rect.getBounds("box", app.sky);
  expect(Math.round(box.x)).toBe(Math.round(Number(rect.x)));
  expect(Math.round(box.y)).toBe(Math.round(Number(rect.y)));

  app.destroy();
});

test("keeps the edit box on an element when its parent group moves", () => {
  installNshPlatform();
  const view = new NshCanvasSurface(400, 300, false);
  const app = new App({
    view,
    width: 400,
    height: 300,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const world = new Group({ x: 0, y: 0 });
  app.tree.add(world);
  const rect = new Rect({
    x: 50,
    y: 50,
    width: 100,
    height: 60,
    fill: "#ff5a5f",
    draggable: true,
    editable: true,
  });
  world.add(rect);
  app.start();

  const interaction = interactionOf(app);
  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));

  const frame = (): void => {
    app.emit(RenderEvent.CHILD_START, app);
    app.forceRender(undefined, true);
    app.emit(RenderEvent.CHILD_END, app);
    app.renderer.render();
  };
  frame();
  const before = app.editor.editBox.rect.getBounds("box", app.sky);

  world.x = -100;
  refreshEditBox(app.editor, world);
  const immediate = app.editor.editBox.rect.getBounds("box", app.sky);
  expect(Math.round(immediate.x)).toBe(Math.round(before.x - 100));

  frame();
  const after = app.editor.editBox.rect.getBounds("box", app.sky);

  expect(Math.round(after.x)).toBe(Math.round(before.x - 100));
  app.destroy();
});

test("keeps a multi-selection box on its elements when the parent moves", () => {
  installNshPlatform();
  const view = new NshCanvasSurface(400, 300, false);
  const app = new App({
    view,
    width: 400,
    height: 300,
    pixelRatio: 1,
    start: false,
    usePartRender: false,
    tree: {},
    editor: {},
  });
  const world = new Group({ x: 0, y: 0 });
  app.tree.add(world);
  const first = new Rect({
    x: 40,
    y: 40,
    width: 100,
    height: 60,
    fill: "#ff5a5f",
    draggable: true,
    editable: true,
  });
  const second = new Rect({
    x: 200,
    y: 120,
    width: 80,
    height: 50,
    fill: "#336699",
    draggable: true,
    editable: true,
  });
  world.add(first);
  world.add(second);
  app.start();

  app.editor.select([first, second]);
  refreshEditBox(app.editor, world);
  const before = app.editor.editBox.rect.getBounds("box", app.sky);

  world.x = -100;
  refreshEditBox(app.editor, world);
  const after = app.editor.editBox.rect.getBounds("box", app.sky);

  expect(Math.round(after.x)).toBe(Math.round(before.x - 100));
  app.destroy();
});

test("box selects elements from empty canvas", () => {
  const { app, rect } = appWithRect();
  const interaction = interactionOf(app);

  // Empty-canvas drags become DragEvents; the editor selects what the
  // rectangle covers. It uses the size from the previous drag step, so the
  // drag has to be sampled a few times, like a real pointer.
  interaction.pointerMove(pointerData(350, 260));
  interaction.pointerDown(pointerData(350, 260));
  for (const [x, y] of [
    [300, 220],
    [200, 150],
    [100, 80],
    [40, 40],
    [40, 40],
  ]) {
    interaction.pointerMove(pointerData(x, y));
  }

  // Mid-drag the selection area is a 20% overlay. Leafer expresses that as
  // the context's `globalAlpha`; it must be recorded as a style value, not
  // mistaken for a paint and dropped, or the overlay draws solid.
  const sky = surfaceOf(app.sky.canvas);
  sky.context.beginFrame();
  app.forceRender(undefined, true);
  app.renderer.render();
  expect(
    sky.context.ops.some((op) => op[0] === 0 && op[1] === "globalAlpha" && op[2] === 0.2),
  ).toBe(true);

  interaction.pointerUp(pointerData(40, 40));

  expect(app.editor.editing).toBe(true);
  expect(app.editor.list.some((leaf) => leaf === rect)).toBe(true);

  app.destroy();
});

test("resizes a selected element from a handle", () => {
  const { app, rect } = appWithRect();
  const interaction = interactionOf(app);

  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));
  app.forceRender(undefined, true);
  app.renderer.render();

  const point = app.editor.editBox.resizePoints[0];
  const bounds = point.getBounds("box", app.sky);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;

  interaction.pointerMove(pointerData(cx, cy));
  interaction.pointerDown(pointerData(cx, cy));
  interaction.pointerMove(pointerData(cx - 30, cy - 20));
  interaction.pointerMove(pointerData(cx - 60, cy - 40));
  interaction.pointerUp(pointerData(cx - 60, cy - 40));

  expect(rect.width).toBeGreaterThan(100);
  expect(rect.height).toBeGreaterThan(60);

  app.emit(RenderEvent.CHILD_START, app);
  app.forceRender(undefined, true);
  app.emit(RenderEvent.CHILD_END, app);
  app.renderer.render();

  const box = app.editor.editBox.rect.getBounds("box", app.sky);
  expect(Math.round(box.width)).toBe(Math.round(Number(rect.width)));
  expect(Math.round(box.height)).toBe(Math.round(Number(rect.height)));

  app.destroy();
});

test("resizes the app and its layers", () => {
  const { app, view } = appWithRect();

  app.resize({ width: 640, height: 480, pixelRatio: 1 });

  expect(app.tree.canvas.width).toBe(640);
  expect(app.sky.canvas.width).toBe(640);
  expect(app.sky.canvas.height).toBe(480);

  view.context.beginFrame();
  app.forceRender(undefined, true);
  app.renderer.render();
  expect(view.context.ops.length).toBeGreaterThan(0);

  app.destroy();
});

test("draws the edit box over the scene", () => {
  const { app, view, rect } = appWithRect();
  const interaction = interactionOf(app);

  interaction.pointerMove(pointerData(100, 80));
  interaction.pointerDown(pointerData(100, 80));
  interaction.pointerUp(pointerData(100, 80));

  app.forceRender(undefined, true);
  app.renderer.render();

  const skyCanvas = surfaceOf(app.sky.canvas);
  expect(skyCanvas.context.ops.length).toBeGreaterThan(10);
  expect(view.context.ops.length).toBeGreaterThan(0);
  expect(app.editor.editBox.visible).toBe(true);
  expect(app.editor.getEditSize(rect)).toBe("size");

  app.destroy();
});
