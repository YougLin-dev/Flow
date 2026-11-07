import { Text } from "nsh";
import { Button } from "nsh/base";

export interface SearchButtonProps {
  /** The platform's label for the search shortcut, such as `⌘K`. */
  shortcut: string;
  onPress: () => void;
}

/** The floating search entry point at the canvas' top-left corner. */
export function SearchButton(props: SearchButtonProps) {
  return (
    <Button
      testID="search-button"
      accessibilityLabel="Search"
      onPress={props.onPress}
      class="absolute top-4 left-4 flex-row items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 active:bg-muted focus:bg-accent"
    >
      <Text class="text-sm text-card-foreground">Search</Text>
      <Text class="text-xs text-muted-foreground">{props.shortcut}</Text>
    </Button>
  );
}
