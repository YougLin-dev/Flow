import { type App, expect, open, test } from "nsh/test";
import { openProjectStore } from "./flow/projects";
import { percentOf } from "./test-support/app";
import {
  closeProjectWindow,
  closeWindow,
  projectWindowId,
  projectWindowIds,
  waitForProjectWindow,
} from "./test-support/windows";

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

/** Also finds packages written outside that root's catalog (a backup). */
async function resetRootDeep(root: string): Promise<void> {
  const store = await openProjectStore(root);
  const projects = await store.refreshCatalog();
  await Promise.all(projects.map((project) => store.deleteProject(project.projectId)));
}

const openApp = (root: string): Promise<App> =>
  open("./App.tsx", {
    platform: "macos",
    host: { params: { projectsRoot: root, flowZoomProbe: 1 } },
  });

/** Creates a project through the dialog, then returns to the list. */
async function createFromList(app: App, title: string): Promise<void> {
  await app.press("id:new-project");
  await app.waitUntil(() => app.shows("id:project-title"));
  await app.type("id:project-title", title);
  await app.waitUntil(() => app.value("id:project-title") === title);
  await app.press("id:project-submit");
  await waitForProjectWindow(app);
  await closeProjectWindow(app);
  await app.waitUntil(() => app.shows(`text:${title}`));
}

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
  await app.press("id:project-submit");

  // The created package opened in its window, and Projects left the screen.
  await waitForProjectWindow(app);
  await app.waitUntil(() => !app.shows("id:projects-page"));
  await app.waitUntil(() => percentOf(app) > 0);

  // Closing the window releases the package and lists the project again.
  await closeProjectWindow(app);
  await app.waitUntil(() => app.shows("text:First project"));
  expect(app.texts()).toContain("Opened just now");

  // Reopening proves the lease was released on the way back; a leaked lease
  // would be answered with "already open in this window".
  await app.press("text:First project");
  await waitForProjectWindow(app);
  await closeProjectWindow(app);
});

test("renames a project from its row menu", async () => {
  const root = testRoot("rename");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "First");

  await app.press("label:Actions for First");
  await app.waitUntil(() => app.shows("text:Rename…"));
  await app.press("text:Rename…");
  await app.waitUntil(() => app.shows("id:project-rename-title"));
  expect(app.value("id:project-rename-title")).toBe("First");
  await app.clear("id:project-rename-title");
  await app.type("id:project-rename-title", "Renamed");
  await app.press("id:project-rename-submit");
  // The dialog must close before the row can be the only "Renamed" on screen:
  // the input itself holds that text while the dialog is open.
  await app.waitUntil(() => !app.shows("id:project-rename-dialog"));
  await app.waitUntil(() => app.shows("text:Renamed"));
  expect(app.shows("text:First")).toBe(false);
});

test("renames the open project from the canvas", async () => {
  const root = testRoot("open-rename");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Before");

  await app.press("text:Before");
  await waitForProjectWindow(app);
  await app.waitUntil(() => app.shows("id:rename-project"));
  await app.press("id:rename-project");
  await app.waitUntil(() => app.shows("id:project-rename-title"));
  expect(app.value("id:project-rename-title")).toBe("Before");
  await app.clear("id:project-rename-title");
  await app.type("id:project-rename-title", "After");
  await app.press("id:project-rename-submit");
  await app.waitUntil(() => !app.shows("id:project-rename-dialog"));

  await closeProjectWindow(app);
  await app.waitUntil(() => app.shows("text:After"));
  expect(app.shows("text:Before")).toBe(false);

  // The title lives in the database, not only in the list snapshot: the list
  // re-read the changed package by stamp, and reopening prefills the rename
  // dialog with it.
  await app.press("text:After");
  await waitForProjectWindow(app);
  await app.press("id:rename-project");
  await app.waitUntil(() => app.shows("id:project-rename-title"));
  expect(app.value("id:project-rename-title")).toBe("After");
  await app.press("id:project-rename-cancel");
  await app.waitUntil(() => !app.shows("id:project-rename-dialog"));
  await closeProjectWindow(app);
});

