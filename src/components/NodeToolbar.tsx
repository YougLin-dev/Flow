import { Text, View } from "nsh";
import { Button } from "nsh/base";
import type { NodeKindId } from "../flow/node-kinds";

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
        class="rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent"
      >
        <Text class="text-sm text-card-foreground">+ Text</Text>
      </Button>
      <Button
        testID="add-image-node"
        onPress={() => props.onAdd("image")}
        class="rounded-md px-3 py-1.5 active:bg-muted focus:bg-accent"
      >
        <Text class="text-sm text-card-foreground">+ Image</Text>
      </Button>
    </View>
  );
}
