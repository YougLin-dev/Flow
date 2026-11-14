/**
 * The image node's composer: the shared prompt sheet configured with the image
 * model and the image settings (aspect, resolution and count) in the footer.
 * Its attachments are the node's image inputs; sending runs the mock image
 * provider, whose images land on the card itself.
 */
import { signal, Text, token, View } from "nsh";
import { Button, Popover, Select } from "nsh/base";
import { ChevronDown } from "lucide";
import {
  IMAGE_ASPECTS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  type ImageAspect,
  imageModelLabel,
  isImageModel,
  type ImageResolution,
} from "../../flow/nodes";
import { ComposerModelSelect } from "./ComposerModelSelect";
import { Icon } from "../primitives";
import { type ComposerVariantProps, ComposerSheet } from "./ComposerSheet";

/** The prompt's limit, as the text composer's. */
const PROMPT_LIMIT = 4000;
/** How many images one run may ask for, as the provider supports. */
const IMAGE_COUNTS: readonly number[] = [1, 2, 3, 4];

export type ImageComposerProps = ComposerVariantProps;

/** The prompt sheet of an image node, with its image inputs and send button. */
export function ImageComposer(props: ImageComposerProps) {
  const settingsOpen = signal(false);
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
    <ComposerSheet
      detail={props.detail}
      state={props.state}
      left={props.left}
      top={props.top}
      width={props.width}
      assetUrls={props.assetUrls}
      running={props.running}
      onClose={props.onClose}
      onRun={props.onRun}
      onCancel={props.onCancel}
      onRemoveInput={props.onRemoveInput}
      onUpload={props.onUpload}
      promptLimit={PROMPT_LIMIT}
      placeholder="描述你想生成的画面..."
      footerClass="flex-1 flex-row flex-wrap items-center gap-1 px-1"
      footer={
        <>
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
        </>
      }
    />
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
