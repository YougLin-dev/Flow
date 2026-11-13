import { effect, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { keepsWheel } from "../flow/page-chrome";

export interface InlineTextEditorProps {
  /** The node being edited; a change resets the draft to that node's body. */
  readonly nodeId: () => string | null;
  readonly text: () => string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly onChange: (text: string) => void;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}

/** A screen-space editor laid over a text node's card body. */
export function InlineTextEditor(props: InlineTextEditorProps) {
  const draft = signal(props.text());
  let currentNodeId = props.nodeId();

  effect(() => {
    const id = props.nodeId();
    if (id === currentNodeId) return;
    currentNodeId = id;
    draft.set(props.text());
  });

  return (
    <View
      testID="inline-text-editor"
      class="absolute z-30 gap-2 rounded-md border border-border bg-popover p-2 shadow-lg"
      style={{
        left: props.left,
        top: props.top,
        width: Math.max(220, props.width),
        minHeight: Math.max(120, props.height),
      }}
    >
      <Input
        testID="inline-text-input"
        accessibilityLabel="Text body"
        value={draft()}
        onChange={(event) => {
          draft.set(event.value);
          // Keep the draft in the session too: the editor unmounts when its
          // card leaves the viewport and must come back with the same text.
          props.onChange(event.value);
        }}
        onSubmit={(event) => props.onSave(event.text)}
        multiline
        autoFocus
        submitBehavior="submit"
        onWheel={keepsWheel}
        class="flex-1 rounded-md border border-input bg-card px-2 py-1.5 text-sm text-card-foreground"
      />
      <View class="flex-row items-center justify-end gap-2">
        <Button
          accessibilityLabel="Cancel text edit"
          onPress={props.onCancel}
          class="rounded-md px-2 py-1 active:bg-muted"
        >
          <Text class="text-xs text-card-foreground">Cancel</Text>
        </Button>
        <Button
          accessibilityLabel="Save text"
          onPress={() => props.onSave(draft())}
          class="rounded-md bg-primary px-2 py-1 active:opacity-90"
        >
          <Text class="text-xs font-medium text-primary-foreground">Save</Text>
        </Button>
      </View>
    </View>
  );
}
