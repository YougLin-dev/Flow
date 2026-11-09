import { Button } from "nsh/base";
import { Hand, MousePointer2 } from "lucide";
import { Text, token, View } from "nsh";
import type { Tool } from "../tool";
import { Icon } from "./Icon";

export interface ToolSwitchProps {
  tool: Tool;
  onChange: (tool: Tool) => void;
}

const buttons = [
  { tool: "select", label: "Select", icon: MousePointer2 },
  { tool: "hand", label: "Hand", icon: Hand },
] as const;

/** The Select / Hand switch floating at the canvas' bottom-right corner. */
export function ToolSwitch(props: ToolSwitchProps) {
  return (
    <View class="absolute right-4 bottom-4 flex-row items-center gap-1 rounded-(--radius) border border-border bg-card p-1">
      {buttons.map(({ tool, label, icon }) => (
        <Button
          accessibilityLabel={label}
          selected={props.tool === tool}
          onPress={() => props.onChange(tool)}
          class="flex-row items-center gap-1.5 rounded-md px-3 py-1.5 active:bg-muted selected:bg-muted focus:bg-accent"
        >
          <Icon
            icon={icon}
            size={15}
            tint={() => token(props.tool === tool ? "card-foreground" : "muted-foreground")}
          />
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
