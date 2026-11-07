import { Button } from "nsh/base";
import { Text, View } from "nsh";
import type { Tool } from "../tool";

export interface ToolSwitchProps {
  tool: Tool;
  onChange: (tool: Tool) => void;
}

const buttons: readonly { tool: Tool; label: string }[] = [
  { tool: "select", label: "Select" },
  { tool: "hand", label: "Hand" },
];

/** The Select / Hand switch floating at the canvas' bottom-right corner. */
export function ToolSwitch(props: ToolSwitchProps) {
  return (
    <View class="absolute right-4 bottom-4 flex-row items-center gap-1 rounded-(--radius) border border-border bg-card p-1">
      {buttons.map(({ tool, label }) => (
        <Button
          selected={props.tool === tool}
          onPress={() => props.onChange(tool)}
          class="rounded-md px-3 py-1.5 active:bg-muted selected:bg-muted"
        >
          <Text
            classList={{
              "text-sm font-semibold text-card-foreground": props.tool === tool,
              "text-sm text-muted-foreground": props.tool !== tool,
            }}
          >
            {label}
          </Text>
        </Button>
      ))}
    </View>
  );
}
