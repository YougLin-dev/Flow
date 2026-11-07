import { platform, Text, View } from "nsh";

export interface SelectionBadgeProps {
  count: number;
}

/** The "N cards selected" pill above the hint bar. */
export function SelectionBadge(props: SelectionBadgeProps) {
  return (
    <View
      classList={{
        "absolute left-4 rounded-full border border-border bg-card px-3 py-1.5": true,
        // The hint bar sits at bottom-16 on a phone; keep the badge above it.
        "bottom-28": !platform.desktop,
        "bottom-16": platform.desktop,
      }}
    >
      <Text class="text-xs text-card-foreground">
        {props.count === 1 ? "1 card selected" : `${props.count} cards selected`}
        <Text class="text-muted-foreground"> · Esc to clear</Text>
      </Text>
    </View>
  );
}
