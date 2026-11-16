/**
 * The shared surface of the project dialogs: the semantic `Dialog` with its
 * heading, description, error line and actions row. It owns dismissal only —
 * Escape, the backdrop, Cancel and the runner's key binding — never the form
 * state, so every dialog stays dismissible while its write is in flight.
 */
import { type JSX, keymap, Text, token, View } from "nsh";
import { Dialog } from "nsh/base";

export interface ProjectDialogShellProps {
  readonly testID: string;
  readonly accessibilityLabel: string;
  readonly heading: string;
  readonly description: string;
  /** How screen readers announce it; an irreversible confirmation is an alert dialog. */
  readonly role?: "dialog" | "alertdialog" | undefined;
  /** The failure to show in place, or null. */
  readonly error: string | null;
  /** Dismissed: Escape, the backdrop or Cancel. */
  readonly onCancel: () => void;
  /** Runs after the dialog opened; a dialog with a field focuses it here. */
  readonly onOpen?: (() => void) | undefined;
  /** The fields between the description and the actions. */
  readonly children?: JSX.Element;
  /** The action buttons at the bottom end. */
  readonly actions: JSX.Element;
}

export function ProjectDialogShell(props: ProjectDialogShellProps) {
  // The native Dialog dismisses itself; this binding is the keyboard path
  // and the headless runner's, which does not deliver Escape to it.
  keymap.bind("escape", () => props.onCancel(), { when: "always" });

  return (
    <Dialog
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityDescription={props.description}
      role={props.role ?? "dialog"}
      animation="fade"
      closeOnEscape
      closeOnBackdropPress
      onCancel={() => props.onCancel()}
      onOpen={() => props.onOpen?.()}
      class="mx-auto mt-24 w-11/12 max-w-md rounded-(--radius) border border-border bg-popover p-4 shadow-lg"
      backdropStyle={{ backgroundColor: token("background"), opacity: 0.7 }}
    >
      <View class="gap-1">
        <Text class="text-base font-semibold text-popover-foreground">{props.heading}</Text>
        <Text class="text-sm text-muted-foreground">{props.description}</Text>
      </View>
      {props.children}
      {props.error ? <Text class="mt-2 text-sm text-destructive">{props.error}</Text> : null}
      <View class="mt-4 flex-row justify-end gap-2">{props.actions}</View>
    </Dialog>
  );
}
