/**
 * The status tables for a card's header: the dot is a background token and
 * the label a foreground token, kept together so a new status cannot color
 * one without the other.
 */

/** The background token for a node status dot. */
export function statusDot(status: string): string {
  switch (status) {
    case "running":
      return "bg-chart-1";
    case "done":
      return "bg-chart-3";
    case "failed":
      return "bg-destructive";
    case "stale":
      return "bg-chart-4";
    default:
      return "bg-muted-foreground";
  }
}

/** The foreground token for a node status label. */
export function statusTextClass(status: string): string {
  switch (status) {
    case "running":
      return "text-chart-1";
    case "done":
      return "text-chart-3";
    case "failed":
      return "text-destructive";
    case "stale":
      return "text-chart-4";
    default:
      return "text-muted-foreground";
  }
}
