import { expect, test } from "nsh/test";
import type { Document, ProjectInfo } from "../shared";
import type { OpenedFlowDocument } from "../document";
import {
  PROJECT_ALREADY_OPEN,
  PROJECT_CLOSE_FAILED,
  PROJECT_OPEN_ELSEWHERE,
  PROJECT_OPEN_HERE,
  closeFlowProject,
  isAnotherProjectOpen,
  isProjectOpenElsewhere,
  isProjectOpenHere,
  openFlowProject,
  switchFlowProject,
  type ProjectLeasePort,
  type ProjectSessionDeps,
} from "./index";

function info(projectId = "p1"): ProjectInfo {
  return {
    projectId,
    title: "Project",
    cameraX: 0,
    cameraY: 0,
    cameraZoom: 1,
    nodeCount: 0,
    edgeCount: 0,
    demoSeeded: true,
    openedClean: true,
  };
}

function opened(projectId = "p1"): OpenedFlowDocument {
  return { document: null as unknown as Document, info: info(projectId) };
}

function lease(events: string[], projectId: string): ProjectLeasePort {
  return {
    databasePath: `/root/${projectId}/project.db`,
    projectId,
    release: () => events.push(`release:${projectId}`),
  };
}

function deps(events: string[], overrides: Partial<ProjectSessionDeps> = {}): ProjectSessionDeps {
  return {
    store: {
      openProject: async (projectId) => {
        events.push(`open-lease:${projectId}`);
        return lease(events, projectId);
      },
    },
    shutdown: async () => {
      events.push("shutdown");
      return { closed: true };
    },
    openDocument: async (path, options) => {
      events.push(`open:${path}:${options.projectId}:${String(options.seedDemo)}`);
      return opened(options.projectId);
    },
    ...overrides,
  };
}

test("opens the lease's package with the managed seed decision", async () => {
  const events: string[] = [];
  const project = await openFlowProject(deps(events), "p1");
  expect(events).toEqual(["open-lease:p1", "open:/root/p1/project.db:p1:false"]);
  expect(project.info.projectId).toBe("p1");
  expect(project.lease.projectId).toBe("p1");
});

test("a failed document open releases the lease and rethrows", async () => {
  const events: string[] = [];
  const failing = deps(events, {
    openDocument: async () => {
      throw new Error("the package is busy");
    },
  });
  let message = "";
  try {
    await openFlowProject(failing, "p1");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("the package is busy");
  expect(events).toEqual(["open-lease:p1", "release:p1"]);
});

test("close shuts the workspace down before releasing the lease", async () => {
  const events: string[] = [];
  const project = await openFlowProject(deps(events), "p1");
  events.length = 0;
  const released = await closeFlowProject(deps(events), project);
  expect(released).toBe(true);
  expect(events).toEqual(["shutdown", "release:p1"]);
});

test("a failed close keeps the lease", async () => {
  const events: string[] = [];
  const project = await openFlowProject(deps(events), "p1");
  events.length = 0;
  const failing = deps(events, { shutdown: async () => ({ closed: false }) });
  const released = await closeFlowProject(failing, project);
  expect(released).toBe(false);
  expect(events).toEqual([]);
});

test("closing without a project releases nothing", async () => {
  const events: string[] = [];
  expect(await closeFlowProject(deps(events), null)).toBe(true);
  expect(events).toEqual([]);
});

test("switch closes and releases the current project before opening the next", async () => {
  const events: string[] = [];
  const current = await openFlowProject(deps(events), "p1");
  events.length = 0;
  const next = await switchFlowProject(deps(events), current, "p2");
  expect(events).toEqual([
    "shutdown",
    "release:p1",
    "open-lease:p2",
    "open:/root/p2/project.db:p2:false",
  ]);
  expect(next.lease.projectId).toBe("p2");
});

test("switch stops when the current project could not close", async () => {
  const events: string[] = [];
  const current = await openFlowProject(deps(events), "p1");
  events.length = 0;
  const failing = deps(events, { shutdown: async () => ({ closed: false }) });
  let message = "";
  try {
    await switchFlowProject(failing, current, "p2");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe(PROJECT_CLOSE_FAILED);
  expect(events).toEqual([]);
});

test("the race strings match the Rust literals exactly", () => {
  expect(PROJECT_OPEN_ELSEWHERE).toBe("the project is open in another window");
  expect(PROJECT_OPEN_HERE).toBe("the project is open in this window");
  expect(PROJECT_ALREADY_OPEN).toBe("another project is already open in this window");
  expect(PROJECT_CLOSE_FAILED).toBe("the open project could not be closed");
});

test("only the exact race strings map to their states", () => {
  expect(isProjectOpenElsewhere(PROJECT_OPEN_ELSEWHERE)).toBe(true);
  expect(isProjectOpenElsewhere(new Error(PROJECT_OPEN_ELSEWHERE))).toBe(true);
  expect(isProjectOpenElsewhere(PROJECT_OPEN_HERE)).toBe(false);
  expect(isProjectOpenElsewhere("the package is busy")).toBe(false);
  expect(isProjectOpenHere(PROJECT_OPEN_HERE)).toBe(true);
  expect(isAnotherProjectOpen(PROJECT_ALREADY_OPEN)).toBe(true);
  expect(isAnotherProjectOpen(PROJECT_OPEN_ELSEWHERE)).toBe(false);
});
