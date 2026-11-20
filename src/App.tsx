import { cleanup, effect, host, keymap, mount, platform, signal, View } from "nsh";
import { Application, Window } from "nsh/desktop";
import { TitleBar } from "./components/app";
import { openProjectStore, projectsRootForLaunch } from "./flow/projects";
import { DocumentWindow, ProjectWindow } from "./pages/flow";
import { createProjectsHome, ProjectsPage } from "./pages/projects";
import { SettingsPage } from "./pages/settings";
import {
  appReady,
  appSession,
  closeProjectWindow,
  hideProjectsWindow,
  hideSettingsWindow,
  isQuitting,
  openProjectWindows,
  openProjectWindow,
  requestNewProject,
  focusProjectWindow,
  projectsWindowOpen,
  renameProjectWindow,
  setAppReady,
  setAppSession,
  setAppSettings,
  setQuitting,
  settingsWindowOpen,
  showProjectsWindow,
  showSettingsWindow,
  shutdownAllProjects,
  PROJECTS_WINDOW,
  SETTINGS_WINDOW,
  type OpenProject,
} from "./store";
import { decideStartup, loadSession, loadSettings, saveSession } from "./startup";

/** The Settings window, apart from the project windows on every path. */
function SettingsWindow(props: {
  readonly open: () => boolean;
  readonly onOpenProjects?: (() => void) | undefined;
}) {
  return (
    <Window
      id={SETTINGS_WINDOW}
      title="Settings"
      kind="dialog"
      open={props.open()}
      titleBar={{ style: "hidden", height: 32 }}
      defaultSize={{ width: 520, height: 360 }}
      minSize={{ width: 420, height: 320 }}
      onOpenChange={({ open }) => {
        if (!open) hideSettingsWindow();
      }}
    >
      <View class="flex-1">
        <TitleBar onOpenProjects={props.onOpenProjects} />
        <SettingsPage />
      </View>
    </Window>
  );
}

/**
 * Flow — an infinite canvas built with NSH's native view tree, one window per
 * project.
 *
 * The app root owns the project catalogue, settings and the window registry;
 * each project window owns its lease, document, canvas and composer. The
 * Projects window is the entry point: opening a project closes it, closing
 * the last project opens it again. The app root survives every window, so a
 * project window closing disposes only that window's state.
 */
