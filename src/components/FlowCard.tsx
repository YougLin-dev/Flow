/**
 * One node card on the native canvas: its title and status above the card,
 * the body inside it and one typed port on each declared parameter. The
 * card's root carries its world position, and its chrome is laid out in
 * card-local points, so a drag moves one style instead of every geometry
 * derived style (see `flow/card-geometry.ts`); its document text is read
 * through equality-gated values (`flow/card-content.ts`), so a viewport
 * refresh that carries the same card wakes no binding. Its pixel values
 * scale with the camera through the world view.
 */
import { computed, host, Image, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import type { NodeSummary } from "@flow/native";
import { Port } from "./Port";
import { portKey, type PortHover } from "../flow/canvas-controller";
import { CardContent } from "../flow/card-content";
import { CardGeometry, type CardSize, cardLocalLayout } from "../flow/card-geometry";
import { CARD_TITLE_HEIGHT } from "../flow/card-layout";
import { type BoxGeometry, PORT_CENTER_GAP, portOffset } from "../flow/connection";
import { type FlowAccent, nodeKind } from "../flow/node-kinds";
import { previewCell } from "../flow/preview-grid";
import type { PreviewView } from "../flow/scene";

/** One image load or failure, reported for the host image regression. */
export interface CardImageEvent {
  readonly nodeId: string;
  readonly kind: "load" | "error";
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly message: string;
}

export interface FlowCardProps {
  readonly node: () => NodeSummary;
  /** The card's document id; the hovered port matches against it. */
  readonly nodeId: string;
  /** The kind's port schema; a card's kind never changes for its row id. */
  readonly kind: string;
  readonly rect: () => BoxGeometry | null;
  /** The card's draw order: selected cards sit above every other card. */
  readonly zIndex: () => number;
  readonly preview: () => PreviewView | null;
  readonly selected: () => boolean;
  /** True while a marquee in progress covers this card. */
  readonly previewed: () => boolean;
  /** True while a multi-card frame surrounds this selected card. */
  readonly framed: () => boolean;
  readonly hovered: () => boolean;
  /** The port whose icon follows the pointer, if it belongs to this card. */
  readonly hoveredPort: () => PortHover | null;
  /** The hovered port's identity; stable while the pointer moves over it. */
  readonly hoveredPortKey: () => string | null;
  /** True while this card has an edge on either side. */
  readonly connected: () => boolean;
  /** The camera scale: below a readable size, idle ports stay out of the tree. */
  readonly zoom: () => number;
  /** True while a pulled connector is snapped to this card. */
  readonly target: () => boolean;
  /** False while the card lies wholly outside the camera's view. */
  readonly visible: () => boolean;
  /** The test-only image observation path; normal rendering has no hook. */
  readonly imageEvent?: ((event: CardImageEvent) => void) | undefined;
}

const ACCENT_BG: Record<FlowAccent, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

/** The body inset inside the card. */
const BODY_INSET = 16;
/** The selection ring's width, and its radius around the card's `rounded-2xl`
 * corner, so the ring stays concentric with the card. */
const SELECTION_RING = 2;
const SELECTION_RING_RADIUS = 18;
/** Below this on-screen card height, idle connected ports are not mounted. */
const PORT_MIN_SCREEN_HEIGHT = 56;

const ZERO_POINT = { x: 0, y: 0 };
const ZERO_SIZE: CardSize = { width: 0, height: 0 };

export function FlowCard(props: FlowCardProps) {
  // The rectangle arrives whole on every drag move; the position and size
  // memos keep each chrome style subscribed to only the fields it reads.
  const geometry = new CardGeometry(() => props.rect());
  // Both cards' records and their stacking are replaced by every viewport
  // read; the gated values keep an unchanged card from waking any binding.
  const content = new CardContent(() => props.node());
  const zIndex = computed(() => props.zIndex());
  // A value-gated boolean: the card's style wakes when it starts or stops
  // showing, not on every camera tick.
  const shown = computed(() => props.visible());
  const pos = () => geometry.position() ?? ZERO_POINT;
  const size = () => geometry.size() ?? ZERO_SIZE;
  const layout = () => cardLocalLayout(size());

  const accent = content.accent;
  const marked = computed(() => props.selected() || props.previewed());
  // A marked card's border merges into its body, so the ring outside is its
  // one outline instead of a third gray band; only a snapped connector
  // recolors the border.
  const borderColor = computed(() => {
    if (props.target()) return token("chart-1");
    return marked() ? token("card") : token("border");
  });
  const body = content.body;
  const status = content.status;
  const statusText = content.statusText;
  const lineCount = () => Math.max(1, Math.floor((size().height - BODY_INSET * 2) / 19));
  const spec = nodeKind(props.kind);
  // Ports stay out of the tree for cards nobody is looking at: an idle board
  // pays no per-port views. A framed selection keeps them only while they are
  // readable on screen; at an overview zoom the frame's group ports are the
  // handles. A single selection, hover and a snapped connector always show.
  const readable = () => size().height * props.zoom() >= PORT_MIN_SCREEN_HEIGHT;
  const portsShown = computed(
    () =>
      (props.selected() && (!props.framed() || readable())) ||
      props.hovered() ||
      props.target() ||
      (props.connected() && readable()),
  );
  /** A port icon's card-local centre, just outside the matching border. */
  const portCenter = (
    side: "in" | "out",
    index: number,
    count: number,
  ): { x: number; y: number } => ({
    x: side === "in" ? -PORT_CENTER_GAP : size().width + PORT_CENTER_GAP,
    y: portOffset(index, count, size().height),
  });
  /** The pointer's card-local point while this card's port is hovered. */
  const portFollow = (side: "in" | "out", portId: string): { x: number; y: number } | null => {
    // Read the identity before the record: every port subscribes to the
    // identity, but only the hovered one reads the per-move pointer point.
    if (props.hoveredPortKey() !== portKey(props.nodeId, side, portId)) return null;
    const hover = props.hoveredPort();
    if (hover === null) return null;
    const origin = pos();
    return { x: hover.point.x - origin.x, y: hover.point.y - origin.y };
  };

  return (
    <View
      style={{
        position: "absolute",
        left: pos().x,
        top: pos().y,
        width: 0,
        height: 0,
        zIndex: zIndex(),
        // Zero opacity skips the whole subtree's paint natively while the
        // card stays in the scene and the accessibility tree. Only exactly
        // 0 or 1 is ever set, so no group layer is ever made.
        opacity: shown() ? 1 : 0,
      }}
    >
      <View
        style={{
          position: "absolute",
          left: layout().title.x,
          top: layout().title.y,
          width: layout().title.width,
          height: layout().title.height,
        }}
      >
        <View
          classList={{
            "absolute left-0 top-[3px] h-3.5 w-1 rounded-full": true,
            [ACCENT_BG[accent()]]: true,
          }}
        />
        <Text
          class="absolute text-sm font-semibold text-card-foreground"
          style={{
            left: 12,
            top: 0,
            width: Math.max(1, size().width - (statusText() === "" ? 12 : 92)),
            height: CARD_TITLE_HEIGHT,
            textAlignVertical: "center",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {content.title()}
        </Text>
        <View
          classList={{
            "absolute h-1.5 w-1.5 rounded-full": true,
            [statusDot(status())]: true,
          }}
          style={{
            left: size().width - 74,
            top: 7,
            visibility: statusText() === "" ? "hidden" : "visible",
          }}
        />
        <Text
          classList={{ "absolute text-[10px]": true, [statusTextClass(status())]: true }}
          style={{
            left: size().width - 64,
            top: 0,
            width: 56,
            height: CARD_TITLE_HEIGHT,
            textAlign: "right",
            textAlignVertical: "center",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {statusText()}
        </Text>
      </View>

      {/* The body container carries only the geometry and the accessible name;
          the decoration lives in a childless absolute plate so the Windows
          renderer can skip its paint when it is outside the damage rect
          (nsh-platform-windows render.rs skips childless views only). */}
      <View
        accessibilityLabel={content.title()}
        style={{
          position: "absolute",
          left: layout().body.x,
          top: layout().body.y,
          width: layout().body.width,
          height: layout().body.height,
        }}
      >
        {/* The selection ring: a border-only view under the card, in the
            border's own color, that grows out from behind it when the card is
            selected or covered by a marquee, instead of appearing at once. */}
        <View
          style={{
            position: "absolute",
            left: -SELECTION_RING,
            top: -SELECTION_RING,
            right: -SELECTION_RING,
            bottom: -SELECTION_RING,
            borderWidth: SELECTION_RING,
            borderColor: token("selection"),
            borderRadius: SELECTION_RING_RADIUS,
            pointerEvents: "none",
            opacity: marked() ? 1 : 0,
            transform: marked() ? "scale(1)" : "scale(0.96)",
            transitionProperty: "opacity, transform",
            transitionDuration: "180ms",
            transitionTimingFunction: "ease-out",
          }}
        />
        <View
          class="absolute left-0 top-0 h-full w-full rounded-2xl border bg-card shadow-lg"
          style={{ borderColor: borderColor() }}
        />
        {content.image() ? (
          <View
            class="absolute"
            style={{
              left: BODY_INSET,
              top: BODY_INSET,
              width: Math.max(1, size().width - BODY_INSET * 2),
              height: Math.max(1, size().height - BODY_INSET * 2),
              overflow: "hidden",
            }}
          >
            <If when={props.preview() === null || props.preview()?.urls.length === 0}>
              <Text class="text-xs text-muted-foreground">No output yet</Text>
            </If>
            <Each of={props.preview()?.urls ?? []} key="index">
              {(url, index) => (
                <Image
                  src={url()}
                  onLoad={(event) =>
                    props.imageEvent?.({
                      nodeId: props.node().id,
                      kind: "load",
                      url: url(),
                      width: event.size.width,
                      height: event.size.height,
                      message: "",
                    })
                  }
                  onError={(event) =>
                    props.imageEvent?.({
                      nodeId: props.node().id,
                      kind: "error",
                      url: url(),
                      width: 0,
                      height: 0,
                      message: event.message,
                    })
                  }
                  style={{
                    position: "absolute",
                    ...previewCell(
                      Math.max(1, size().width - BODY_INSET * 2),
                      Math.max(1, size().height - BODY_INSET * 2),
                      index(),
                      props.preview()?.urls.length ?? 0,
                    ),
                    borderRadius: 8,
                    objectFit: "cover",
                  }}
                />
              )}
            </Each>
          </View>
        ) : (
          <>
            {body() !== "" ? (
              <Text
                class="absolute text-[13px] text-card-foreground"
                style={{
                  left: BODY_INSET,
                  top: BODY_INSET,
                  width: Math.max(1, size().width - BODY_INSET * 2),
                  height: Math.max(1, size().height - BODY_INSET * 2),
                  lineHeight: 19,
                  numberOfLines: lineCount(),
                  textOverflow: "ellipsis",
                }}
              >
                {truncate(body(), 600)}
              </Text>
            ) : null}
            <If when={body() === ""}>
              <Text
                class="absolute text-xs text-muted-foreground"
                style={{ left: BODY_INSET, top: BODY_INSET }}
              >
                No output yet
              </Text>
            </If>
          </>
        )}
      </View>

      <If when={portsShown()}>
        <Each of={spec.inputs} key={(port) => port.id}>
          {(port, index) => (
            <Port
              port={port()}
              center={() => portCenter("in", index(), spec.inputs.length)}
              follow={() => portFollow("in", port().id)}
            />
          )}
        </Each>
        <Each of={spec.outputs} key={(port) => port.id}>
          {(port, index) => (
            <Port
              port={port()}
              center={() => portCenter("out", index(), spec.outputs.length)}
              follow={() => portFollow("out", port().id)}
            />
          )}
        </Each>
      </If>
    </View>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case "running":
      return "bg-chart-1";
    case "done":
      return "bg-chart-3";
    case "failed":
      return "bg-destructive";
    case "stale":
      return "bg-chart-4";
    default:
      return "bg-muted-foreground";
  }
}

function statusTextClass(status: string): string {
  switch (status) {
    case "running":
      return "text-chart-1";
    case "done":
      return "text-chart-3";
    case "failed":
      return "text-destructive";
    case "stale":
      return "text-chart-4";
    default:
      return "text-muted-foreground";
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** The host regression's report, or nothing unless its launch parameter asks. */
export function imageProbeText(event: CardImageEvent): string {
  if (host.params.flowImageLoadProbe !== 1) return "";
  return [event.kind, event.nodeId, event.url, event.width, event.height, event.message].join(";");
}

/** The invisible input a host test reads the last image event from. */
export function ImageLoadProbe(props: { readonly value: string }) {
  return (
    <Input
      testID="image-load-probe"
      readonly
      value={props.value}
      style={{ position: "absolute", left: 8, top: 8, width: 360, height: 1, opacity: 0 }}
    />
  );
}
