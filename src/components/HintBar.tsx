import { platform, Text, View } from "nsh";
import type { Tool } from "../tool";

export interface HintBarProps {
  tool: Tool;
}

const modifier = platform.os === "macos" ? "⌘" : "Ctrl";

const hints: Record<Tool, string> = {
  hand: `Drag to pan · pinch or ${modifier} +/− to zoom · V to select`,
  select: "Drag a card · N adds · L connects · Del removes · H to pan",
};

const touchHint = "Drag a card · box-select empty space · pinch to pan/zoom";

/** The one-line interaction hint at the canvas' bottom-left corner. */
export function HintBar(props: HintBarProps) {
  return (
    <View
      classList={{
        "absolute left-4 rounded-full border border-border bg-card px-3 py-1.5": true,
        // On a phone the tool switch owns the bottom-right corner; sit above
        // it instead of sharing the row.
        "bottom-16": !platform.desktop,
        "bottom-4": platform.desktop,
      }}
    >
      <Text class="text-xs text-muted-foreground">
        {platform.desktop ? hints[props.tool] : touchHint}
      </Text>
    </View>
  );
}
