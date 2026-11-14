/** The composer sheet's add-image button and the node's image inputs. */
import { computed, token, View } from "nsh";
import { Button } from "nsh/base";
import { ImagePlus } from "lucide";
import type { NodeDetail } from "../../flow/shared";
import { inputUrl } from "../../flow/composer-detail";
import { ComposerInputTile, TILE_SIZE } from "../ComposerInputTile";
import { Icon } from "../primitives";

export interface ComposerAttachmentsProps {
  readonly detail: NodeDetail;
  readonly assetUrls: () => Readonly<Record<string, string>>;
  readonly onRemove: (id: string) => void;
  readonly onUpload: () => void;
}

/** The attachments row every composer sheet shares. */
export function ComposerAttachments(props: ComposerAttachmentsProps) {
  // Inputs arrive with the detail reloads; a run appends result items only.
  const images = computed(() => props.detail.inputs.filter((input) => input.kind === "image"));

  return (
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
            onRemove={props.onRemove}
          />
        )}
      </Each>
    </View>
  );
}
