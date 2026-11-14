/**
 * The image node's composer: a chat-style prompt sheet attached under the
 * selected card, like the text node's. Its attachments are the node's image
 * inputs; the prompt and the image settings (model, aspect, resolution and
 * count) sit in the sheet's bottom row. Sending runs the mock image provider,
 * whose images land on the card itself.
 */
import { computed, signal, Text, token, View } from "nsh";
import { Button, Input, Popover, Select } from "nsh/base";
import { ArrowUp, ChevronDown, ImagePlus, Square, X } from "lucide";
import type { NodeDetail } from "@flow/native";
import { errorOf, inputUrl } from "../flow/composer-detail";
import type { ComposerState } from "../flow/composer-state";
import {
  IMAGE_ASPECTS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  type ImageAspect,
  imageModelLabel,
  isImageModel,
  type ImageResolution,
} from "../flow/node-kinds";
import { keepsWheel } from "../flow/page-chrome";
import { ComposerInputTile, TILE_SIZE } from "./ComposerInputTile";
import { ComposerModelSelect } from "./ComposerModelSelect";
import { Icon } from "./Icon";

/** The prompt's limit, as the text composer's. */
const PROMPT_LIMIT = 4000;
/** How many images one run may ask for, as the provider supports. */
const IMAGE_COUNTS: readonly number[] = [1, 2, 3, 4];
/** The round send button's size, and the close button's glyph, in points. */
const SEND_SIZE = 40;

