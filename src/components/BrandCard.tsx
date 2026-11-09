import { Text, View } from "nsh";

/** The Flow wordmark used where the desktop title bar is not available. */
export function BrandCard() {
  return (
    <View
      testID="brand-card"
      // Below the add-node toolbar so the two floating panels do not stack.
      class="absolute top-28 left-4 gap-0.5 rounded-(--radius) border border-border bg-card px-4 py-3"
    >
      <Text class="text-lg font-semibold text-card-foreground">Flow</Text>
      <Text class="text-xs text-muted-foreground">Native canvas · NSH</Text>
    </View>
  );
}
