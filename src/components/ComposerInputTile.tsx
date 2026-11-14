/**
 * One image attached to a composer: its thumbnail with a remove control in
 * the corner. The text and image composers both show their image inputs as
 * these tiles in the sheet's attach row.
 */
import { Image as NshImage, token, View } from "nsh";
import { Button } from "nsh/base";
import { Image as ImageIcon, X } from "lucide";
import type { InputItemSummary } from "@flow/native";
import { Icon } from "./Icon";

/** The tile's size in points, matching the attach row's add button. */
export const TILE_SIZE = 44;

export interface ComposerInputTileProps {
  /** The row's item accessor: a tile follows edits and reorders. */
  readonly input: () => InputItemSummary;
  readonly url: () => string | null;
  readonly onRemove: (id: string) => void;
}

export function ComposerInputTile(props: ComposerInputTileProps) {
  return (
    <View
      testID={`composer-input-${props.input().id}`}
      class="overflow-hidden rounded-(--radius) border border-border bg-muted"
      style={{ position: "relative", width: TILE_SIZE, height: TILE_SIZE }}
    >
      <If when={props.url()}>
        {(url) => (
          <NshImage
            src={url()}
            style={{ width: TILE_SIZE, height: TILE_SIZE, objectFit: "cover" }}
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
