import { type App, expect, open, test } from "nsh/test";
import { openProjectStore } from "./flow/projects";
import { closeProjectWindow, projectWindowIds, waitForProjectWindow } from "./test-support/windows";

/**
 * Startup reads `flow.settings.v1` and `flow.session.v1` from Storage: the
 * default shows Projects, `lastProject` reopens the project a clean run
 * closed, and a run that ended uncleanly offers to continue instead.
 */

function testRoot(name: string): string {
  return `.nsh/projects-startup-${name}`;
}

async function resetRoot(root: string): Promise<void> {
  const store = await openProjectStore(root);
  const projects = await store.listProjects();
  await Promise.all(projects.map((project) => store.deleteProject(project.projectId)));
}

function openApp(root: string, storage?: Record<string, string>): Promise<App> {
  return open("./App.tsx", {
    platform: "macos",
    host: { params: { projectsRoot: root, flowZoomProbe: 1 } },
    ...(storage === undefined ? {} : { storage }),
  });
}

/** Opens `title`, closes it cleanly, and returns the storage it left. */
async function cleanSession(root: string, title: string): Promise<Record<string, string>> {
  const store = await openProjectStore(root);
  await store.createProject(title, null);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows(`text:${title}`));
  await app.press(`text:${title}`);
  await waitForProjectWindow(app);
  await closeProjectWindow(app);
  await app.waitUntil(() => app.shows(`text:${title}`));
  const entries = app.storage();
  const session: unknown = JSON.parse(entries["flow.session.v1"] ?? "null");
  expect(session).toMatchObject({ title, clean: true });
  return entries;
}

function withStartupLastProject(entries: Record<string, string>): Record<string, string> {
  return { ...entries, "flow.settings.v1": JSON.stringify({ startup: "lastProject" }) };
}

test("opens the last project when the last run closed cleanly", async () => {
  const root = testRoot("last");
  await resetRoot(root);
  const entries = await cleanSession(root, "Last one");

  const app = await openApp(root, withStartupLastProject(entries));
  await app.waitUntil(() => projectWindowIds(app).length === 1);
  expect(app.shows("id:projects-page")).toBe(false);
  await app.waitUntil(() => app.shows("id:flow-canvas"));
  await closeProjectWindow(app);
});

test("an unclean run offers to continue instead of opening on its own", async () => {
  const root = testRoot("recover");
  await resetRoot(root);
  const entries = await cleanSession(root, "Recover me");
  const session: unknown = JSON.parse(entries["flow.session.v1"] ?? "null");
  const unclean = withStartupLastProject({
    ...entries,
    "flow.session.v1": JSON.stringify({ ...(session as object), clean: false }),
  });

  const app = await openApp(root, unclean);
  await app.waitUntil(() => app.shows("id:project-recovery"));
  expect(projectWindowIds(app)).toEqual([]);
  await app.press("id:recovery-continue");
  await waitForProjectWindow(app);
  await app.waitUntil(() => !app.shows("id:projects-page"));
  await closeProjectWindow(app);
});

test("quitting from the recovery card keeps the run unclean", async () => {
  const root = testRoot("recover-quit");
  await resetRoot(root);
  const entries = await cleanSession(root, "Still broken");
  const session: unknown = JSON.parse(entries["flow.session.v1"] ?? "null");
  const unclean = withStartupLastProject({
    ...entries,
    "flow.session.v1": JSON.stringify({ ...(session as object), clean: false }),
  });

  const app = await openApp(root, unclean);
  await app.waitUntil(() => app.shows("id:project-recovery"));
  await app.quitRequest();
  await app.waitUntil(() => app.quit());
  const saved: unknown = JSON.parse(app.storage()["flow.session.v1"] ?? "null");
  expect(saved).toMatchObject({
    projectId: (session as { projectId: string }).projectId,
    clean: false,
  });
});

test("a missing last project falls back to Projects with the reason", async () => {
  const root = testRoot("missing");
  await resetRoot(root);
  const entries = await cleanSession(root, "Gone");
  const store = await openProjectStore(root);
  const projects = await store.listProjects();
  await Promise.all(projects.map((project) => store.deleteProject(project.projectId)));

  const app = await openApp(root, withStartupLastProject(entries));
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.waitUntil(() => app.shows("id:project-action-error"));
  expect(projectWindowIds(app)).toEqual([]);
  expect(app.texts().some((text) => text.includes("no longer in the projects folder"))).toBe(true);
});

test("a last project held elsewhere falls back with the reason", async () => {
  const root = testRoot("locked");
  await resetRoot(root);
  const entries = await cleanSession(root, "Busy");
  const store = await openProjectStore(root);
  const [project] = await store.listProjects();
  if (project === undefined) throw new Error("the session's project is gone");
  const lease = await store.openProject(project.projectId);

  try {
    const app = await openApp(root, withStartupLastProject(entries));
    await app.waitUntil(() => app.shows("id:projects-page"));
    await app.waitUntil(() => app.shows("id:project-action-error"));
    expect(projectWindowIds(app)).toEqual([]);
    expect(app.texts().some((text) => text.includes("open in another Flow window"))).toBe(true);
  } finally {
    lease.release();
  }
});
