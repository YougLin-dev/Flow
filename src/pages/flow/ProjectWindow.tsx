import { keymap, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { TitleBar } from "../../components/app";
import {
  projectWindowId,
  registerProjectShutdown,
  requestNewProject,
  showProjectsWindow,
  showSettingsWindow,
  type OpenProject,
} from "../../store";
import { FlowPage } from "./FlowPage";
import type { FlowWorkspace } from "./workspace/flow-workspace";

/**
 * Binds the close shortcut inside the window's subtree. This component must
 * render under `<Window>`: a binding made in the component that returns the
 * window runs in the app root, where it would apply to every window.
 */
function CloseOnModW(props: { readonly onPress: () => void }): null {
  keymap.bind("mod+w", props.onPress);
  return null;
}

export interface ProjectWindowProps {
  /** The project this window shows, as the app registry has it. */
  readonly project: OpenProject;
  /** Its live title (a rename updates the native window title). */
  readonly title: () => string;
  /** The window went; `clean` says its document saved and released. */
  readonly onClosed: (clean: boolean) => void;
  /** The package could not open: the app shows Projects with the reason. */
  readonly onOpenError: (error: unknown) => void;
  /** The open project was renamed from the canvas. */
  readonly onRenamed: (title: string) => void;
}

/**
 * One project in a window of its own: its own lease, document, canvas,
 * composer and camera, sharing only the app root (settings, the project
 * catalogue and the window registry). The close button asks the workspace to
 * save and close before the window goes; a failed close keeps the window and
 * its lease, so the user can retry instead of losing the package to a second
 * writer.
 */
export function ProjectWindow(props: ProjectWindowProps) {
  let workspace: FlowWorkspace | null = null;
  const closing = signal(false);
  const closeFailed = signal(false);
  // One completion per window: a close racing a failed open must not report
  // the window twice (the second report would record the failed open clean).
  let done = false;
  const finish = (clean: boolean): void => {
    if (done) return;
    done = true;
    props.onClosed(clean);
  };

  const requestClose = async (): Promise<void> => {
    if (workspace === null || closing()) return;
    closing.set(true);
    closeFailed.set(false);
    try {
      const { closed } = await workspace.shutdown();
      if (closed) {
        finish(true);
        return;
      }
    } catch (error) {
      console.error("Flow could not save and close the project", error);
    }
    // The window and its lease stay: a retry can still save, and only a
    // second writer would lose the package.
    closing.set(false);
    closeFailed.set(true);
  };
  return (
    <Window
      id={projectWindowId(props.project.projectId)}
      title={props.title()}
      closeOnPress={false}
      titleBar={{ style: "hidden", height: 32 }}
      defaultSize={{ width: 1280, height: 800 }}
      minSize={{ width: 720, height: 480 }}
      restoreBounds
      onClosePress={() => void requestClose()}
      onOpenChange={({ open }) => {
        if (!open) finish(false);
      }}
    >
      <View class="flex-1">
        <CloseOnModW onPress={() => void requestClose()} />
        <TitleBar
          title={props.title}
          onOpenProjects={showProjectsWindow}
          onNewProject={requestNewProject}
          onOpenSettings={showSettingsWindow}
        />
        {closeFailed() ? (
          <View testID="project-close-error" class="bg-card px-4 py-2">
            <Text class="text-xs text-destructive">
              Couldn’t close the project. Its file is still open; try closing it again.
            </Text>
          </View>
        ) : null}
        <FlowPage
          project={props.project}
          onOpenError={(error) => {
            // The app owns a failed open: it removes this window and returns
            // to Projects, so the window reports no close of its own.
            done = true;
            props.onOpenError(error);
          }}
          onRenamed={props.onRenamed}
          onWorkspace={(created) => {
            workspace = created;
            registerProjectShutdown(props.project.projectId, created);
          }}
        />
      </View>
    </Window>
  );
}
