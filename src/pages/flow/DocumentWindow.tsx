import { keymap, signal, Text, View } from "nsh";
import { Application, Window } from "nsh/desktop";
import { TitleBar } from "../../components/app";
import { DOCUMENT_WINDOW, registerProjectShutdown, showSettingsWindow } from "../../store";
import { FlowPage } from "./FlowPage";
import type { FlowWorkspace } from "./workspace/flow-workspace";

/**
 * Binds the close shortcut inside the window's subtree: a binding made in
 * the component that returns the window runs in the app root, where it
 * would apply to every window.
 */
function CloseOnModW(props: { readonly onPress: () => void }): null {
  keymap.bind("mod+w", props.onPress);
  return null;
}

/**
 * The legacy single-document launch (`FLOW_DB_PATH`, an embedding host's
 * `databasePath`): one explicit window, with no project catalogue behind it.
 * Closing it quits; there is no Projects window to return to.
 */
export function DocumentWindow(props: { readonly open: boolean }) {
  let workspace: FlowWorkspace | null = null;
  const closing = signal(false);
  const closeFailed = signal(false);

  const requestClose = async (): Promise<void> => {
    if (workspace === null || closing()) return;
    closing.set(true);
    closeFailed.set(false);
    try {
      const { closed } = await workspace.shutdown();
      if (closed) {
        Application.quit();
        return;
      }
    } catch (error) {
      console.error("Flow could not save and close the document", error);
    }
    // The window and its lease stay: the user can retry.
    closing.set(false);
    closeFailed.set(true);
  };
  return (
    <Window
      id={DOCUMENT_WINDOW}
      title="Flow"
      open={props.open}
      closeOnPress={false}
      titleBar={{ style: "hidden", height: 32 }}
      defaultSize={{ width: 1280, height: 800 }}
      minSize={{ width: 720, height: 480 }}
      restoreBounds
      onClosePress={() => void requestClose()}
      onOpenChange={({ open }) => {
        if (!open) Application.quit();
      }}
    >
      <View class="flex-1">
        <CloseOnModW onPress={() => void requestClose()} />
        <TitleBar onOpenSettings={showSettingsWindow} />
        {closeFailed() ? (
          <View testID="document-close-error" class="bg-card px-4 py-2">
            <Text class="text-xs text-destructive">
              Couldn’t close the document. Its file is still open; try closing it again.
            </Text>
          </View>
        ) : null}
        <FlowPage
          onWorkspace={(created) => {
            workspace = created;
            registerProjectShutdown(DOCUMENT_WINDOW, created);
          }}
        />
      </View>
    </Window>
  );
}
