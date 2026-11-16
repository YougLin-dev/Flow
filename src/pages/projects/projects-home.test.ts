import { expect, test } from "nsh/test";
import type { ProjectEntry } from "../../flow/shared";
import { PROJECT_OPEN_ELSEWHERE, type ProjectStorePort } from "../../flow/projects";
import { createProjectsHome } from "./projects-home";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function entry(
  projectId: string,
  title: string,
  options: Partial<ProjectEntry> = {},
): ProjectEntry {
  return {
    projectId,
    title,
    path: `/projects/${projectId}/project.db`,
    updatedAt: 1,
    lastOpenedAt: null,
    openHere: false,
    openElsewhere: false,
    unreadable: false,
    ...options,
  };
}

function fakeStore(overrides: Partial<ProjectStorePort> = {}): ProjectStorePort {
  return {
    listProjects: async () => [],
    refreshCatalog: async () => [],
    createProject: async (title) => entry(ID_B, title),
    openProject: async (projectId) => ({
      databasePath: `/projects/${projectId}/project.db`,
      projectId,
      release: () => {},
    }),
    renameProject: async () => entry(ID_A, "Renamed"),
    deleteProject: async () => {},
    duplicateProject: async () => entry(ID_B, "Copy"),
    importProject: async () => entry(ID_B, "Imported"),
    ...overrides,
  };
}

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

test("loads the list in the frozen order", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [
          entry(ID_A, "Older", { updatedAt: 1 }),
          entry(ID_B, "Newer", { updatedAt: 9 }),
        ],
      }),
  });
  await home.refresh();
  expect(home.loading()).toBe(false);
  expect(home.loadError()).toBe(null);
  expect(home.projects().map((project) => project.projectId)).toEqual([ID_B, ID_A]);
  home.dispose();
});

test("reports a load failure and reopens the store on retry", async () => {
  let available = false;
  const home = createProjectsHome("/projects", {
    openStore: async () => {
      if (!available) throw new Error("the projects directory could not be read");
      return fakeStore({ listProjects: async () => [entry(ID_A, "Listed")] });
    },
  });
  await home.refresh();
  expect(home.loading()).toBe(false);
  expect(home.loadError()).toBe("the projects directory could not be read");
  expect(home.projects()).toEqual([]);

  available = true;
  await home.refresh();
  expect(home.loadError()).toBe(null);
  expect(home.projects().map((project) => project.title)).toEqual(["Listed"]);
  home.dispose();
});

test("creates a blank project by trimmed title and adds it to the list", async () => {
  const writes: { title: string; seed: unknown }[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        createProject: async (title, seed) => {
          writes.push({ title, seed });
          return entry(ID_B, title, { lastOpenedAt: 5 });
        },
      }),
  });
  await home.refresh();
  const created = await home.create("  Lake  ");
  expect(writes).toEqual([{ title: "Lake", seed: null }]);
  expect(created.projectId).toBe(ID_B);
  expect(created.title).toBe("Lake");
  expect(home.projects().map((project) => project.title)).toEqual(["Lake"]);
  // Creating does not show the project: the caller decides, so a dismissed
  // dialog's late result cannot open it.
  expect(home.current()).toBe(null);
  home.open(created);
  expect(home.current()?.projectId).toBe(ID_B);
  expect(home.current()?.title).toBe("Lake");
  expect(home.actionError()).toBe(null);
  home.dispose();
});

test("a list read from before a create cannot remove the new row", async () => {
  const pending: { release?: (entries: ProjectEntry[]) => void } = {};
  let calls = 0;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: () => {
          calls += 1;
          if (calls === 1) {
            return new Promise<ProjectEntry[]>((resolve) => {
              pending.release = resolve;
            });
          }
          return Promise.resolve([]);
        },
        createProject: async (title) => entry(ID_B, title),
      }),
  });
  // The initial read is still in flight when the create commits.
  const created = await home.create("Lake");
  expect(created.projectId).toBe(ID_B);
  expect(home.loading()).toBe(false);
  pending.release?.([]);
  await settle();
  expect(home.projects().map((project) => project.title)).toEqual(["Lake"]);
  home.dispose();
});

