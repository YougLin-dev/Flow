/**
 * The New project dialog: one name, Cancel and Create. It owns its draft and
 * its submission state; the caller creates the project and decides what a
 * result means. Cancelling while a create is in flight is allowed — a caller
 * cannot cancel the store's write, so it ignores the late result instead of
 * holding the user in an unresponsive dialog.
 */
import { keymap, signal, Text, token, View, type InputRef } from "nsh";
import { Button, Dialog, Input } from "nsh/base";
import { errorMessage } from "../../flow/projects";

export interface CreateProjectDialogProps {
  /** The user dismissed the dialog or submitted a name. */
  readonly onCancel: () => void;
  /** Creates the project; rejection keeps the dialog open with the reason. */
  readonly onCreate: (title: string) => Promise<void>;
}

const CANCEL =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const CREATE =
  "rounded-(--radius) bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";

export function CreateProjectDialog(props: CreateProjectDialogProps) {
  const title = signal("");
  const busy = signal(false);
  const error = signal<string | null>(null);
  let input: InputRef | null = null;

  const submit = async (): Promise<void> => {
    const name = title().trim();
    if (busy() || name === "") return;
    busy.set(true);
    error.set(null);
    try {
      await props.onCreate(name);
    } catch (cause) {
      error.set(`Couldn’t create the project. ${errorMessage(cause)}`);
    } finally {
      busy.set(false);
    }
  };

  // Dismissal never waits for the store: a create that has not settled may
  // never settle, and the caller can still show its outcome on the list.
  const cancel = (): void => {
    props.onCancel();
  };

  // Escape closes the topmost surface. The dialog keeps its own native
  // dismissal; this binding makes the path explicit for the keyboard and
  // the headless runner, which does not deliver Escape to the native dialog.
  keymap.bind("escape", cancel, { when: "always" });

  return (
    <Dialog
      testID="create-project-dialog"
      accessibilityLabel="New project"
      animation="fade"
      closeOnEscape
      closeOnBackdropPress
      onCancel={cancel}
      onOpenChange={(event) => {
        if (!event.open) cancel();
      }}
      onOpen={() => input?.focus()}
      class="mx-auto mt-24 w-11/12 max-w-md rounded-(--radius) border border-border bg-popover p-4 shadow-lg"
      backdropStyle={{ backgroundColor: token("background"), opacity: 0.7 }}
    >
      <View class="gap-1">
        <Text class="text-base font-semibold text-popover-foreground">New project</Text>
        <Text class="text-sm text-muted-foreground">
          A new project starts with an empty canvas.
        </Text>
      </View>

      <View class="mt-4 gap-2">
        <Text class="text-sm font-medium text-popover-foreground">Name</Text>
        <Input
          ref={(node) => {
            input = node;
          }}
          testID="project-title"
          accessibilityLabel="Project name"
          value={title()}
          onChange={(event) => {
            title.set(event.value);
            error.set(null);
          }}
          onSubmit={() => void submit()}
          placeholder="Project name"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          submitBehavior="submit"
          class="rounded-(--radius) border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </View>

      {error() ? <Text class="mt-2 text-sm text-destructive">{error()}</Text> : null}

      <View class="mt-4 flex-row justify-end gap-2">
        <Button testID="project-cancel" onPress={cancel} class={CANCEL}>
          <Text class="text-sm text-card-foreground">Cancel</Text>
        </Button>
        <Button
          testID="project-create"
          onPress={() => void submit()}
          disabled={busy() || title().trim() === ""}
          class={CREATE}
        >
          <Text class="text-sm text-primary-foreground">Create</Text>
        </Button>
      </View>
    </Dialog>
  );
}
