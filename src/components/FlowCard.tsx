/**
 * One node card on the native canvas: header, status, body and ports. Its
 * pixel values are world-space points, so they scale with the camera.
 */
import { Image, Text, View } from "nsh";
import type { NodeSummary } from "@flow/native";
import type { BoxGeometry } from "../flow/connection";
import { type FlowAccent, nodeKind, statusLabel } from "../flow/node-kinds";
import { previewCell } from "../flow/preview-grid";
import type { PreviewView } from "../flow/scene";

export interface FlowCardProps {
  readonly node: () => NodeSummary;
  readonly rect: () => BoxGeometry | null;
  readonly preview: () => PreviewView | null;
  readonly selected: () => boolean;
  readonly hovered: () => boolean;
}

const ACCENT_BG: Record<FlowAccent, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export function FlowCard(props: FlowCardProps) {
  const accent = () => nodeKind(props.node().kind).accent;
  const active = () => props.selected() || props.hovered();
  const left = () => props.rect()?.x ?? 0;
  const top = () => props.rect()?.y ?? 0;
  const width = () => props.rect()?.width ?? 0;
  const height = () => props.rect()?.height ?? 0;
  const body = () => props.node().body.trim();
  const lineCount = () => Math.max(1, Math.floor((height() - 64) / 19));

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: props.node().z + 1,
      }}
    >
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
        <View
          classList={{
            "absolute left-4 top-4 h-5 w-1 rounded-full": true,
            [ACCENT_BG[accent()]]: true,
          }}
        />
        <Text
          class="absolute text-[15px] font-semibold text-card-foreground"
          style={{
            left: 28,
            top: 14,
            width: Math.max(1, width() - 116),
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
            top: 23,
            visibility: statusLabel(props.node().status) === "" ? "hidden" : "visible",
          }}
        />
        <Text
          classList={{ "absolute text-[10px]": true, [statusText(props.node().status)]: true }}
          style={{
            left: width() - 64,
            top: 16,
            width: 56,
            textAlign: "right",
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {statusLabel(props.node().status)}
        </Text>

        {props.node().kind === "image" ? (
          <View
            class="absolute"
            style={{
              left: 16,
              top: 48,
              width: Math.max(1, width() - 32),
              height: Math.max(1, height() - 64),
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
                      Math.max(1, width() - 32),
                      Math.max(1, height() - 64),
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
          <Text class="absolute text-xs text-muted-foreground" style={{ left: 16, top: 48 }}>
            No output yet
          </Text>
        ) : (
          <Text
            class="absolute text-[13px] text-card-foreground"
            style={{
              left: 16,
              top: 48,
              width: Math.max(1, width() - 32),
              height: Math.max(1, height() - 64),
              lineHeight: 19,
              numberOfLines: lineCount(),
              textOverflow: "ellipsis",
            }}
          >
            {truncate(props.node().body, 600)}
          </Text>
        )}
      </View>

      <Port
        accent={accent()}
        left={left() - PORT_SIZE / 2}
        top={top() + height() / 2 - PORT_SIZE / 2}
      />
      <Port
        accent={accent()}
        left={left() + width() - PORT_SIZE / 2}
        top={top() + height() / 2 - PORT_SIZE / 2}
      />
    </View>
  );
}

const PORT_SIZE = 14;
const PORT_DOT = 7;

/**
 * A port's accent dot on a card-colored halo, drawn after the card so the
 * halo covers the border and the connector's end beneath it.
 */
function Port(props: { readonly accent: FlowAccent; readonly left: number; readonly top: number }) {
  return (
    <View
      class="absolute rounded-full bg-card"
      style={{
        left: props.left,
        top: props.top,
        width: PORT_SIZE,
        height: PORT_SIZE,
      }}
    >
      <View
        classList={{ "absolute rounded-full": true, [ACCENT_BG[props.accent]]: true }}
        style={{
          left: (PORT_SIZE - PORT_DOT) / 2,
          top: (PORT_SIZE - PORT_DOT) / 2,
          width: PORT_DOT,
          height: PORT_DOT,
        }}
      />
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
