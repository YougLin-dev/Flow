/**
 * The chat-style prompt sheet both composers mount: attachments, the prompt
 * field, the failure line and the footer. Text and image variants configure
 * the field, the counter and the footer controls; the shell is one recipe.
 */
import { type JSX, Text, token, View } from "nsh";
import { Button, Input } from "nsh/base";
import { X } from "lucide";
import type { NodeDetail } from "../../flow/shared";
import { errorOf } from "../../flow/composer-detail";
import type { ComposerState } from "../../flow/composer-state";
import { keepsWheel } from "../../flow/shared";
import { Icon } from "../primitives";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFooter } from "./ComposerFooter";

export interface ComposerSheetProps {
  readonly detail: NodeDetail;
  readonly state: ComposerState;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly assetUrls: () => Readonly<Record<string, string>>;
  readonly running: () => boolean;
  readonly onClose: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onRemoveInput: (id: string) => void;
  readonly onUpload: () => void;
  /** The prompt's limit, shown beside the field as a live counter. */
  readonly promptLimit: number;
  readonly placeholder: string;
  /** The text variant's live counter; the image composer has none. */
  readonly counter?: () => string;
  /** The variant controls' wrapper class in the footer. */
  readonly footerClass: string;
  /** The variant's model/settings controls, before the send button. */
  readonly footer?: JSX.Element;
}

/** The props a composer variant passes through to the shared sheet. */
export type ComposerVariantProps = Omit<
  ComposerSheetProps,
  "promptLimit" | "placeholder" | "counter" | "footerClass" | "footer"
>;

/** The shared composer sheet both node kinds mount. */
export function ComposerSheet(props: ComposerSheetProps) {
  const prompt = (): string => props.state.prompt();
  // The mock provider rejects an empty prompt, so an empty field disables
  // the send button rather than recording a failure the user just saw.
  const sendable = (): boolean => prompt().trim() !== "";

  return (
    <View
      testID="node-composer"
      class="absolute z-40 gap-2 rounded-2xl border border-border bg-card p-4 shadow-lg"
      style={{ left: props.left, top: props.top, width: props.width }}
    >
      <View class="flex-row items-start justify-between gap-2">
        <ComposerAttachments
          detail={props.detail}
          assetUrls={props.assetUrls}
          onRemove={props.onRemoveInput}
          onUpload={props.onUpload}
        />
        <Button
          testID="composer-close"
          accessibilityLabel="Close composer"
          onPress={props.onClose}
          class="items-center justify-center rounded-full p-1.5 hover:bg-accent active:bg-muted"
        >
          <Icon icon={X} size={16} tint={() => token("muted-foreground")} />
        </Button>
      </View>

      <Input
        testID="composer-prompt"
        accessibilityLabel="Prompt"
        value={prompt()}
        onChange={(event) => props.state.setPrompt(event.value)}
        placeholder={props.placeholder}
        multiline
        maxLength={props.promptLimit}
        submitBehavior="newline"
        onWheel={keepsWheel}
        class="min-h-24 rounded-md px-1 py-1 text-sm text-card-foreground placeholder:text-muted-foreground"
      />

      {props.counter ? (
        <View class="flex-row justify-end px-1">
          <Text testID="composer-counter" class="text-[11px] tabular-nums text-muted-foreground">
            {props.counter()}
          </Text>
        </View>
      ) : null}

      {errorOf(props.detail) === "" ? null : (
        <Text class="px-1 text-xs text-destructive">{errorOf(props.detail)}</Text>
      )}

      <ComposerFooter
        leftClass={props.footerClass}
        sendable={sendable}
        running={props.running}
        onRun={props.onRun}
        onCancel={props.onCancel}
      >
        {props.footer}
      </ComposerFooter>
    </View>
  );
}
