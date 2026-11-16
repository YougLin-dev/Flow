import { cleanup, computed, host, mount, View } from "nsh";
import { isAvailable } from "nsh/desktop";
import { TitleBar } from "./components/app";
import { projectsRootForLaunch } from "./flow/projects";
import { FlowPage } from "./pages/flow";
import { createProjectsHome, ProjectsPage } from "./pages/projects";
import { isPinned, togglePinned } from "./store";

/**
 * Flow — an infinite canvas built with NSH's native view tree.
 *
 * The shell owns the window chrome and the launch navigation: with a managed
 * projects root it shows the project list or the chosen project's canvas;
 * with an explicit document path (tests, the dev script, an embedding host)
 * it keeps the single-document canvas. Page internals live in `pages/` and
 * the shared zoom/pin state in `store.ts`.
 */
function App() {
  const root = projectsRootForLaunch({
    dataDir: process.dataDir ?? null,
    hostProjectsRoot: host.params.projectsRoot,
    hostDocumentPath: host.params.databasePath,
    envDocumentPath: process.env.FLOW_DB_PATH,
    envProjectsRoot: process.env.FLOW_PROJECTS_ROOT,
  });
  const home = root === null ? null : createProjectsHome(root);
  const projectTitle = computed(() => home?.current()?.title);
  cleanup(() => home?.dispose());

  return (
    <View class="flex-1 bg-background">
      {isAvailable && (
        <TitleBar pinned={isPinned()} onTogglePinned={togglePinned} title={projectTitle} />
      )}
      {home === null ? (
        <FlowPage />
      ) : (
        <If when={home.current()} else={<ProjectsPage home={home} />}>
          {(project) => (
            <FlowPage
              project={project()}
              onClose={() => {
                home.showProjects();
                void home.refresh();
              }}
              onOpenError={(error) => home.reportOpenError(error)}
              onRenamed={(title) => home.renameActive(title)}
            />
          )}
        </If>
      )}
    </View>
  );
}

mount(App);
