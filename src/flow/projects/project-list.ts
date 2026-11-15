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
