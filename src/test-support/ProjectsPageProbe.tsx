/**
 * A test entry that mounts the projects page over a fixed list. The real
 * store cannot seed an unreadable package from a test (that needs a damaged
 * directory, and the test host grants no fs capability), so the page's
 * fallback-row behavior is exercised through this entry instead.
 */
import { mount, signal, View } from "nsh";
import type { ProjectEntry } from "../flow/shared";
import { ProjectsPage, type ProjectsHome } from "../pages/projects";

/** The damaged package the probe lists; its title is its directory name. */
export const UNREADABLE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const UNREADABLE: ProjectEntry = {
  projectId: UNREADABLE_ID,
  title: UNREADABLE_ID,
  path: `/projects/${UNREADABLE_ID}/project.db`,
  updatedAt: 0,
  lastOpenedAt: null,
  openHere: false,
  openElsewhere: false,
  unreadable: true,
};

export function ProjectsPageProbe() {
  const projects = signal<ProjectEntry[]>([UNREADABLE]);
  const actionError = signal<string | null>(null);
  const home: ProjectsHome = {
    projects: () => projects(),
    loading: () => false,
    loadError: () => null,
    actionError: () => actionError(),
    current: () => null,
    refresh: async () => {},
    revalidate: async () => {},
    open: () => {},
    create: async () => UNREADABLE,
    rename: async () => UNREADABLE,
    duplicate: async () => UNREADABLE,
    remove: async () => {},
    importProject: async () => UNREADABLE,
    showProjects: () => {},
    reportOpenError: () => {},
    reportActionError: () => actionError.set("The action was refused."),
    clearActionError: () => actionError.set(null),
    dispose: () => {},
  };

  return (
    <View class="flex-1">
      <ProjectsPage home={home} />
    </View>
  );
}

mount(ProjectsPageProbe);
