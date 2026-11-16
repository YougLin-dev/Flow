import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { TitleBar } from "../components/app";

export function TitleAccessorProbe() {
  const title = signal<string | undefined>(undefined);
  return (
    <View class="flex-1">
      <TitleBar pinned={false} onTogglePinned={() => {}} title={() => title()} />
      <Button testID="set-title" onPress={() => title.set("Probe title")}>
        <Text>Set</Text>
      </Button>
    </View>
  );
}

mount(TitleAccessorProbe);
