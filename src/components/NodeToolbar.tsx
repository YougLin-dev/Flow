import { Image as ImageIcon, Type, Upload } from "lucide";
import { Text, token, View } from "nsh";
import { Button } from "nsh/base";
import type { NodeKindId } from "../flow/node-kinds";
import { Icon } from "./Icon";

export interface NodeToolbarProps {
  readonly onAdd: (kind: NodeKindId) => void;
}

/** Floating buttons that add the M1 node kinds at the viewport's centre. */
export function NodeToolbar(props: NodeToolbarProps) {
  return (
    <View class="absolute top-16 left-4 flex-row items-center gap-1 rounded-(--radius) border border-border bg-card p-1">
      <Button
        testID="add-text-node"
        onPress={() => props.onAdd("text")}
        class="flex-row items-center gap-1.5 rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent"
      >
        <Icon icon={Type} size={15} tint={() => token("chart-2")} />
        <Text class="text-sm text-card-foreground">Text</Text>
      </Button>
      <Button
        testID="add-image-node"
        onPress={() => props.onAdd("image")}
        class="flex-row items-center gap-1.5 rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent"
      >
        <Icon icon={ImageIcon} size={15} tint={() => token("chart-1")} />
        <Text class="text-sm text-card-foreground">Image</Text>
      </Button>
      <Button
        testID="add-upload-node"
        onPress={() => props.onAdd("upload")}
        class="flex-row items-center gap-1.5 rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent"
      >
        <Icon icon={Upload} size={15} tint={() => token("chart-3")} />
        <Text class="text-sm text-card-foreground">Upload</Text>
      </Button>
    </View>
  );
}
