import { cleanup, keymap, List, signal, Text, token, View, type InputRef, type ListRef } from "nsh";
import { Button, Dialog, Input } from "nsh/base";
import type { SearchHit } from "@flow/native";

const SEARCH_DELAY_MS = 120;

export interface SearchFilter {
  readonly label: string;
  /** The node kind to filter by, or null for every kind. */
  readonly kind: string | null;
}

export interface SearchPaletteProps {
  /** The type filters the palette offers; the first is the unfiltered one. */
  filters: readonly SearchFilter[];
  /** Runs the document search for the current query and filter. */
  search: (query: string, kind: string | null) => Promise<SearchHit[]>;
  /** The user dismissed the palette (Escape, backdrop or a close attempt). */
  onClose: () => void;
  /** The user chose a hit; the page reveals it. */
  onSelect: (hit: SearchHit) => void;
}

/** The command palette: type to search the document, pick a card to reveal it. */
export function SearchPalette(props: SearchPaletteProps) {
  const query = signal("");
  const kind = signal<string | null>(props.filters[0]?.kind ?? null);
  const results = signal<SearchHit[]>([]);
  const active = signal(0);
  const loading = signal(false);
  const failed = signal(false);

  let timer: number | null = null;
  let generation = 0;
  let disposed = false;
  let input: InputRef | null = null;
  let list: ListRef | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const execute = async (value: string, filter: string | null): Promise<void> => {
    const current = ++generation;
    try {
      const hits = await props.search(value, filter);
      if (disposed || current !== generation) return;
      results.set(hits);
      active.set(0);
    } catch (error) {
      if (disposed || current !== generation) return;
      console.error("Flow could not search the document", error);
      failed.set(true);
      results.set([]);
    } finally {
      if (!disposed && current === generation) loading.set(false);
    }
  };

  const request = (value: string, filter: string | null): void => {
    clearTimer();
    generation += 1;
    const trimmed = value.trim();
    // Rows from the previous query or filter must not stay clickable while
    // the next search is debouncing.
    results.set([]);
    active.set(0);
    if (trimmed === "") {
      loading.set(false);
      failed.set(false);
      return;
    }
    loading.set(true);
    failed.set(false);
    timer = setTimeout(() => {
      timer = null;
      void execute(trimmed, filter);
    }, SEARCH_DELAY_MS);
  };

  const changeQuery = (value: string): void => {
    query.set(value);
    active.set(0);
    request(value, kind());
  };

  const chooseKind = (next: string | null): void => {
    kind.set(next);
    request(query(), next);
    input?.focus();
  };

  const choose = (hit: SearchHit | undefined): void => {
    if (!hit || loading()) return;
    props.onSelect(hit);
  };

  const chooseActive = (): void => {
    choose(results()[active()]);
  };

  const move = (delta: number): void => {
    const hits = results();
    if (hits.length === 0) return;
    const next = (active() + delta + hits.length) % hits.length;
    active.set(next);
    list?.scrollToIndex({ index: next, viewPosition: 0.5, animated: true });
  };

  // The palette is mounted only while it is open; its shortcut bindings go
  // with it, so the canvas keeps the arrow keys when it closes.
  keymap.bind(
    {
      up: () => move(-1),
      down: () => move(1),
    },
    { when: "always" },
  );

  cleanup(() => {
    disposed = true;
    clearTimer();
  });

  const emptyLabel = (): string => {
    if (failed()) return "Search failed";
    if (loading()) return "Searching…";
    if (query().trim() === "") return "Search titles, bodies and tags";
    return "No cards match";
  };

  const resultLabel = (): string => {
    if (failed() || loading() || query().trim() === "") return "";
    const count = results().length;
    if (count === 0) return "No results";
    return count === 1 ? "1 result" : `${count} results`;
  };

  // The list is its own viewport: give it the rows' estimated height, up to
  // six rows, and room for the empty state when there are none.
  const resultHeight = (): number =>
    results().length === 0 ? 128 : Math.min(320, results().length * 64 + 8);

  return (
    <Dialog
      testID="search-dialog"
      animation="fade"
      presentation="fullScreen"
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      onOpen={() => input?.focus()}
      class="mx-auto mt-24 w-11/12 max-w-xl overflow-hidden rounded-(--radius) border border-border bg-popover"
      backdropStyle={{ backgroundColor: token("background"), opacity: 0.7 }}
    >
      <View class="flex-row items-center gap-2 border-b border-border px-4">
        <Text class="text-sm font-medium text-muted-foreground">Search</Text>
        <Input
          testID="search-input"
          ref={(node) => {
            input = node;
          }}
          value={query()}
          onChange={(event) => changeQuery(event.value)}
          onSubmit={chooseActive}
          placeholder="Search cards…"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          submitBehavior="submit"
          class="flex-1 px-1 py-3 text-sm text-popover-foreground placeholder:text-muted-foreground"
        />
        <Text class="text-xs text-muted-foreground">{keymap.label("escape")}</Text>
      </View>

      <View class="flex-row items-center gap-1 border-b border-border px-3 py-2">
        {props.filters.map((filter) => (
          <Button
            testID={`search-filter-${filter.kind ?? "all"}`}
            selected={filter.kind === kind()}
            onPress={() => chooseKind(filter.kind)}
            class="rounded-full px-2.5 py-1 active:bg-muted focus:bg-accent selected:bg-muted"
          >
            <Text
              classList={{
                "text-xs": true,
                "font-medium text-card-foreground": filter.kind === kind(),
                "text-muted-foreground": filter.kind !== kind(),
              }}
            >
              {filter.label}
            </Text>
          </Button>
        ))}
      </View>

      <List
        testID="search-results"
        ref={(node) => {
          list = node;
        }}
        each={results()}
        keyExtractor={(hit) => hit.id}
        estimatedItemSize={64}
        contentClass="gap-0.5 p-1"
        style={{ height: resultHeight() }}
        empty={
          <View class="items-center justify-center px-4 py-12">
            <Text class="text-sm text-muted-foreground">{emptyLabel()}</Text>
          </View>
        }
      >
        {(hit, index) => (
          <Button
            testID={`search-result-${hit().id}`}
            selected={index() === active()}
            onPress={() => choose(hit())}
            class="w-full rounded-md px-3 py-2 active:bg-accent focus:bg-accent hover:bg-muted selected:bg-muted"
          >
            <View class="flex-row items-start gap-2">
              <View class="flex-1 gap-0.5">
                <Text class="text-sm font-medium text-popover-foreground">{hit().title}</Text>
                <Text class="line-clamp-2 text-xs text-muted-foreground">
                  {snippet(hit().snippet)}
                </Text>
              </View>
              <Text class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {kindLabel(hit().kind)}
              </Text>
            </View>
          </Button>
        )}
      </List>

      <View class="flex-row items-center justify-between border-t border-border px-3 py-2">
        <Text class="text-xs text-muted-foreground">{resultLabel()}</Text>
        <Text class="text-xs text-muted-foreground">↑↓ navigate · Enter open · Esc close</Text>
      </View>
    </Dialog>
  );
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function kindLabel(kind: string): string {
  return kind.length === 0 ? "Card" : kind.charAt(0).toUpperCase() + kind.slice(1);
}
