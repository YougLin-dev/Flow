/**
 * The hovered port's tooltip: a compact pill with the parameter's name (or a
 * group's type and side) that waits for the pointer to rest a moment and sits
 * above the icon — cards connect left to right, so the sides belong to the
 * connectors. `placement` picks another side; a bubble that would leave the
 * stage flips to the opposite side and clamps inside it. The canvas's pointer
 * surface owns hover, so the bubble is drawn from the controller's hovered
 * port rather than a native tooltip on the port view.
 */
import { cleanup, computed, effect, signal, Text, View } from "nsh";
import type { CanvasCamera, CameraSize } from "../flow/camera";
import type { CanvasController } from "../flow/canvas-controller";
import type { Point, PortSide } from "../flow/connection";
import { nodeKind } from "../flow/node-kinds";
import { portVisual } from "../flow/port-visuals";
import type { FlowScene } from "../flow/scene";
import { tipWidth, tooltipBox, type TipPlacement } from "../flow/tooltip";

/** The bubble's size, padding, pointer-rest delay and spacing, in points. */
const TIP_HEIGHT = 26;
const TIP_PADDING = 11;
const TIP_GAP = 14;
const TIP_MARGIN = 8;
const TIP_DELAY_MS = 150;

interface Tip {
  readonly key: string;
  readonly title: string;
  /** The port icon's world centre. */
  readonly center: Point;
  readonly side: PortSide;
}

export interface PortTooltipProps {
  readonly scene: FlowScene;
  readonly camera: CanvasCamera;
  readonly controller: CanvasController;
  readonly stage: () => CameraSize;
  /** The side of the icon the bubble prefers; the default is above. */
  readonly placement?: TipPlacement | undefined;
}

export function PortTooltip(props: PortTooltipProps) {
  // The bubble is anchored to the icon, so it only rebuilds when the hovered
  // port's identity changes, not on every pointer move within it: the
  // identity keys are cheap strings, the records carry the moving pointer.
  let cached: Tip | null = null;
  const tip = (): Tip | null => {
    const identity = props.controller.hoveredPortKey();
    const groupIdentity = identity === null ? props.controller.hoveredGroupKey() : null;
    const key = identity ?? (groupIdentity === null ? null : `group:${groupIdentity}`);
    if (key === null) {
      cached = null;
      return null;
    }
    if (cached !== null && cached.key === key) return cached;
    cached = readTip(props, key);
    return cached;
  };

  const shown = signal(false);
  // A title's real pill width, measured from its layout. The first frame
  // positions with an estimate and stays hidden until the measurement lands,
  // so the side padding is the same for every label instead of growing with
  // a character-count estimate's error.
  const widths = new Map<string, number>();
  const measuredTick = signal(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = "";
  effect(() => {
    const current = tip();
    const key = current?.key ?? "";
    if (key === lastKey) return;
    lastKey = key;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    shown.set(false);
    if (current === null) return;
    timer = setTimeout(() => {
      timer = null;
      shown.set(true);
    }, TIP_DELAY_MS);
  });
  cleanup(() => {
    if (timer !== null) clearTimeout(timer);
  });

  // Everything reactive is read at the component's tracking scope: the
  // bubble's <If> child runs untracked, and the branch is only made again
  // when the condition flips, so the child reads this value through its
  // reactive accessor rather than capturing it once. The measurement then
  // reaches the bubble's style and text after the first layout pass.
  const view = computed((): TipView | null => {
    const current = shown() ? tip() : null;
    if (current === null) return null;
    measuredTick();
    const measured = widths.get(current.title) ?? null;
    const width = measured ?? tipWidth(current.title);
    const screen = props.camera.toScreen(current.center.x, current.center.y);
    const box = tooltipBox({
      center: screen,
      width,
      height: TIP_HEIGHT,
      stage: props.stage(),
      portSide: current.side,
      placement: props.placement ?? "above",
      gap: TIP_GAP,
      margin: TIP_MARGIN,
    });
    return { tip: current, measured: measured !== null, box };
  });

  return (
    <If when={view()}>
      {(value) => (
        <View
          class="absolute rounded-md border border-border bg-secondary"
          style={{
            left: value()?.box.left ?? 0,
            top: value()?.box.top ?? 0,
            height: TIP_HEIGHT,
            paddingHorizontal: TIP_PADDING,
            // Hidden for the single frame before its real width is known.
            opacity: value()?.measured ? 1 : 0,
            pointerEvents: "none",
          }}
          onLayout={(event) => {
            const actual = event.bounds.size.width;
            const current = value();
            if (actual <= 0 || current === null) return;
            const known = widths.get(current.tip.title);
            if (known !== undefined && Math.abs(actual - known) < 0.5) return;
            widths.set(current.tip.title, actual);
            measuredTick.set(measuredTick() + 1);
          }}
        >
          <Text
            class="text-[11px] font-medium text-secondary-foreground"
            style={{
              height: TIP_HEIGHT,
              textAlign: "center",
              textAlignVertical: "center",
              numberOfLines: 1,
            }}
          >
            {value()?.tip.title ?? ""}
          </Text>
        </View>
      )}
    </If>
  );
}

/** What the bubble shows once a title has been measured (or estimated). */
interface TipView {
  readonly tip: Tip;
  readonly measured: boolean;
  readonly box: ReturnType<typeof tooltipBox>;
}

function readTip(props: PortTooltipProps, key: string): Tip | null {
  const port = props.controller.hoveredPort();
  if (port !== null) {
    const kind = props.scene.kindOf(port.nodeId);
    if (kind === null) return null;
    const spec = nodeKind(kind);
    const schema =
      port.side === "in"
        ? spec.inputs.find((candidate) => candidate.id === port.portId)
        : spec.outputs.find((candidate) => candidate.id === port.portId);
    if (!schema) return null;
    return {
      key,
      title: schema.name,
      center: port.center,
      side: port.side,
    };
  }
  const group = props.controller.hoveredGroup();
  if (group !== null) {
    // The group port belongs to the selection frame: a selection that lost
    // its frame (one card left, or a clear) retires the bubble with it,
    // even before the next pointer event clears the hover.
    if (!props.controller.multiFrame()) return null;
    const label = portVisual(group.portKind).label;
    return {
      key,
      title: `${label} ${group.side === "in" ? "inputs" : "outputs"}`,
      center: group.center,
      side: group.side,
    };
  }
  return null;
}
