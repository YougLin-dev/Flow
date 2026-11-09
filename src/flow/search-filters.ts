/** One type filter the command palette offers. */
export interface FlowSearchFilter {
  readonly label: string;
  /** The node kind to filter by, or null for every kind. */
  readonly kind: string | null;
}

/** The node kinds the command palette offers. */
export const SEARCH_FILTERS: readonly FlowSearchFilter[] = [
  { label: "All", kind: null },
  { label: "Text", kind: "text" },
  { label: "Images", kind: "image" },
];