test("duplicates a project into a new row and leaves the source", async () => {
  const root = testRoot("duplicate");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Source");

  await app.press("label:Actions for Source");
  await app.waitUntil(() => app.shows("text:Duplicate…"));
  await app.press("text:Duplicate…");
  await app.waitUntil(() => app.shows("id:project-duplicate-title"));
  expect(app.value("id:project-duplicate-title")).toBe("Source copy");
  await app.press("id:project-duplicate-submit");
  await app.waitUntil(() => !app.shows("id:project-duplicate-dialog"));
  await app.waitUntil(() => app.shows("text:Source copy"));
  expect(app.shows("text:Source")).toBe(true);
});

test("deletes a project after confirmation", async () => {
  const root = testRoot("delete");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Doomed");

  await app.press("label:Actions for Doomed");
  await app.waitUntil(() => app.shows("text:Delete…"));
  await app.press("text:Delete…");
  await app.waitUntil(() => app.shows("id:project-delete-dialog"));
  await app.press("id:project-delete-submit");
  await app.waitUntil(() => !app.shows("id:project-delete-dialog"));
  await app.waitUntil(() => !app.shows("text:Doomed"));
  await app.waitUntil(() => app.shows("text:No projects yet"));
});

test("imports an unzipped package folder", async () => {
  const root = testRoot("import");
  await resetRoot(root);
  const sourceRoot = testRoot("import-source");
  await resetRoot(sourceRoot);
  const source = await openProjectStore(sourceRoot);
  const created = await source.createProject("Imported", null);
  const folder = `${sourceRoot}/${created.projectId}`;

  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await app.press("id:import-project");
  await app.waitUntil(() => app.shows("id:project-import-path"));
  await app.type("id:project-import-path", folder);
  await app.press("id:project-import-submit");
  await app.waitUntil(() => !app.shows("id:project-import-dialog"));
  await app.waitUntil(() => app.shows("text:Imported"));
});

test("a failed import explains itself and keeps the dialog", async () => {
  const root = testRoot("import-failure");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));

  await app.press("id:import-project");
  await app.waitUntil(() => app.shows("id:project-import-path"));
  await app.type("id:project-import-path", `${root}/missing-package`);
  await app.press("id:project-import-submit");
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes("Couldn’t import the project.")),
  );
  expect(app.shows("id:project-import-dialog")).toBe(true);
});

test("backs up a project and restores it over a later rename", async () => {
  const root = testRoot("backup");
  // A second managed root gives the test a real folder for the backup that
  // its reset can clear; backups must live outside the project root.
  const backupRoot = testRoot("backup-store");
  // A package-shaped name lets the backup root's deep reset find and delete
  // the folder on the next run; the backup itself carries the source id.
  const backupPath = `${backupRoot}/ffffffffffffffffffffffffffffffff`;
  await resetRoot(root);
  await resetRootDeep(backupRoot);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Before");

  await app.press("label:Actions for Before");
  await app.waitUntil(() => app.shows("text:Back up…"));
  await app.press("text:Back up…");
  await app.waitUntil(() => app.shows("id:project-backup-path"));
  await app.type("id:project-backup-path", backupPath);
  await app.press("id:project-backup-submit");
  await app.waitUntil(() => !app.shows("id:project-backup-dialog"));

  await app.press("label:Actions for Before");
  await app.waitUntil(() => app.shows("text:Rename…"));
  await app.press("text:Rename…");
  await app.waitUntil(() => app.shows("id:project-rename-title"));
  await app.clear("id:project-rename-title");
  await app.type("id:project-rename-title", "After");
  await app.press("id:project-rename-submit");
  await app.waitUntil(() => app.shows("text:After"));

  await app.press("label:Actions for After");
  await app.waitUntil(() => app.shows("text:Restore…"));
  await app.press("text:Restore…");
  await app.waitUntil(() => app.shows("id:project-restore-path"));
  await app.type("id:project-restore-path", backupPath);
  await app.press("id:project-restore-submit");
  await app.waitUntil(() => !app.shows("id:project-restore-dialog"));
  await app.waitUntil(() => app.shows("text:Before"));
  expect(app.shows("text:After")).toBe(false);

  // The restored package still opens and releases its lease: the managed
  // open ran the recovery check the restore requested.
  await app.press("text:Before");
  await waitForProjectWindow(app);
  await closeProjectWindow(app);
});

