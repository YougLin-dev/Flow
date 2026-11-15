import type { ProjectEntry } from "../shared";

/** How the list shows a project's window state. */
export type ProjectStatus = "open-here" | "open-elsewhere" | "closed";

/** The frozen ordering of a project list: recent first, then stable. */
export function sortProjects(projects: readonly ProjectEntry[]): ProjectEntry[] {
  return projects.toSorted((a, b) => {
    const recency = (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1);
    if (recency !== 0) return recency;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    const title = a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase());
    if (title !== 0) return title;
    return a.projectId.localeCompare(b.projectId);
  });
}

/** Case-insensitive title search; an empty query keeps every project. */
export function filterProjects(projects: readonly ProjectEntry[], query: string): ProjectEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...projects];
  return projects.filter((project) => project.title.toLocaleLowerCase().includes(needle));
}

export function projectStatus(project: ProjectEntry): ProjectStatus {
  if (project.openHere) return "open-here";
  if (project.openElsewhere) return "open-elsewhere";
  return "closed";
}

/** The row's status copy; empty for a closed project. */
export function projectStatusLabel(project: ProjectEntry): string {
  if (project.openHere) return "Open in this window";
  if (project.openElsewhere) return "Open in another window";
  return "";
}

/**
 * The row's title. A fallback row's title is its 32-hex directory name, which
 * is not a project name; the list says what it can do with it instead.
 */
export function projectDisplayTitle(project: ProjectEntry): string {
  return project.unreadable ? "Unavailable project" : project.title;
}

/** The row's second line: recent activity, or why the package cannot open. */
export function projectSubtitle(project: ProjectEntry, now: number): string {
  if (project.unreadable) return "This project can’t be opened";
  const lastOpenedAt = project.lastOpenedAt ?? null;
  if (lastOpenedAt !== null) return `Opened ${relativeTime(lastOpenedAt, now)}`;
  return `Updated ${relativeTime(project.updatedAt, now)}`;
}

/**
 * Short relative time for list rows. It resolves at day granularity past
 * "yesterday" and falls back to an ISO date after a month, so the copy stays
 * short and never depends on locale data the runtime may not have.
 */
export function relativeTime(at: number, now: number): string {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const delta = Math.max(0, now - at);
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.floor(delta / minute)} min ago`;
  if (delta < day) return `${Math.floor(delta / hour)} hr ago`;
  if (delta < 30 * day) {
    const days = Math.floor(delta / day);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return `on ${new Date(at).toISOString().slice(0, 10)}`;
}
