import { Button, Input } from "nsh/base";
import { Map, Minus, Plus, Scan } from "lucide";
import { token, View } from "nsh";
import { Icon } from "./Icon";

export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Whether the minimap is shown; omitted on a platform without one. */
  minimapOpen?: boolean | undefined;
  /** Toggles the minimap; omitted on a platform without one. */
  onToggleMinimap?: (() => void) | undefined;
}

const controlClass =
  "h-6 w-6 items-center justify-center rounded-md active:bg-muted focus:bg-accent";

/** The canvas controls, in a compact column at the minimap's left. */
export function ZoomControls(props: ZoomControlsProps) {
  return (
    <View class="flex-col items-center gap-0.5 rounded-(--radius) border border-border bg-card p-1">
      <Button
        testID="zoom-in"
        accessibilityLabel="Zoom in"
        onPress={props.onZoomIn}
        class={controlClass}
      >
        <Icon icon={Plus} size={14} tint={() => token("card-foreground")} />
      </Button>
      <Button
        testID="zoom-out"
        accessibilityLabel="Zoom out"
        onPress={props.onZoomOut}
        class={controlClass}
      >
        <Icon icon={Minus} size={14} tint={() => token("card-foreground")} />
      </Button>
      <Button testID="zoom-fit" accessibilityLabel="Fit" onPress={props.onFit} class={controlClass}>
        <Icon icon={Scan} size={14} tint={() => token("card-foreground")} />
      </Button>
      {props.onToggleMinimap ? (
        <Button
          testID="minimap-toggle"
          accessibilityLabel={props.minimapOpen ? "Hide minimap" : "Show minimap"}
          onPress={props.onToggleMinimap}
          class={controlClass}
        >
          <Icon
            icon={Map}
            size={14}
            tint={() => token(props.minimapOpen ? "card-foreground" : "muted-foreground")}
          />
        </Button>
      ) : null}
    </View>
  );
}

/** The invisible input a test reads the camera scale from, when it asks for it. */
export function ZoomProbe(props: { readonly value: number | null }) {
  return (
    <Input
      testID="zoom-probe"
      readonly
      value={props.value === null ? "" : String(props.value)}
      style={{ position: "absolute", left: 8, top: 8, width: 1, height: 1, opacity: 0 }}
    />
  );
}