test("a row menu closes when the list scrolls", async () => {
  const root = testRoot("menu-scroll");
  await resetRoot(root);
  const seed = await openProjectStore(root);
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      seed.createProject(`Project ${String(index).padStart(2, "0")}`, null),
    ),
  );
  // Opening one marks it most recent, so it heads the list.
  const first = created.find((project) => project.title === "Project 00");
  if (!first) throw new Error("the seed did not create Project 00");
  const lease = await seed.openProject(first.projectId);
  lease.release();

  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:Project 00"));
  await app.press("label:Actions for Project 00");
  await app.waitUntil(() => app.shows("text:Rename…"));
  await app.scroll("id:project-list", 200);
  await app.waitUntil(() => !app.shows("text:Rename…"));
  await app.scroll("id:project-list", -200);
  await app.waitUntil(() => app.shows("text:Project 00"));
  // The page's open flag was cleared by the scroll, so the row's menu does
  // not reappear when it comes back into view.
  expect(app.shows("text:Rename…")).toBe(false);
});

test("New Project opens the create dialog from the app shortcut", async () => {
  const root = testRoot("new-shortcut");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.keyboard.press("mod+n");
  await app.waitUntil(() => app.shows("id:project-title"));
  expect(app.value("id:project-title")).toBe("");
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

test("quitting saves every project window and records the run clean", async () => {
  const root = testRoot("quit");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Alpha");
  await createFromList(app, "Beta");

  await app.press("text:Alpha");
  await waitForProjectWindow(app);
  await app.keyboard.press("mod+shift+o");
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.press("text:Beta");
  await app.waitUntil(() => projectWindowIds(app).length === 2);

  // The request path saves and closes every window before the app quits.
  await app.quitRequest();
  await app.waitUntil(() => app.quit());
  const session: unknown = JSON.parse(app.storage()["flow.session.v1"] ?? "null");
  expect(session).toMatchObject({ title: "Beta", clean: true });
});

test("the window menu opens from a project window on Windows", async () => {
  const root = testRoot("window-menu");
  await resetRoot(root);
  const app = await open("./App.tsx", {
    platform: "windows",
    host: { params: { projectsRoot: root, flowZoomProbe: 1 } },
  });
  await app.waitUntil(() => app.shows("id:projects-page"));
  await createFromList(app, "Menu");
  await app.press("text:Menu");
  await waitForProjectWindow(app);

  // The popup is owned by the focused project window on Windows; it is
  // still the app's menu, with the shell's items.
  await app.press("id:window-menu");
  await app.waitUntil(() => app.menu() !== null);
  const labels = (app.menu() ?? []).map((item) => item.label);
  expect(labels).toContain("Open Projects");
  expect(labels).toContain("Settings…");
  await app.closeMenu();
  await app.waitUntil(() => app.menu() === null);
});

test("closes a project window with mod+w", async () => {
  const root = testRoot("close-shortcut");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Keyboard");
  await app.press("text:Keyboard");
  await waitForProjectWindow(app);
  // The shortcut binds inside the window's content, which mounts with its
  // title bar.
  await app.waitUntil(() => app.shows("id:window-menu"));
  await app.keyboard.press("mod+w");
  await app.waitUntil(() => projectWindowIds(app).length === 0);
  await app.waitUntil(() => app.shows("id:projects-page"));
});

test("closing the last window quits on Windows and Linux", async () => {
  const root = testRoot("last-window");
  await resetRoot(root);
  const closeLast = async (platform: "windows" | "linux"): Promise<void> => {
    const app = await open("./App.tsx", {
      platform,
      host: { params: { projectsRoot: root, flowZoomProbe: 1 } },
    });
    await app.waitUntil(() => app.shows("id:projects-page"));
    await app.window("projects").pressClose();
    await app.waitUntil(() => app.quit());
  };
  await closeLast("windows");
  await closeLast("linux");
});

test("closing the last window keeps Flow running on macOS", async () => {
  const root = testRoot("last-window-macos");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.window("projects").pressClose();
  await app.waitUntil(() => !app.windowIds().includes("projects"));
  expect(app.quit()).toBe(false);
  // The app's reopen handler brings the window back; the host is not a
  // window to show.
  await app.reopen();
  await app.waitUntil(() => app.windowIds().includes("projects"));
});

test("opens several projects in their own windows", async () => {
  const root = testRoot("several");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("text:No projects yet"));
  await createFromList(app, "Alpha");
  await createFromList(app, "Beta");

  await app.press("text:Alpha");
  const alphaWindow = await waitForProjectWindow(app);
  const alphaId = alphaWindow.slice("project:".length);
  await app.waitUntil(() => !app.shows("id:projects-page"));

  // Projects comes back by shortcut while Alpha's window stays open.
  await app.keyboard.press("mod+shift+o");
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.press("text:Beta");
  await app.waitUntil(() => projectWindowIds(app).length === 2);
  await app.waitUntil(() => !app.shows("id:projects-page"));
  const betaWindow = projectWindowIds(app).find((id) => id !== alphaWindow);
  if (betaWindow === undefined) throw new Error("Beta did not open a window");
  const betaId = betaWindow.slice("project:".length);

  // Closing one leaves the other and no Projects window: only the last one
  // returns to the list.
  await closeWindow(app, alphaWindow);
  await app.waitUntil(() => projectWindowIds(app).length === 1);
  expect(app.shows("id:projects-page")).toBe(false);

  // An open project's row brings its window forward instead of a second one,
  // so the row reads "Open" and the menu has no identity actions on it.
  await app.keyboard.press("mod+shift+o");
  await app.waitUntil(() => app.shows("id:projects-page"));
  await app.waitUntil(() => app.shows(`id:project-row-${betaId}`));
  await app.press(`id:project-row-${betaId}`);
  await app.waitUntil(() => projectWindowIds(app).length === 1);
  await app.waitUntil(() => app.shows("id:projects-page"));
  expect(app.shows("id:project-action-error")).toBe(false);
  expect(app.window(betaWindow)?.state()?.focused).toBe(true);

  await closeWindow(app, betaWindow);
  await app.waitUntil(() => app.shows("id:projects-page"));
  // The closed project opens fresh again from the list.
  await app.press(`id:project-row-${alphaId}`);
  await waitForProjectWindow(app);
  await closeProjectWindow(app);
});

test("opens Settings in its own window and saves the startup choice", async () => {
  const root = testRoot("settings");
  await resetRoot(root);
  const app = await openApp(root);
  await app.waitUntil(() => app.shows("id:projects-page"));
  expect(app.shows("id:startup-check-projects")).toBe(false);

  await app.keyboard.press("mod+,");
  await app.waitUntil(() => app.shows("id:settings-page"));
  // The Projects window stays behind it.
  expect(app.shows("id:projects-page")).toBe(true);
  await app.press("id:startup-lastProject");
  await app.waitUntil(() => app.shows("id:startup-check-lastProject"));
  expect(app.shows("id:startup-check-projects")).toBe(false);

  // The save is fire-and-forget: wait for Storage, not just the radio.
  await app.waitUntil(
    () => app.storage()["flow.settings.v1"] === JSON.stringify({ startup: "lastProject" }),
  );
  expect(JSON.parse(app.storage()["flow.settings.v1"] ?? "null")).toEqual({
    startup: "lastProject",
  });

  await closeWindow(app, "settings");
  expect(app.shows("id:projects-page")).toBe(true);
});

test("a project held by another window is labelled and does not open", async () => {
  const root = testRoot("held");
  await resetRoot(root);
  const held = await openProjectStore(root);
  const created = await held.createProject("Held", null);
  const lease = await held.openProject(created.projectId);

  try {
    const app = await openApp(root);
    await app.waitUntil(() => app.shows("text:Open in another Flow window"));
    await app.press("text:Held");
    await app.waitUntil(() => app.shows("text:“Held” is open in another Flow window."));
    expect(app.shows("id:projects-page")).toBe(true);
    expect(projectWindowId(app)).toBe(null);
  } finally {
    lease.release();
  }

  await held.deleteProject(created.projectId);
});
