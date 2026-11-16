/**
 * The name dialog for creating, renaming and duplicating a project: one name,
 * Cancel and the action. It owns its draft and submission state; the caller
 * performs the write and decides what its result means. Dismissal never
 * waits for the store — a write that never settles must not trap the user —
 * so the caller ignores a late result instead.
 */
import { signal, Text, View, type InputRef } from "nsh";
import { Button, Input } from "nsh/base";
import { errorMessage } from "../../flow/projects";
import { ProjectDialogShell } from "./ProjectDialogShell";

export interface ProjectNameDialogProps {
  /** The test ids' prefix: `<prefix>-dialog`, `<prefix>-title`, `<prefix>-submit`, `<prefix>-cancel`. */
  readonly idPrefix: string;
  readonly heading: string;
  readonly description: string;
  readonly submitLabel: string;
  /** The name the field starts with (empty for create). */
  readonly initialTitle: string;
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  readonly onCancel: () => void;
  /** Creates, renames or duplicates; rejection keeps the dialog open with the reason. */
  readonly onSubmit: (title: string) => Promise<void>;
}

const CANCEL =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const SUBMIT =
  "rounded-(--radius) bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";

export function ProjectNameDialog(props: ProjectNameDialogProps) {
  const title = signal(props.initialTitle);
  const busy = signal(false);
  const error = signal<string | null>(null);
  let input: InputRef | null = null;

  const submit = async (): Promise<void> => {
    const name = title().trim();
    if (busy() || name === "") return;
    busy.set(true);
    error.set(null);
    try {
      await props.onSubmit(name);
    } catch (cause) {
      error.set(`${props.failurePrefix} ${errorMessage(cause)}`);
    } finally {
      busy.set(false);
    }
  };

  return (
    <ProjectDialogShell
      testID={`${props.idPrefix}-dialog`}
      accessibilityLabel={props.heading}
      heading={props.heading}
      description={props.description}
      error={error()}
      onCancel={() => props.onCancel()}
      onOpen={() => input?.focus()}
      actions={
        <>
          <Button
            testID={`${props.idPrefix}-cancel`}
            onPress={() => props.onCancel()}
            class={CANCEL}
          >
            <Text class="text-sm text-card-foreground">Cancel</Text>
          </Button>
          <Button
            testID={`${props.idPrefix}-submit`}
            onPress={() => void submit()}
            disabled={busy() || title().trim() === ""}
            class={SUBMIT}
          >
            <Text class="text-sm text-primary-foreground">{props.submitLabel}</Text>
          </Button>
        </>
      }
    >
      <View class="mt-4 gap-2">
        <Text class="text-sm font-medium text-popover-foreground">Name</Text>
        <Input
          ref={(node) => {
            input = node;
          }}
          testID={`${props.idPrefix}-title`}
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
    </ProjectDialogShell>
  );
}
