/**
 * The text node's composer: a chat-style prompt sheet attached under the
 * selected card. Its attachments are the node's image inputs, whether they
 * come from upstream image cards or local uploads; sending runs the mock text
 * provider, whose text lands on the card itself. The sheet never shows the
 * output, so the card stays the one place the generated text lives.
 */
import { computed, Image as NshImage, Text, token, View } from "nsh";
import { Button, Input } from "nsh/base";
import { ArrowUp, ChevronDown, Image as ImageIcon, ImagePlus, Square, X } from "lucide";
import type { InputItemSummary, NodeDetail } from "@flow/native";
import { errorOf, inputUrl } from "../flow/composer-detail";
import type { ComposerState } from "../flow/composer-state";
import { keepsWheel } from "../flow/page-chrome";
import { Icon } from "./Icon";

/** The prompt's limit, shown beside the field as a live counter. */
const PROMPT_LIMIT = 10000;
/** The model the mock text provider stands in for. */
const MODEL_LABEL = "DeepSeek V4.1 Flash";
/** The attach row's tile size and the round send button's, in points. */
const ATTACH_SIZE = 44;
const SEND_SIZE = 40;

export interface TextComposerProps {
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
}

/** The prompt sheet of a text node, with its image inputs and send button. */
export function TextComposer(props: TextComposerProps) {
  // Inputs arrive with the detail reloads; a run appends result items only.
  const images = computed(() => props.detail.inputs.filter((input) => input.kind === "image"));
  const prompt = (): string => props.state.prompt();
  const counter = (): string => `${prompt().length}/${PROMPT_LIMIT}`;
  // The mock provider rejects an empty prompt, so an empty field disables
  // the send button rather than recording a failure the user just saw.
  const sendable = (): boolean => prompt().trim() !== "";

  return (
    <View
      testID="node-composer"
      class="absolute z-20 gap-2 rounded-2xl border border-border bg-card p-4 shadow-lg"
      style={{ left: props.left, top: props.top, width: props.width }}
    >
      <View class="flex-row items-start justify-between gap-2">
        <View class="flex-1 flex-row flex-wrap items-center gap-2">
          <Button
            testID="composer-image-button"
            accessibilityLabel="Add an image"
            onPress={props.onUpload}
            class="items-center justify-center rounded-(--radius) bg-secondary hover:bg-accent active:bg-muted focus:bg-accent"
            style={{ width: ATTACH_SIZE, height: ATTACH_SIZE }}
          >
            <Icon icon={ImagePlus} size={18} tint={() => token("secondary-foreground")} />
          </Button>
          <Each of={images()} key={(input) => input.id}>
            {(input) => (
              <InputTile
                input={input}
                url={() => inputUrl(input(), props.assetUrls())}
                onRemove={props.onRemoveInput}
              />
            )}
          </Each>
        </View>
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
        placeholder="描述你想生成的文本内容..."
        multiline
        maxLength={PROMPT_LIMIT}
        submitBehavior="newline"
        onWheel={keepsWheel}
        class="min-h-24 rounded-md px-1 py-1 text-sm text-card-foreground placeholder:text-muted-foreground"
      />

      <View class="flex-row justify-end px-1">
        <Text class="text-[11px] tabular-nums text-muted-foreground">{counter()}</Text>
      </View>

      {errorOf(props.detail) === "" ? null : (
        <Text class="px-1 text-xs text-destructive">{errorOf(props.detail)}</Text>
      )}

      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1 px-1">
          <Text class="text-sm text-card-foreground">{MODEL_LABEL}</Text>
          <Icon icon={ChevronDown} size={14} tint={() => token("muted-foreground")} />
        </View>
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
            disabled={!sendable()}
            onPress={props.onRun}
            class="items-center justify-center rounded-full bg-foreground hover:opacity-90 active:opacity-80 disabled:opacity-40"
            style={{ width: SEND_SIZE, height: SEND_SIZE }}
          >
            <Icon icon={ArrowUp} size={18} strokeWidth={2.4} tint={() => token("background")} />
          </Button>
        )}
      </View>
    </View>
  );
}

interface InputTileProps {
  /** The row's item accessor: a tile follows edits and reorders. */
  readonly input: () => InputItemSummary;
  readonly url: () => string | null;
  readonly onRemove: (id: string) => void;
}

/** One attached image: its thumbnail with a remove control in the corner. */
function InputTile(props: InputTileProps) {
  return (
    <View
      testID={`composer-input-${props.input().id}`}
      class="overflow-hidden rounded-(--radius) border border-border bg-muted"
      style={{ position: "relative", width: ATTACH_SIZE, height: ATTACH_SIZE }}
    >
      <If when={props.url()}>
        {(url) => (
          <NshImage
            src={url()}
            style={{ width: ATTACH_SIZE, height: ATTACH_SIZE, objectFit: "cover" }}
          />
        )}
      </If>
      <If when={props.url() === null}>
        <View class="h-full w-full items-center justify-center">
          <Icon icon={ImageIcon} size={16} tint={() => token("muted-foreground")} />
        </View>
      </If>
      <Button
        accessibilityLabel="Remove image input"
        onPress={() => props.onRemove(props.input().id)}
        class="absolute right-0 top-0 items-center justify-center rounded-full bg-background active:bg-muted"
        style={{ width: 18, height: 18 }}
      >
        <Icon icon={X} size={10} tint={() => token("muted-foreground")} />
      </Button>
    </View>
  );
}

/** The failure line of the newest batch, or "" while the node has not failed. */
