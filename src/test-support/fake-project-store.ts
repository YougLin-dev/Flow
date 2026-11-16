/**
 * A fake `ProjectStorePort` for page-level tests and probes. It has no
 * filesystem: callers override the one method their behavior exercises.
 */
import type { ProjectEntry } from "../flow/shared";
import type { ProjectStorePort } from "../flow/projects";

/** A readable project row with the given id. */
export function listedProject(projectId: string, title = "Listed"): ProjectEntry {
  return {
    projectId,
    title,
    path: `/projects/${projectId}/project.db`,
    updatedAt: 1,
    lastOpenedAt: null,
    openHere: false,
    openElsewhere: false,
    unreadable: false,
  };
}

export function fakeProjectStore(overrides: Partial<ProjectStorePort> = {}): ProjectStorePort {
  const listed = listedProject("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  return {
    listProjects: async () => [listed],
    refreshCatalog: async () => [listed],
    createProject: async () => listed,
    openProject: async (projectId) => ({
      databasePath: `/projects/${projectId}/project.db`,
      projectId,
      release: () => {},
    }),
    renameProject: async () => listed,
    deleteProject: async () => {},
    duplicateProject: async () => listed,
    importProject: async () => listed,
    ...overrides,
  };
}
