/** The projects area facade: the managed root, store adapter and session. */
export {
  filterProjects,
  projectControlName,
  projectDisplayTitle,
  projectStatus,
  projectStatusLabel,
  projectSubtitle,
  relativeTime,
  sortProjects,
  type ProjectStatus,
} from "./project-list";
export {
  PROJECT_ALREADY_OPEN,
  PROJECT_OPEN_ELSEWHERE,
  PROJECT_OPEN_HERE,
  errorMessage,
  isAnotherProjectOpen,
  isProjectOpenElsewhere,
  isProjectOpenHere,
  openProjectStore,
  type ProjectLeasePort,
  type ProjectStorePort,
} from "./project-store";
export {
  PROJECT_CLOSE_FAILED,
  closeFlowProject,
  openFlowProject,
  projectSessionDeps,
  switchFlowProject,
  type ManagedOpenOptions,
  type OpenProject,
  type ProjectSessionDeps,
} from "./project-session";
export { projectsRoot, projectsRootForLaunch, type ProjectsRootSources } from "./projects-root";
