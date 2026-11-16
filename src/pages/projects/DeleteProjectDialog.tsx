/**
 * The delete confirmation: names the project, says the deletion cannot be
 * undone, and keeps a failure in place. Dismissal never waits for the store,
 * so a delete that never settles cannot trap the user.
 */
import { signal, Text } from "nsh";
import { Button } from "nsh/base";
import { errorMessage, projectControlName } from "../../flow/projects";
import type { ProjectEntry } from "../../flow/shared";
import { ProjectDialogShell } from "./ProjectDialogShell";

export interface DeleteProjectDialogProps {
  readonly project: ProjectEntry;
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  readonly onDelete: () => Promise<void>;
}

const CANCEL =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const DELETE =
  "rounded-(--radius) bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";

export function DeleteProjectDialog(props: DeleteProjectDialogProps) {
  const busy = signal(false);
  const error = signal<string | null>(null);
  const title = projectControlName(props.project);

  const remove = async (): Promise<void> => {
    if (busy()) return;
    busy.set(true);
    error.set(null);
    try {
      await props.onDelete();
    } catch (cause) {
      error.set(`${props.failurePrefix} ${errorMessage(cause)}`);
    } finally {
      busy.set(false);
    }
  };

  return (
    <ProjectDialogShell
      testID="project-delete-dialog"
      accessibilityLabel="Delete project"
      role="alertdialog"
      heading="Delete project"
      description={
        props.project.unreadable
          ? `“${title}” can’t be read, but deleting removes its folder. This can’t be undone.`
          : `“${title}” and its canvas and assets will be deleted. This can’t be undone.`
      }
      error={error()}
      onCancel={() => props.onCancel()}
      actions={
        <>
          <Button testID="project-delete-cancel" onPress={() => props.onCancel()} class={CANCEL}>
            <Text class="text-sm text-card-foreground">Cancel</Text>
          </Button>
          <Button
            testID="project-delete-submit"
            onPress={() => void remove()}
            disabled={busy()}
            class={DELETE}
          >
            <Text class="text-sm text-destructive-foreground">Delete</Text>
          </Button>
        </>
      }
    />
  );
}