test("a create failure rejects to the dialog and stays off the canvas", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        createProject: async () => {
          throw new Error("the project title is invalid");
        },
      }),
  });
  await home.refresh();
  expect(await rejection(home.create("Bad"))).toBe("the project title is invalid");
  expect(home.current()).toBe(null);
  home.dispose();
});

test("a dismissed create's failure is reported above the list", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => fakeStore(),
  });
  await home.refresh();
  home.reportActionError("create", new Error("the project title is invalid"));
  expect(home.actionError()).toBe("Couldn’t create the project. the project title is invalid");
  home.dispose();
});

test("renames a project by trimmed title and updates its row", async () => {
  const calls: { id: string; title: string }[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [
          entry(ID_A, "Old", { updatedAt: 1 }),
          entry(ID_B, "Other", { updatedAt: 2 }),
        ],
        renameProject: async (projectId, title) => {
          calls.push({ id: projectId, title });
          return entry(projectId, title, { updatedAt: 9 });
        },
      }),
  });
  await home.refresh();
  const updated = await home.rename(entry(ID_A, "Old"), "  New  ");
  expect(calls).toEqual([{ id: ID_A, title: "New" }]);
  expect(updated.title).toBe("New");
  // The updated row sorts by its new timestamp; the other row stays.
  expect(home.projects().map((project) => project.title)).toEqual(["New", "Other"]);
  expect(home.actionError()).toBe(null);
  home.dispose();
});

test("duplicates a project into a new row and leaves the source", async () => {
  const calls: { id: string; title: string }[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [entry(ID_A, "Source")],
        duplicateProject: async (projectId, title) => {
          calls.push({ id: projectId, title });
          return entry(ID_B, title);
        },
      }),
  });
  await home.refresh();
  const copy = await home.duplicate(entry(ID_A, "Source"), "Source copy");
  expect(calls).toEqual([{ id: ID_A, title: "Source copy" }]);
  expect(copy.projectId).toBe(ID_B);
  expect(home.projects().map((project) => project.title)).toEqual(["Source", "Source copy"]);
  home.dispose();
});

test("deletes a project and cannot resurrect it from a stale list read", async () => {
  const pending: { release?: (entries: ProjectEntry[]) => void } = {};
  let calls = 0;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: () => {
          calls += 1;
          if (calls === 2) {
            return new Promise<ProjectEntry[]>((resolve) => {
              pending.release = resolve;
            });
          }
          return Promise.resolve([entry(ID_A, "Doomed")]);
        },
        deleteProject: async () => {},
      }),
  });
  // The home's initial read is the one that fills the list.
  await settle();
  expect(home.projects().map((project) => project.title)).toEqual(["Doomed"]);
  // A read that started before the delete still holds the old row.
  const read = home.refresh();
  await home.remove(entry(ID_A, "Doomed"));
  expect(home.projects()).toEqual([]);
  pending.release?.([entry(ID_A, "Doomed")]);
  await read;
  await settle();
  expect(home.projects()).toEqual([]);
  home.dispose();
});

test("imports a project folder by trimmed path", async () => {
  const sources: string[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        importProject: async (source) => {
          sources.push(source);
          return entry(ID_B, "Imported");
        },
      }),
  });
  await home.refresh();
  const imported = await home.importProject("  /tmp/package  ");
  expect(sources).toEqual(["/tmp/package"]);
  expect(imported.projectId).toBe(ID_B);
  expect(home.projects().map((project) => project.title)).toEqual(["Imported"]);
  home.dispose();
});

test("an import path copied as a quoted Windows path is accepted", async () => {
  const sources: string[] = [];
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        importProject: async (source) => {
          sources.push(source);
          return entry(ID_B, "Quoted");
        },
      }),
  });
  await home.refresh();
  await home.importProject('  "C:\\Users\\me\\package"  ');
  expect(sources).toEqual(["C:\\Users\\me\\package"]);
  home.dispose();
});

