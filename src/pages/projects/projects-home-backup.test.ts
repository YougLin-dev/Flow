import { expect, test } from "nsh/test";
import { fakeProjectStore, listedProject } from "../../test-support/fake-project-store";
import { createProjectsHome } from "./projects-home";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail");
}

/** Lets the home's quiet re-reads finish; they are promises, not timers. */
async function settle(depth = 20): Promise<void> {
  if (depth === 0) return;
  await Promise.resolve();
  return settle(depth - 1);
}

test("backs up a project by trimmed path and leaves its row", async () => {
  const calls: { id: string; destination: string }[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => [listedProject(ID_A, "Saved")],
        backupProject: async (projectId, destination) => {
          calls.push({ id: projectId, destination });
        },
      }),
  });
  await home.refresh();
  await home.backup(listedProject(ID_A, "Saved"), '  "C:\\Backups\\Saved"  ');
  expect(calls).toEqual([{ id: ID_A, destination: "C:\\Backups\\Saved" }]);
  expect(home.projects().map((project) => project.title)).toEqual(["Saved"]);
  expect(home.actionError()).toBe(null);
  home.dispose();
});

test("an empty backup destination never reaches the store", async () => {
  let called = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        backupProject: async () => {
          called = true;
        },
      }),
  });
  await home.refresh();
  expect(await rejection(home.backup(listedProject(ID_A, "Saved"), "   "))).toBe(
    "the backup destination is empty",
  );
  expect(await rejection(home.backup(listedProject(ID_A, "Saved"), '""'))).toBe(
    "the backup destination is empty",
  );
  expect(called).toBe(false);
  home.dispose();
});

test("restores a project by trimmed path and updates its row", async () => {
  const calls: { id: string; source: string }[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => [
          { ...listedProject(ID_A, "Old"), updatedAt: 1 },
          { ...listedProject(ID_B, "Other"), updatedAt: 2 },
        ],
        restoreProject: async (projectId, source) => {
          calls.push({ id: projectId, source });
          return { ...listedProject(projectId, "Restored"), updatedAt: 9 };
        },
      }),
  });
  await home.refresh();
  const restored = await home.restore(listedProject(ID_A, "Old"), "  /backups/saved  ");
  expect(calls).toEqual([{ id: ID_A, source: "/backups/saved" }]);
  expect(restored.title).toBe("Restored");
  expect(home.projects().map((project) => project.title)).toEqual(["Restored", "Other"]);
  expect(home.actionError()).toBe(null);
  home.dispose();
});

test("an empty restore path never reaches the store", async () => {
  let called = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        restoreProject: async (projectId) => {
          called = true;
          return listedProject(projectId, "Never");
        },
      }),
  });
  await home.refresh();
  expect(await rejection(home.restore(listedProject(ID_A, "Saved"), "   "))).toBe(
    "the project restore path is empty",
  );
  expect(await rejection(home.restore(listedProject(ID_A, "Saved"), '""'))).toBe(
    "the project restore path is empty",
  );
  expect(called).toBe(false);
  home.dispose();
});

test("a failed restore re-reads a package that broke while cached", async () => {
  let broken = false;
  const cached = listedProject(ID_A, "Cached");
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => [cached],
        refreshCatalog: async () => [
          broken ? { ...listedProject(ID_A, ID_A), updatedAt: 0, unreadable: true } : cached,
        ],
        restoreProject: async () => {
          throw new Error("the backup belongs to another project; import it instead");
        },
      }),
  });
  await home.refresh();
  broken = true;
  await rejection(home.restore(cached, "/backups/saved"));
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(true);
  home.dispose();
});

test("a failed backup re-reads a package that broke while cached", async () => {
  let broken = false;
  const cached = listedProject(ID_A, "Cached");
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeProjectStore({
        listProjects: async () => [cached],
        refreshCatalog: async () => [
          broken ? { ...listedProject(ID_A, ID_A), updatedAt: 0, unreadable: true } : cached,
        ],
        backupProject: async () => {
          throw new Error("the backup destination already exists");
        },
      }),
  });
  await home.refresh();
  broken = true;
  await rejection(home.backup(cached, "/backups/saved"));
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(true);
  home.dispose();
});
