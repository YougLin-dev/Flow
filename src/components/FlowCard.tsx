/**
 * One node card on the native canvas: its title and status above the card,
 * the body inside it and a plus button on each side while it is active. Its
 * pixel values are world-space points, so they scale with the camera.
 */
import { Image, Text, View } from "nsh";
import type { NodeSummary } from "@flow/native";
import { PortPlus } from "./PortPlus";
import { CARD_TITLE_GAP, CARD_TITLE_HEIGHT } from "../flow/card-layout";
import { type BoxGeometry, type Point, type PortSide, portButtonPoint } from "../flow/connection";
import { type FlowAccent, nodeKind, statusLabel } from "../flow/node-kinds";
import { previewCell } from "../flow/preview-grid";
import type { PreviewView } from "../flow/scene";

export interface FlowCardProps {
  readonly node: () => NodeSummary;
  readonly rect: () => BoxGeometry | null;
  /** The card's draw order: selected cards sit above every other card. */
  readonly zIndex: () => number;
  readonly preview: () => PreviewView | null;
  readonly selected: () => boolean;
  /** True while a marquee in progress covers this card. */
  readonly previewed: () => boolean;
  readonly hovered: () => boolean;
  /** The side this card's plus is following the pointer on, if any. */
  readonly plus: () => { readonly side: PortSide; readonly point: Point } | null;
  /** True while a multi-card frame replaces this card's own plus buttons. */
  readonly plusSuppressed: () => boolean;
  /** True while a pulled connector is snapped to this card. */
  readonly target: () => boolean;
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

export function FlowCard(props: FlowCardProps) {
  const accent = () => nodeKind(props.node().kind).accent;
  const active = () => props.selected() || props.previewed() || props.hovered() || props.target();
  const left = () => props.rect()?.x ?? 0;
  const top = () => props.rect()?.y ?? 0;
  const width = () => props.rect()?.width ?? 0;
  const height = () => props.rect()?.height ?? 0;
  const body = () => props.node().body.trim();
  const status = () => statusLabel(props.node().status);
  const lineCount = () => Math.max(1, Math.floor((height() - BODY_INSET * 2) / 19));
  const plusBase = (side: PortSide): Point => {
    const rect = props.rect();
    return rect ? portButtonPoint(rect, side) : { x: 0, y: 0 };
  };
  const plusFollow = (side: PortSide): Point | null => {
    const followed = props.plus();
    return followed !== null && followed.side === side ? followed.point : null;
  };
  const showPlus = () => !props.plusSuppressed() && (props.selected() || props.hovered());

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: props.zIndex(),
      }}
    >
      <View
        style={{
          position: "absolute",
          left: left(),
          top: top() - CARD_TITLE_HEIGHT - CARD_TITLE_GAP,
          width: width(),
          height: CARD_TITLE_HEIGHT,
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
            width: Math.max(1, width() - (status() === "" ? 12 : 92)),
            height: CARD_TITLE_HEIGHT,
            textAlignVertical: "center",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {props.node().title}
        </Text>
        <View
          classList={{
            "absolute h-1.5 w-1.5 rounded-full": true,
            [statusDot(props.node().status)]: true,
          }}
          style={{
            left: width() - 74,
            top: 7,
            visibility: status() === "" ? "hidden" : "visible",
          }}
        />
        <Text
          classList={{ "absolute text-[10px]": true, [statusText(props.node().status)]: true }}
          style={{
            left: width() - 64,
            top: 0,
            width: 56,
            height: CARD_TITLE_HEIGHT,
            textAlign: "right",
            textAlignVertical: "center",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {status()}
        </Text>
      </View>

      <View
        accessibilityLabel={props.node().title}
        classList={{
          "absolute rounded-2xl border bg-card shadow-lg": true,
          "border-chart-1": active(),
          "border-border": !active(),
        }}
        style={{
          position: "absolute",
          left: left(),
          top: top(),
          width: width(),
          height: height(),
        }}
      >
        {props.node().kind === "image" ? (
          <View
            class="absolute"
            style={{
              left: BODY_INSET,
              top: BODY_INSET,
              width: Math.max(1, width() - BODY_INSET * 2),
              height: Math.max(1, height() - BODY_INSET * 2),
              overflow: "hidden",
            }}
          >
            {props.preview() === null || props.preview()?.urls.length === 0 ? (
              <Text class="text-xs text-muted-foreground">No output yet</Text>
            ) : null}
            <Each of={props.preview()?.urls ?? []} key="index">
              {(url, index) => (
                <Image
                  src={url()}
                  style={{
                    position: "absolute",
                    ...previewCell(
                      Math.max(1, width() - BODY_INSET * 2),
                      Math.max(1, height() - BODY_INSET * 2),
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
        ) : body() === "" ? (
          <Text
            class="absolute text-xs text-muted-foreground"
            style={{ left: BODY_INSET, top: BODY_INSET }}
          >
            No output yet
          </Text>
        ) : (
          <Text
            class="absolute text-[13px] text-card-foreground"
            style={{
              left: BODY_INSET,
              top: BODY_INSET,
              width: Math.max(1, width() - BODY_INSET * 2),
              height: Math.max(1, height() - BODY_INSET * 2),
              lineHeight: 19,
              numberOfLines: lineCount(),
              textOverflow: "ellipsis",
            }}
          >
            {truncate(props.node().body, 600)}
          </Text>
        )}
      </View>

      {showPlus() ? (
        <PortPlus accent={accent()} base={() => plusBase("in")} follow={() => plusFollow("in")} />
      ) : null}
      {showPlus() ? (
        <PortPlus accent={accent()} base={() => plusBase("out")} follow={() => plusFollow("out")} />
      ) : null}
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

function statusText(status: string): string {
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
