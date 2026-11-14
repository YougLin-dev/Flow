/** The composer sheet's bottom row: variant controls and the send/cancel button. */
import { type JSX, token, View } from "nsh";
import { Button } from "nsh/base";
import { ArrowUp, Square } from "lucide";
import { Icon } from "../primitives";

/** The round send button's size in points. */
const SEND_SIZE = 40;

export interface ComposerFooterProps {
  /** The variant controls' wrapper class; the image composer's row grows. */
  readonly leftClass: string;
  readonly sendable: () => boolean;
  readonly running: () => boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly children?: JSX.Element;
}

/** The footer every composer sheet shares. */
export function ComposerFooter(props: ComposerFooterProps) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <View class={props.leftClass}>{props.children}</View>
      {props.running() ? (
        <Button
          testID="composer-cancel"
          accessibilityLabel="Cancel run"
          onPress={props.onCancel}
          class="items-center justify-center rounded-full bg-secondary hover:bg-accent active:bg-muted"
          style={{ width: SEND_SIZE, height: SEND_SIZE }}
        >
          <Icon icon={Square} size={13} tint={() => token("secondary-foreground")} />
        </Button>
      ) : (
        <Button
          testID="composer-run"
          accessibilityLabel="Send prompt"
          disabled={!props.sendable()}
          onPress={props.onRun}
          class="items-center justify-center rounded-full bg-foreground hover:opacity-90 active:opacity-80 disabled:opacity-40"
          style={{ width: SEND_SIZE, height: SEND_SIZE }}
        >
          <Icon icon={ArrowUp} size={18} strokeWidth={2.4} tint={() => token("background")} />
        </Button>
      )}
    </View>
  );
}