function App() {
  const root = projectsRootForLaunch({
    dataDir: process.dataDir ?? null,
    hostProjectsRoot: host.params.projectsRoot,
    hostDocumentPath: host.params.databasePath,
    envDocumentPath: process.env.FLOW_DB_PATH,
    envProjectsRoot: process.env.FLOW_PROJECTS_ROOT,
  });
  let home: ReturnType<typeof createProjectsHome> | null = null;
  if (root !== null) {
    // One open per project: a second press while the catalog is still
    // opening must not create a second store for the same project.
    const opening = new Map<string, ReturnType<typeof openProjectStore>>();
    home = createProjectsHome(root, {
      // Each project window opens the root in its own store: the store
      // holds one active lease, and windows open projects independently.
      onOpen: (project) => {
        // A quit owns the windows it found: none opens after it starts.
        if (isQuitting() || opening.has(project.projectId)) return;
        const pending = openProjectStore(root);
        opening.set(project.projectId, pending);
        void pending.then(
          (store) => {
            opening.delete(project.projectId);
            if (isQuitting()) return;
            openProjectWindow({
              projectId: project.projectId,
              title: project.title,
              store,
            });
          },
          (error: unknown) => {
            opening.delete(project.projectId);
            home?.reportOpenError(error);
          },
        );
      },
      onFocus: focusProjectWindow,
      isOpenInApp: (projectId) => openProjectWindows().some((open) => open.projectId === projectId),
    });
  }
  cleanup(() => home?.dispose());

  const ready = signal(false);

  // The mode is the app's: with no project window open, Flow decides
  // whether closing Projects ends it (macOS stays in the Dock).
  Application.setQuitMode("explicit");

  keymap.bind(
    {
      "mod+n": requestNewProject,
      "mod+,": showSettingsWindow,
      "mod+shift+o": showProjectsWindow,
    },
    { scope: "app" },
  );

  cleanup(
    Application.on("reopen", () => {
      showProjectsWindow();
      Window.get(PROJECTS_WINDOW)?.focus();
    }),
  );

  // The platform's last-window policy, with Flow's one exception: a project
  // window close opens Projects in the same turn, so the signals already say
  // a window is coming and the app stays. macOS keeps running in the Dock.
  cleanup(
    Application.on("lastWindowClosed", () => {
      if (platform.os === "macos" || isQuitting()) return;
      if (projectsWindowOpen() || settingsWindowOpen() || openProjectWindows().length > 0) return;
      // No window is coming: a store open still in flight must not register
      // one after the quit starts.
      setQuitting();
      Application.quit();
    }),
  );

  // One coordinator closes every project (saving drafts, camera and package)
  // and then quits. The 200 ms quit budget is why this is the request path,
  // not the best-effort `quit` hook. The same promise serves both paths: a
  // quit the platform starts (logout, shutdown) waits for it in the `quit`
  // listener, and a request's `quit()` reuses it.
  let shuttingDown: Promise<Awaited<ReturnType<typeof shutdownAllProjects>>> | null = null;
  const shutdownOnce = () => (shuttingDown ??= shutdownAllProjects());

  // macOS asks the app before a logout or shutdown, and it is the async
  // path that can save; other platforms ignore these options.
  Application.setQuitRequestOptions({ system: true });

  // A quit that cannot save is not final: the run stays, the session is
  // already recorded unclean, and the user can close the failing window and
  // retry. A failed close reports `clean: false` rather than throwing, so
  // both outcomes take this path.
  const stayOpen = (): void => {
    // Answer the request the platform is holding: macOS keeps a pending
    // quit confirmation and stops notifying the app on later quits until
    // it is answered one way or the other.
    Application.cancelQuitRequest();
    setQuitting(false);
    shuttingDown = null;
    home?.reportNotice(
      "Flow couldn’t save every project. Close the project windows and try again.",
    );
    showProjectsWindow();
  };

  cleanup(
    Application.on("quitRequest", () => {
      void (async () => {
        setQuitting();
        let clean = false;
        try {
          const result = await shutdownOnce();
          clean = result.clean;
          const current = appSession();
          // No project window was open: the session keeps what it recorded
          // (a crash's `clean: false` included), rather than a vacuous clean.
          const recorded =
            result.project !== null
              ? { projectId: result.project.projectId, title: result.project.title, clean }
              : current;
          if (recorded !== null) {
            setAppSession(recorded);
            // The run must be recorded before it ends: the effect's save may
            // not settle once `quit()` starts the shutdown.
            await saveSession(recorded);
          }
        } catch (error) {
          console.error("Flow could not close every project", error);
          const current = appSession();
          if (current !== null) setAppSession({ ...current, clean: false });
          stayOpen();
          return;
        }
        if (!clean) {
          stayOpen();
          return;
        }
        Application.quit();
      })();
    }),
  );

  cleanup(
    Application.on("quit", () => {
      setQuitting();
      // The platform waits for this promise, 200 ms at most: an OS-ended
      // session still gets its drafts and checkpoint write.
      return shutdownOnce().then(() => undefined);
    }),
  );

  // The session follows clean closes; a crash leaves its last save unclean.
  // Before the stored session is read its value is `null`, which must not be
  // written back over the last run's marker.
  effect(() => {
    if (appReady()) void saveSession(appSession());
  });

  void (async () => {
    const [settings, session] = await Promise.all([loadSettings(), loadSession()]);
    setAppSettings(settings);
    setAppSession(session);
    // Opening a project marks the run unclean; a run that never opens one
    // leaves the last clean close alone.
    if (home !== null) {
      await home.refresh();
      const decision = decideStartup(settings, session, home.projects());
      if (decision.kind === "project") {
        home.open(decision.project);
      } else if (decision.kind === "recover") {
        home.showRecovery(decision.project);
      } else if (decision.kind === "fallback" && session !== null) {
        const title = session.title;
        const why =
          decision.reason === "missing"
            ? "it is no longer in the projects folder"
            : decision.reason === "unreadable"
              ? "its files may be damaged"
              : "it is open in another Flow window";
        home.reportNotice(`“${title}” could not open: ${why}.`);
      }
    }
    setAppReady();
    ready.set(true);
  })().catch((error: unknown) => {
    // Never start with no window because Storage failed: Projects still
    // opens, explains, and lets the user quit.
    console.error("Flow could not read its settings or session", error);
    home?.reportNotice("Flow couldn’t read its saved settings; starting with Projects.");
    setAppReady();
    ready.set(true);
  });

  if (home === null) {
    return (
      <>
        <DocumentWindow open={ready()} />
        <SettingsWindow open={() => ready() && settingsWindowOpen()} />
      </>
    );
  }

  return (
    <>
      <Window
        id={PROJECTS_WINDOW}
        title="Projects"
        open={ready() && projectsWindowOpen()}
        titleBar={{ style: "hidden", height: 32 }}
        defaultSize={{ width: 980, height: 720 }}
        minSize={{ width: 560, height: 420 }}
        restoreBounds
        onOpenChange={({ open }) => {
          if (!open) hideProjectsWindow();
        }}
      >
        <View class="flex-1">
          <TitleBar onNewProject={requestNewProject} onOpenSettings={showSettingsWindow} />
          <ProjectsPage home={home} />
        </View>
      </Window>

      <Each of={openProjectWindows()} key={(project: OpenProject) => project.projectId}>
        {(project: () => OpenProject) => (
          <ProjectWindow
            project={project()}
            title={() => project().title}
            onClosed={(clean) => {
              closeProjectWindow(project().projectId, clean);
              home.showProjects();
              void home.refresh();
            }}
            onOpenError={(error) => {
              const id = project().projectId;
              closeProjectWindow(id, false);
              home.reportOpenError(error);
              showProjectsWindow();
            }}
            onRenamed={(title) => renameProjectWindow(project().projectId, title)}
          />
        )}
      </Each>

      <SettingsWindow
        open={() => ready() && settingsWindowOpen()}
        onOpenProjects={showProjectsWindow}
      />
    </>
  );
}

mount(App);
