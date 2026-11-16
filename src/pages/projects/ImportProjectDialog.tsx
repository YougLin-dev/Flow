/**
 * The import dialog: one folder or archive path, Cancel and Import. NSH has
 * no folder picker and the file picker hands back bytes rather than a path,
 * so the dialog asks for the path directly; the Rust store reads a package
 * folder or a `.zip` of one, refuses a folder inside the managed root, and
 * imports a copy. Dismissal never waits for the store.
 */
import { signal, Text, View, type InputRef } from "nsh";
import { Button, Input } from "nsh/base";
import { errorMessage } from "../../flow/projects";
import { ProjectDialogShell } from "./ProjectDialogShell";

export interface ImportProjectDialogProps {
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  readonly onImport: (source: string) => Promise<void>;
}

const CANCEL =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const SUBMIT =
  "rounded-(--radius) bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";

export function ImportProjectDialog(props: ImportProjectDialogProps) {
  const source = signal("");
  const busy = signal(false);
  const error = signal<string | null>(null);
  let input: InputRef | null = null;

  const submit = async (): Promise<void> => {
    const sourcePath = source().trim();
    if (busy() || sourcePath === "") return;
    busy.set(true);
    error.set(null);
    try {
      await props.onImport(sourcePath);
    } catch (cause) {
      error.set(`${props.failurePrefix} ${errorMessage(cause)}`);
    } finally {
      busy.set(false);
    }
  };

  return (
    <ProjectDialogShell
      testID="project-import-dialog"
      accessibilityLabel="Import project"
      heading="Import project"
      description="Enter the path of a Flow project folder (the one that holds project.db) or a .zip archive of one."
      error={error()}
      onCancel={() => props.onCancel()}
      onOpen={() => input?.focus()}
      actions={
        <>
          <Button testID="project-import-cancel" onPress={() => props.onCancel()} class={CANCEL}>
            <Text class="text-sm text-card-foreground">Cancel</Text>
          </Button>
          <Button
            testID="project-import-submit"
            onPress={() => void submit()}
            disabled={busy() || source().trim() === ""}
            class={SUBMIT}
          >
            <Text class="text-sm text-primary-foreground">Import</Text>
          </Button>
        </>
      }
    >
      <View class="mt-4 gap-2">
        <Text class="text-sm font-medium text-popover-foreground">Folder or archive</Text>
        <Input
          ref={(node) => {
            input = node;
          }}
          testID="project-import-path"
          accessibilityLabel="Project folder or archive"
          value={source()}
          onChange={(event) => {
            source.set(event.value);
            error.set(null);
          }}
          onSubmit={() => void submit()}
          placeholder="A package folder or .zip archive"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          submitBehavior="submit"
          class="rounded-(--radius) border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </View>
    </ProjectDialogShell>
  );
}
