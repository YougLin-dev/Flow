/**
 * One node card on the native canvas: header, status, body and ports. Its
 * pixel values are world-space points, so they scale with the camera.
 */
import { Image, Text, View } from "nsh";
import type { NodeSummary } from "@flow/native";
import type { BoxGeometry } from "../flow/connection";
import { type FlowAccent, nodeKind, statusLabel } from "../flow/node-kinds";
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

const ACCENT_BORDER: Record<FlowAccent, string> = {
  "chart-1": "border-chart-1",
  "chart-2": "border-chart-2",
  "chart-3": "border-chart-3",
  "chart-4": "border-chart-4",
  "chart-5": "border-chart-5",
};

export function FlowCard(props: FlowCardProps) {
  const accent = () => nodeKind(props.node().kind).accent;
  const active = () => props.selected() || props.hovered();
  const width = () => props.rect()?.width ?? 0;
  const height = () => props.rect()?.height ?? 0;
  const body = () => props.node().body.trim();
  const lineCount = () => Math.max(1, Math.floor((height() - 64) / 19));

  return (
    <View
      accessibilityLabel={props.node().title}
      classList={{
        "absolute rounded-2xl border bg-card shadow-lg": true,
        "border-chart-1": active(),
        "border-border": !active(),
      }}
      style={{
        position: "absolute",
        left: props.rect()?.x ?? 0,
        top: props.rect()?.y ?? 0,
        width: width(),
        height: height(),
        zIndex: props.node().z + 1,
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
                  ...cellOf(width(), height(), index(), props.preview()?.urls.length ?? 0),
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

      <View
        classList={{
          "absolute h-3 w-3 rounded-full border-2 bg-card": true,
          [ACCENT_BORDER[accent()]]: true,
        }}
        style={{ left: -6, top: height() / 2 - 6 }}
      />
      <View
        classList={{
          "absolute h-3 w-3 rounded-full border-2 bg-card": true,
          [ACCENT_BORDER[accent()]]: true,
        }}
        style={{ left: width() - 6, top: height() / 2 - 6 }}
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

function cellOf(
  width: number,
  height: number,
  index: number,
  count: number,
): { left: number; top: number; width: number; height: number } {
  const gap = 8;
  const areaWidth = Math.max(1, width - 32);
  const areaHeight = Math.max(1, height - 64);
  const columns = count <= 1 ? 1 : 2;
  const rows = Math.min(2, Math.ceil(count / columns));
  const cellWidth = (areaWidth - gap * (columns - 1)) / columns;
  const cellHeight = (areaHeight - gap * (rows - 1)) / Math.max(1, rows);
  return {
    left: 16 + (index % columns) * (cellWidth + gap),
    top: 48 + Math.floor(index / columns) * (cellHeight + gap),
    width: Math.max(1, cellWidth),
    height: Math.max(1, cellHeight),
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
