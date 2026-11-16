import { expect, test } from "nsh/test";
import { statusDot, statusTextClass } from "./status-visual";

test("status tables map every node status to its dot and label token", () => {
  // The four colored statuses, then the statuses that draw as the muted
  // default (idle, cancelled and interrupted).
  const statuses = ["running", "done", "failed", "stale", "idle", "cancelled", "interrupted"];
  expect(statuses.map(statusDot)).toEqual([
    "bg-chart-1",
    "bg-chart-3",
    "bg-destructive",
    "bg-chart-4",
    "bg-muted-foreground",
    "bg-muted-foreground",
    "bg-muted-foreground",
  ]);
  expect(statuses.map(statusTextClass)).toEqual([
    "text-chart-1",
    "text-chart-3",
    "text-destructive",
    "text-chart-4",
    "text-muted-foreground",
    "text-muted-foreground",
    "text-muted-foreground",
  ]);
});
