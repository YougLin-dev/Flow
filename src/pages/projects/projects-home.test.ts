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
  home.reportCreateError(new Error("the project title is invalid"));
  expect(home.actionError()).toBe("Couldn’t create the project. the project title is invalid");
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
