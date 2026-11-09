import { Button } from "nsh/base";
import { Minus, Plus } from "lucide";
import { Text, token, View } from "nsh";
import { Icon } from "./Icon";

export interface ZoomControlsProps {
  /** The camera's scale in percent, or null before the first fit. */
  zoom: number | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

const controlClass =
  "min-w-9 items-center justify-center rounded-md px-2 py-1.5 active:bg-muted focus:bg-accent";

/** The zoom controls floating at the canvas' top-right corner. */
export function ZoomControls(props: ZoomControlsProps) {
  return (
    <View class="absolute top-4 right-4 flex-row items-center gap-1 rounded-(--radius) border border-border bg-card p-1">
      <Button accessibilityLabel="Zoom in" onPress={props.onZoomIn} class={controlClass}>
        <Icon icon={Plus} size={16} tint={() => token("card-foreground")} />
      </Button>
      <Text class="min-w-14 text-center text-sm tabular-nums text-card-foreground">
        {props.zoom === null ? "—" : `${props.zoom}%`}
      </Text>
      <Button accessibilityLabel="Zoom out" onPress={props.onZoomOut} class={controlClass}>
        <Icon icon={Minus} size={16} tint={() => token("card-foreground")} />
      </Button>
      <Button onPress={props.onFit} class="rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent">
        <Text class="text-sm text-card-foreground">Fit</Text>
      </Button>
    </View>
  );
}
