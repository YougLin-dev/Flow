import { type App, expect, open, test } from "nsh/test";
import { openProjectStore } from "./flow/projects";
import { percentOf } from "./test-support/app";

/** A fixed real root per test; the test host grants no `fs` capability. */
function testRoot(name: string): string {
  return `.nsh/projects-app-${name}`;
}

/** Starts from an empty root through the store, as the native tests do. */
async function resetRoot(root: string): Promise<void> {
  const store = await openProjectStore(root);
  const projects = await store.listProjects();
  await Promise.all(projects.map((project) => store.deleteProject(project.projectId)));
}

const openApp = (root: string): Promise<App> =>
  open("./App.tsx", {
    host: { params: { projectsRoot: root, flowZoomProbe: 1 } },
  });

test("creates, opens and closes a managed project", async () => {
  const root = testRoot("create");
  await resetRoot(root);
  const app = await openApp(root);

  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.waitUntil(() => app.shows("text:No projects yet"));

  await app.press("id:new-project");
  await app.waitUntil(() => app.shows("id:project-title"));
  await app.type("id:project-title", "First project");
  await app.waitUntil(() => app.value("id:project-title") === "First project");
  await app.press("id:project-create");

  // The canvas opened the created package.
  await app.waitUntil(() => app.shows("id:back-to-projects"));
  await app.waitUntil(() => percentOf(app) > 0);

  // Back closes the document, releases the package, and lists the project.
  await app.press("id:back-to-projects");
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.waitUntil(() => app.shows("text:First project"));
  expect(app.texts()).toContain("Opened just now");

  // Reopening proves the lease was released on the way back; a leaked lease
  // would be answered with "already open in this window".
  await app.press("text:First project");
  await app.waitUntil(() => app.shows("id:back-to-projects"));
  await app.press("id:back-to-projects");
  await app.waitUntil(() => app.shows("id:projects-page"));
});

test("dismissing New project creates nothing", async () => {
  const root = testRoot("cancel");
  await resetRoot(root);
  const app = await openApp(root);

  await app.waitUntil(() => app.shows("text:No projects yet"));
  await app.press("id:new-project");
  await app.waitUntil(() => app.shows("id:project-title"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:project-title"));

  const store = await openProjectStore(root);
  expect(await store.listProjects()).toEqual([]);
});

test("a project held by another window is labelled and does not open", async () => {
  const root = testRoot("held");
  await resetRoot(root);
  const held = await openProjectStore(root);
  const created = await held.createProject("Held", null);
  const lease = await held.openProject(created.projectId);

  try {
    const app = await openApp(root);
    await app.waitUntil(() => app.shows("text:Open in another window"));
    await app.press("text:Held");
    await app.waitUntil(() => app.shows("text:“Held” is open in another window."));
    expect(app.shows("id:projects-page")).toBe(true);
    expect(app.shows("id:back-to-projects")).toBe(false);
  } finally {
    lease.release();
  }

  await held.deleteProject(created.projectId);
});
