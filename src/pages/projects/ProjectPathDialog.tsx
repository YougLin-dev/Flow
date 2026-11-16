/**
 * A project dialog with one path field: import, backup and restore share the
 * form, the busy state and the in-place failure. NSH has no folder picker and
 * the file picker hands back bytes rather than a path, so every path is typed
 * directly. Dismissal never waits for the store.
 */
import { signal, Text, View, type InputRef } from "nsh";
import { Button, Input } from "nsh/base";
import { errorMessage } from "../../flow/projects";
import { ProjectDialogShell } from "./ProjectDialogShell";

export interface ProjectPathDialogProps {
  /** The dialog id prefix; its dialog, field, submit and cancel append one. */
  readonly idPrefix: string;
  readonly accessibilityLabel: string;
  readonly heading: string;
  readonly description: string;
  readonly fieldLabel: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  /** The copy before a stored error, shared with the list's late report. */
  readonly failurePrefix: string;
  /** An overwrite or deletion is an alert dialog. */
  readonly role?: "dialog" | "alertdialog" | undefined;
  /** Uses the destructive action style. */
  readonly destructive?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (path: string) => Promise<void>;
}

const CANCEL =
  "rounded-(--radius) border border-border bg-card px-3 py-1.5 text-sm text-card-foreground hover:bg-muted active:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const PRIMARY =
  "rounded-(--radius) bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";
const DESTRUCTIVE =
  "rounded-(--radius) bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-active disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring";

export function ProjectPathDialog(props: ProjectPathDialogProps) {
  const path = signal("");
  const busy = signal(false);
  const error = signal<string | null>(null);
  let input: InputRef | null = null;

  const submit = async (): Promise<void> => {
    const value = path().trim();
    if (busy() || value === "") return;
    busy.set(true);
    error.set(null);
    try {
      await props.onSubmit(value);
    } catch (cause) {
      error.set(`${props.failurePrefix} ${errorMessage(cause)}`);
    } finally {
      busy.set(false);
    }
  };

  return (
    <ProjectDialogShell
      testID={`${props.idPrefix}-dialog`}
      accessibilityLabel={props.accessibilityLabel}
      heading={props.heading}
      description={props.description}
      role={props.role}
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
            disabled={busy() || path().trim() === ""}
            class={props.destructive ? DESTRUCTIVE : PRIMARY}
          >
            <Text
              class={
                props.destructive
                  ? "text-sm text-destructive-foreground"
                  : "text-sm text-primary-foreground"
              }
            >
              {props.submitLabel}
            </Text>
          </Button>
        </>
      }
    >
      <View class="mt-4 gap-2">
        <Text class="text-sm font-medium text-popover-foreground">{props.fieldLabel}</Text>
        <Input
          ref={(node) => {
            input = node;
          }}
          testID={`${props.idPrefix}-path`}
          accessibilityLabel={props.inputLabel}
          value={path()}
          onChange={(event) => {
            path.set(event.value);
            error.set(null);
          }}
          onSubmit={() => void submit()}
          placeholder={props.placeholder}
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
