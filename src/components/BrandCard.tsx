import { Text, View } from "nsh";

/** The Flow wordmark used where the desktop title bar is not available. */
export function BrandCard() {
  return (
    <View
      testID="brand-card"
      // Below the zoom controls so a narrow phone does not stack them.
      class="absolute top-16 left-4 gap-0.5 rounded-(--radius) border border-border bg-card px-4 py-3"
    >
      <Text class="text-lg font-semibold text-card-foreground">Flow</Text>
      <Text class="text-xs text-muted-foreground">Leafer engine · NSH</Text>
    </View>
  );
}
