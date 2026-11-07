import { platform, Text, View } from "nsh";
import type { Tool } from "../tool";

export interface HintBarProps {
  tool: Tool;
}

const hints: Record<Tool, string> = {
  hand: "Drag to pan · pinch or Ctrl/⌘ +/− to zoom · V to select",
  select: "Drag a card · box-select empty space · Shift adds · H to pan",
};

const touchHint = "Drag a card · box-select empty space · pinch to pan/zoom";

/** The one-line interaction hint at the canvas' bottom-left corner. */
export function HintBar(props: HintBarProps) {
  return (
    <View class="absolute bottom-4 left-4 rounded-full border border-border bg-card px-3 py-1.5">
      <Text class="text-xs text-muted-foreground">
        {props.tool === "select" && !platform.desktop ? touchHint : hints[props.tool]}
      </Text>
    </View>
  );
}
