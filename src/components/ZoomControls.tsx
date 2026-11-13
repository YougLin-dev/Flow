import { Button, Input, Tooltip } from "nsh/base";
import { Map, Minus, Plus, Scan } from "lucide";
import { keymap, Text, token, View } from "nsh";
import { FIT_KEY, ZOOM_IN_KEY, ZOOM_OUT_KEY } from "../flow/bindings";
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
        tooltip={<ControlTip label="Zoom in" shortcut={keymap.label(ZOOM_IN_KEY)} />}
        onPress={props.onZoomIn}
        class={controlClass}
      >
        <Icon icon={Plus} size={14} tint={() => token("card-foreground")} />
      </Button>
      <Button
        testID="zoom-out"
        accessibilityLabel="Zoom out"
        tooltip={<ControlTip label="Zoom out" shortcut={keymap.label(ZOOM_OUT_KEY)} />}
        onPress={props.onZoomOut}
        class={controlClass}
      >
        <Icon icon={Minus} size={14} tint={() => token("card-foreground")} />
      </Button>
      <Button
        testID="zoom-fit"
        accessibilityLabel="Fit"
        tooltip={<ControlTip label="Fit" shortcut={keymap.label(FIT_KEY)} />}
        onPress={props.onFit}
        class={controlClass}
      >
        <Icon icon={Scan} size={14} tint={() => token("card-foreground")} />
      </Button>
      {props.onToggleMinimap ? (
        <Button
          testID="minimap-toggle"
          accessibilityLabel={props.minimapOpen ? "Hide minimap" : "Show minimap"}
          tooltip={<ControlTip label={props.minimapOpen ? "Hide minimap" : "Show minimap"} />}
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

interface ControlTipProps {
  readonly label: string;
  /** The platform's label for the control's shortcut, when it has one. */
  readonly shortcut?: string | undefined;
}

/**
 * A control's hover hint, in the same pill as a port's: the label and, beside
 * it, the shortcut that does the same. The bubble sits to the control's right,
 * clear of the rest of the column, and follows the pointer at once rather than
 * after the native delay.
 */
function ControlTip(props: ControlTipProps) {
  return (
    <Tooltip
      placement="right"
      delay={0}
      class="rounded-md border border-border bg-secondary px-2.5 py-1"
    >
      <View class="flex-row items-center gap-2">
        <Text class="text-[11px] font-medium text-secondary-foreground">{props.label}</Text>
        {props.shortcut ? (
          <Text class="text-[11px] text-muted-foreground">{props.shortcut}</Text>
        ) : null}
      </View>
    </Tooltip>
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