test("an empty import path never reaches the store", async () => {
  let called = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        importProject: async () => {
          called = true;
          return entry(ID_B, "Never");
        },
      }),
  });
  await home.refresh();
  expect(await rejection(home.importProject("   "))).toBe("the project import path is empty");
  expect(await rejection(home.importProject('""'))).toBe("the project import path is empty");
  expect(called).toBe(false);
  home.dispose();
});

test("a failed rename re-reads a package that broke while cached", async () => {
  let broken = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [entry(ID_A, "Cached")],
        refreshCatalog: async () => [
          broken ? entry(ID_A, ID_A, { updatedAt: 0, unreadable: true }) : entry(ID_A, "Cached"),
        ],
        renameProject: async () => {
          throw new Error("the package identity does not match its directory");
        },
      }),
  });
  await home.refresh();
  broken = true;
  await rejection(home.rename(entry(ID_A, "Cached"), "New"));
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(true);
  home.dispose();
});

test("an action cannot drop a pending deep status re-read", async () => {
  let deepCalls = 0;
  const pending: { release?: (entries: ProjectEntry[]) => void } = {};
  const healthy = entry(ID_A, "Cached");
  const broken = entry(ID_A, ID_A, { updatedAt: 0, unreadable: true });
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [healthy],
        refreshCatalog: () => {
          deepCalls += 1;
          if (deepCalls === 1) {
            return new Promise<ProjectEntry[]>((resolve) => {
              pending.release = resolve;
            });
          }
          return Promise.resolve([broken]);
        },
        renameProject: async (projectId, title) => entry(projectId, title),
      }),
  });
  await home.refresh();
  // A package broke after it was cached: the open fails and starts the slow
  // deep re-read that will report it.
  home.reportOpenError(new Error("the package has no Flow database"));
  // An action commits before that read lands; it must not cancel the check.
  await home.rename(entry(ID_A, "Cached"), "Renamed");
  await settle();
  expect(deepCalls).toBe(2);
  expect(home.projects()[0]?.unreadable).toBe(true);

  // The superseded read finishing late cannot restore the healthy row.
  pending.release?.([healthy]);
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(true);
  home.dispose();
});

test("a shallow read cannot drop a pending deep status re-read", async () => {
  let deepCalls = 0;
  const pending: { release?: (entries: ProjectEntry[]) => void } = {};
  const healthy = entry(ID_A, "Cached");
  const broken = entry(ID_A, ID_A, { updatedAt: 0, unreadable: true });
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [healthy],
        refreshCatalog: () => {
          deepCalls += 1;
          if (deepCalls === 1) {
            return new Promise<ProjectEntry[]>((resolve) => {
              pending.release = resolve;
            });
          }
          return Promise.resolve([broken]);
        },
      }),
  });
  await home.refresh();
  // A package broke after it was cached: the open fails and starts the deep
  // re-read that will report it.
  home.reportOpenError(new Error("the package has no Flow database"));
  // Any later read (a return, a refusal) must not drop that check.
  await home.refresh();
  await settle();
  expect(deepCalls).toBe(2);
  expect(home.projects()[0]?.unreadable).toBe(true);
  pending.release?.([healthy]);
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(true);
  home.dispose();
});

test("a failed action re-reads the row's status", async () => {
  let held = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [entry(ID_A, "Locked", { openElsewhere: held })],
        deleteProject: async () => {
          throw new Error(PROJECT_OPEN_ELSEWHERE);
        },
      }),
  });
  await home.refresh();
  expect(home.projects()[0]?.openElsewhere).toBe(false);

  // The other window took the package after this list was read.
  held = true;
  expect(await rejection(home.remove(entry(ID_A, "Locked")))).toBe(PROJECT_OPEN_ELSEWHERE);
  await settle();
  expect(home.projects()[0]?.openElsewhere).toBe(true);
  home.dispose();
});

