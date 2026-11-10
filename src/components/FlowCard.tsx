/**
 * One node card on the native canvas: its title and status above the card,
 * the body inside it and a plus button on each side while it is active. The
 * card's root carries its world position, and its chrome is laid out in
 * card-local points, so a drag moves one style instead of every geometry
 * derived style (see `flow/card-geometry.ts`); its document text is read
 * through equality-gated values (`flow/card-content.ts`), so a viewport
 * refresh that carries the same card wakes no binding. Its pixel values
 * scale with the camera through the world view.
 */
import { computed, Image, Text, View } from "nsh";
import type { NodeSummary } from "@flow/native";
import { PortPlus } from "./PortPlus";
import { CardContent } from "../flow/card-content";
import {
  CardGeometry,
  type CardSize,
  cardLocalLayout,
  cardPlusPoint,
  toCardLocal,
} from "../flow/card-geometry";
import { CARD_TITLE_HEIGHT } from "../flow/card-layout";
import type { BoxGeometry, Point, PortSide } from "../flow/connection";
import type { FlowAccent } from "../flow/node-kinds";
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

const ZERO_POINT: Point = { x: 0, y: 0 };
const ZERO_SIZE: CardSize = { width: 0, height: 0 };

export function FlowCard(props: FlowCardProps) {
  // The rectangle arrives whole on every drag move; the position and size
  // memos keep each chrome style subscribed to only the fields it reads.
  const geometry = new CardGeometry(() => props.rect());
  // Both cards' records and their stacking are replaced by every viewport
  // read; the gated values keep an unchanged card from waking any binding.
  const content = new CardContent(() => props.node());
  const zIndex = computed(() => props.zIndex());
  const pos = () => geometry.position() ?? ZERO_POINT;
  const size = () => geometry.size() ?? ZERO_SIZE;
  const layout = () => cardLocalLayout(size());

  const accent = content.accent;
  const active = () => props.selected() || props.previewed() || props.hovered() || props.target();
  const body = content.body;
  const status = content.status;
  const statusText = content.statusText;
  const lineCount = () => Math.max(1, Math.floor((size().height - BODY_INSET * 2) / 19));
  const plusBase = (side: PortSide): Point =>
    geometry.size() === null ? ZERO_POINT : cardPlusPoint(size(), side);
  const plusFollow = (side: PortSide): Point | null => {
    const followed = props.plus();
    return followed !== null && followed.side === side ? toCardLocal(followed.point, pos()) : null;
  };
  const showPlus = () => !props.plusSuppressed() && (props.selected() || props.hovered());

  return (
    <View
      style={{
        position: "absolute",
        left: pos().x,
        top: pos().y,
        width: 0,
        height: 0,
        zIndex: zIndex(),
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

      <View
        accessibilityLabel={content.title()}
        classList={{
          "absolute rounded-2xl border bg-card shadow-lg": true,
          "border-chart-1": active(),
          "border-border": !active(),
        }}
        style={{
          position: "absolute",
          left: layout().body.x,
          top: layout().body.y,
          width: layout().body.width,
          height: layout().body.height,
        }}
      >
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
              width: Math.max(1, size().width - BODY_INSET * 2),
              height: Math.max(1, size().height - BODY_INSET * 2),
              lineHeight: 19,
              numberOfLines: lineCount(),
              textOverflow: "ellipsis",
            }}
          >
            {truncate(body(), 600)}
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
