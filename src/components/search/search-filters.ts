/** One type filter the command palette offers. */
export interface SearchFilter {
  readonly label: string;
  /** The node kind to filter by, or null for every kind. */
  readonly kind: string | null;
}

/** The node kinds the command palette offers. */
export const SEARCH_FILTERS: readonly SearchFilter[] = [
  { label: "All", kind: null },
  { label: "Text", kind: "text" },
  { label: "Images", kind: "image" },
  { label: "Uploads", kind: "upload" },
];