test("explains why a listed project cannot open", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => fakeStore({ listProjects: async () => [] }),
  });
  await home.refresh();
  home.open(entry(ID_A, ID_A, { unreadable: true }));
  expect(home.current()).toBe(null);
  expect(home.actionError()).toBe("This project can’t be opened. Its files may be damaged.");

  home.open(entry(ID_B, "Held", { openElsewhere: true }));
  expect(home.current()).toBe(null);
  expect(home.actionError()).toBe("“Held” is open in another window.");

  home.clearActionError();
  home.open(entry(ID_A, "Free"));
  expect(home.current()?.projectId).toBe(ID_A);
  expect(home.actionError()).toBe(null);
  home.dispose();
});

test("refusing an unreadable row re-reads a package that recovered", async () => {
  let readable = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [
          readable
            ? entry(ID_A, "Recovered")
            : entry(ID_A, ID_A, { updatedAt: 0, unreadable: true }),
        ],
      }),
  });
  await home.refresh();
  home.open(entry(ID_A, ID_A, { unreadable: true }));
  expect(home.actionError()).toBe("This project can’t be opened. Its files may be damaged.");

  readable = true;
  await settle();
  expect(home.projects()[0]?.unreadable).toBe(false);
  expect(home.projects()[0]?.title).toBe("Recovered");
  home.dispose();
});

test("a failed managed open returns to the list with a readable reason", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => fakeStore(),
  });
  await home.refresh();
  home.open(entry(ID_A, "Free"));
  expect(home.current()?.projectId).toBe(ID_A);

  home.reportOpenError(new Error("the project is open in another window"));
  expect(home.current()).toBe(null);
  expect(home.actionError()).toBe("The project is open in another window.");

  home.reportOpenError(new Error("the package has no Flow database"));
  expect(home.actionError()).toBe("Couldn’t open the project. the package has no Flow database");
  home.dispose();
});

test("a failed managed open re-reads a package that broke while cached", async () => {
  let broken = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        // A shallow read trusts its cached row; only the deep read learns
        // that the package no longer opens.
        listProjects: async () => [entry(ID_A, "Cached")],
        refreshCatalog: async () => [
          broken ? entry(ID_A, ID_A, { updatedAt: 0, unreadable: true }) : entry(ID_A, "Cached"),
        ],
      }),
  });
  await home.refresh();
  expect(home.projects()[0]?.unreadable).toBe(false);

  broken = true;
  home.reportOpenError(new Error("the package has no Flow database"));
  await settle();
  expect(home.actionError()).toBe("Couldn’t open the project. the package has no Flow database");
  expect(home.projects()[0]?.unreadable).toBe(true);
  expect(home.projects()[0]?.title).toBe(ID_A);
  home.dispose();
});

test("a failed managed open re-reads the row that failed", async () => {
  let held = false;
  const home = createProjectsHome("/projects", {
    openStore: async () =>
      fakeStore({
        listProjects: async () => [entry(ID_A, "Taken", { openElsewhere: held })],
        refreshCatalog: async () => [entry(ID_A, "Taken", { openElsewhere: held })],
      }),
  });
  await home.refresh();
  expect(home.projects()[0]?.openElsewhere).toBe(false);

  // The other window took the lock after this list was read.
  held = true;
  home.reportOpenError(new Error(PROJECT_OPEN_ELSEWHERE));
  expect(home.actionError()).toBe("The project is open in another window.");
  await settle();
  expect(home.projects()[0]?.openElsewhere).toBe(true);
  home.dispose();
});

test("returning to the list clears the current project", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => fakeStore(),
  });
  await home.refresh();
  home.open(entry(ID_A, "Free"));
  expect(home.current()).not.toBe(null);
  home.showProjects();
  expect(home.current()).toBe(null);
  home.dispose();
});

test("project access is refused until the store opened", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => {
      throw new Error("the projects directory could not be read");
    },
  });
  expect(home.current()).toBe(null);
  expect(await rejection(home.create("Lake"))).toBe("the projects directory could not be read");
  expect(home.current()).toBe(null);
  home.dispose();
});
