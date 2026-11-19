import { expect, test } from "nsh/test";
import type { ProjectStorePort } from "./flow/projects";
import {
  appSession,
  closeProjectWindow,
  hideProjectsWindow,
  openProjectWindow,
  openProjectWindows,
  projectsWindowOpen,
  registerProjectShutdown,
  setAppSession,
  setQuitting,
  shutdownAllProjects,
  unregisterProjectShutdown,
  type OpenProject,
} from "./store";

/** A project whose store is not used: the registry only carries it. */
function project(projectId: string): OpenProject {
  return { projectId, title: projectId, store: {} as ProjectStorePort };
}

test("an open project is focused, not opened twice", () => {
  hideProjectsWindow();
  openProjectWindow(project("alpha"));
  openProjectWindow(project("beta"));
  expect(openProjectWindows().map((open) => open.projectId)).toEqual(["alpha", "beta"]);

  // The row of a project already open comes forward; the registry keeps one
  // entry and Projects does not come back.
  openProjectWindow(project("alpha"));
  expect(openProjectWindows().map((open) => open.projectId)).toEqual(["alpha", "beta"]);
  expect(projectsWindowOpen()).toBe(false);

  closeProjectWindow("alpha", true);
  closeProjectWindow("beta", true);
  expect(openProjectWindows()).toEqual([]);
  expect(projectsWindowOpen()).toBe(true);
});

test("the session follows which project closed cleanly", () => {
  openProjectWindow(project("alpha"));
  setAppSession({ projectId: "alpha", title: "alpha", clean: false });
  closeProjectWindow("alpha", true);
  expect(appSession()).toEqual({ projectId: "alpha", title: "alpha", clean: true });
});

test("a close that leaves a window open keeps the session on the open project", () => {
  hideProjectsWindow();
  openProjectWindow(project("alpha"));
  openProjectWindow(project("beta"));
  closeProjectWindow("beta", true);
  // Beta closed cleanly, but the run still has Alpha open: a crash must offer
  // Alpha, not claim Beta's clean close.
  expect(appSession()).toEqual({ projectId: "alpha", title: "alpha", clean: false });
  closeProjectWindow("alpha", true);
});

test("quitting closes every project and reports whether all closed", async () => {
  openProjectWindow(project("alpha"));
  openProjectWindow(project("beta"));
  const closed: string[] = [];
  registerProjectShutdown("alpha", {
    shutdown: () => {
      closed.push("alpha");
      return Promise.resolve({ closed: true });
    },
  });
  registerProjectShutdown("beta", {
    shutdown: () => {
      closed.push("beta");
      return Promise.resolve({ closed: false });
    },
  });

  const result = await shutdownAllProjects();
  expect(result.clean).toBe(false);
  expect(result.project).toEqual({ projectId: "beta", title: "beta" });
  expect(closed.toSorted()).toEqual(["alpha", "beta"]);

  unregisterProjectShutdown("alpha");
  unregisterProjectShutdown("beta");
  closeProjectWindow("alpha", true);
  closeProjectWindow("beta", true);
});

test("a rejected project close does not skip the other windows", async () => {
  openProjectWindow(project("alpha"));
  openProjectWindow(project("beta"));
  const closed: string[] = [];
  registerProjectShutdown("alpha", {
    shutdown: () => {
      closed.push("alpha");
      return Promise.resolve({ closed: true });
    },
  });
  registerProjectShutdown("beta", {
    shutdown: () => {
      closed.push("beta");
      return Promise.reject(new Error("the package is busy"));
    },
  });

  const result = await shutdownAllProjects();
  expect(result.clean).toBe(false);
  expect(closed.toSorted()).toEqual(["alpha", "beta"]);

  unregisterProjectShutdown("alpha");
  unregisterProjectShutdown("beta");
  closeProjectWindow("alpha", true);
  closeProjectWindow("beta", true);
});

test("a quitting app does not reopen Projects when its last project closes", () => {
  hideProjectsWindow();
  openProjectWindow(project("alpha"));
  setQuitting();
  closeProjectWindow("alpha", true);
  expect(projectsWindowOpen()).toBe(false);
  // Later tests start from a running app again.
  setQuitting(false);
});

test("a quitting app opens no project window", () => {
  hideProjectsWindow();
  setQuitting();
  openProjectWindow(project("late"));
  expect(openProjectWindows()).toEqual([]);
  expect(projectsWindowOpen()).toBe(false);
  setQuitting(false);
});