export interface NodeComposerProps {
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

/** The prompt sheet of an image node, with its image inputs and send button. */
export function NodeComposer(props: NodeComposerProps) {
  // Inputs arrive with the detail reloads; a run appends result items only.
  const images = computed(() => props.detail.inputs.filter((input) => input.kind === "image"));
  const settingsOpen = signal(false);
  const prompt = (): string => props.state.prompt();
  // The mock provider rejects an empty prompt, so an empty field disables the
  // send button rather than recording a failure the user just saw.
  const sendable = (): boolean => prompt().trim() !== "";
  const settingsLabel = (): string => `${props.state.aspect()} / ${props.state.resolution()}`;

  const chooseAspect = (aspect: ImageAspect): void => {
    props.state.setAspect(aspect);
    settingsOpen.set(false);
  };

  const chooseResolution = (resolution: ImageResolution): void => {
    props.state.setResolution(resolution);
    settingsOpen.set(false);
  };

  return (
    <View
      testID="node-composer"
      class="absolute z-40 gap-2 rounded-2xl border border-border bg-card p-4 shadow-lg"
      style={{ left: props.left, top: props.top, width: props.width }}
    >
      <View class="flex-row items-start justify-between gap-2">
        <View class="flex-1 flex-row flex-wrap items-center gap-2">
          <Button
            testID="composer-image-button"
            accessibilityLabel="Add an image"
            onPress={props.onUpload}
            class="items-center justify-center rounded-(--radius) bg-secondary hover:bg-accent active:bg-muted focus:bg-accent"
            style={{ width: TILE_SIZE, height: TILE_SIZE }}
          >
            <Icon icon={ImagePlus} size={18} tint={() => token("secondary-foreground")} />
          </Button>
          <Each of={images()} key={(input) => input.id}>
            {(input) => (
              <ComposerInputTile
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
        placeholder="描述你想生成的画面..."
        multiline
        maxLength={PROMPT_LIMIT}
        submitBehavior="newline"
        onWheel={keepsWheel}
        class="min-h-24 rounded-md px-1 py-1 text-sm text-card-foreground placeholder:text-muted-foreground"
      />

      {errorOf(props.detail) === "" ? null : (
        <Text class="px-1 text-xs text-destructive">{errorOf(props.detail)}</Text>
      )}

      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-1 flex-row flex-wrap items-center gap-1 px-1">
          <ComposerModelSelect
            accessibilityLabel="Image model"
            value={props.state.imageModel()}
            label={imageModelLabel(props.state.imageModel())}
            models={IMAGE_MODELS}
            onChange={(id) => {
              if (isImageModel(id)) props.state.setImageModel(id);
            }}
          />
          {/* The core places it: above the chip, on the other side when only
              that one fits, and it closes on an outside press or Escape. */}
          <Popover
            open={settingsOpen()}
            onOpenChange={(event) => settingsOpen.set(event.open)}
            placement="top"
            align="start"
            offset={8}
            popupClass="rounded-xl border border-border bg-popover p-3 shadow-lg"
            popupStyle={{ width: Math.min(320, props.width - 16) }}
            trigger={
              <Button
                testID="composer-settings"
                accessibilityLabel="Image settings"
                class="flex-row items-center gap-0.5 rounded-md border border-border px-1.5 py-1 text-xs text-card-foreground hover:bg-accent active:bg-muted"
              >
                <Text class="text-xs">{settingsLabel()}</Text>
                <Icon icon={ChevronDown} size={12} tint={() => token("muted-foreground")} />
              </Button>
            }
          >
            <View testID="composer-settings-popover" class="gap-3">
              <View class="gap-1.5">
                <Text class="text-[11px] font-medium text-muted-foreground">比例</Text>
                <View class="flex-row gap-1">
                  {IMAGE_ASPECTS.map((aspect: ImageAspect) => (
                    <Button
                      testID={`composer-aspect-${aspect}`}
                      selected={props.state.aspect() === aspect}
                      onPress={() => chooseAspect(aspect)}
                      class="flex-1 items-center gap-1 rounded-md border border-border px-0.5 py-1.5 text-[9px] text-card-foreground active:bg-muted selected:border-muted-foreground selected:bg-muted"
                    >
                      <AspectGlyph aspect={aspect} />
                      <Text class="text-[9px] text-card-foreground">{aspect}</Text>
                    </Button>
                  ))}
                </View>
              </View>
              <View class="gap-1.5">
                <Text class="text-[11px] font-medium text-muted-foreground">清晰度</Text>
                <View class="flex-row gap-1">
                  {IMAGE_RESOLUTIONS.map((resolution: ImageResolution) => (
                    <Button
                      testID={`composer-resolution-${resolution.toLowerCase()}`}
                      selected={props.state.resolution() === resolution}
                      onPress={() => chooseResolution(resolution)}
                      class="flex-1 items-center rounded-md border border-border px-2 py-1 active:bg-muted selected:border-muted-foreground selected:bg-muted"
                    >
                      <Text class="text-xs text-card-foreground">{resolution}</Text>
                    </Button>
                  ))}
                </View>
              </View>
            </View>
          </Popover>
          <Select
            accessibilityLabel="Image count"
            value={String(props.state.count())}
            items={IMAGE_COUNTS.map((count) => ({ value: String(count), title: `×${count}` }))}
            onChange={(event) => {
              if (event.value !== null) props.state.setCountTo(Number(event.value));
            }}
            placement="top"
            align="start"
            offset={8}
            popupClass="rounded-xl border border-border bg-popover p-1 shadow-lg"
            itemClass="rounded-md px-2 py-1 text-xs text-popover-foreground focus:bg-accent selected:bg-muted"
            trigger={
              <Button
                testID="composer-count"
                accessibilityLabel="Image count"
                class="flex-row items-center gap-0.5 rounded-md border border-border px-1.5 py-1 text-xs text-card-foreground hover:bg-accent active:bg-muted"
              >
                <Text class="text-xs">×{props.state.count()}</Text>
                <Icon icon={ChevronDown} size={12} tint={() => token("muted-foreground")} />
              </Button>
            }
          />
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

/** The ratio's outline, as the design's aspect choices show it. */
function AspectGlyph(props: { readonly aspect: ImageAspect }) {
  const [width = 1, height = 1] = props.aspect.split(":").map(Number);
  const long = 14;
  const glyphWidth = width >= height ? long : Math.max(6, Math.round((long * width) / height));
  const glyphHeight = height >= width ? long : Math.max(6, Math.round((long * height) / width));
  return (
    <View
      class="rounded-[2px] border border-muted-foreground"
      style={{ width: glyphWidth, height: glyphHeight }}
    />
  );
}
