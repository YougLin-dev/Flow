import { expect, test } from "nsh/test";
import type { ProjectEntry } from "../shared";
import {
  filterProjects,
  projectDisplayTitle,
  projectStatusLabel,
  projectSubtitle,
  relativeTime,
  sortProjects,
} from "./project-list";
import { projectsRoot, projectsRootForLaunch } from "./projects-root";

function entry(
  projectId: string,
  title: string,
  updatedAt: number,
  lastOpenedAt: number | null,
  openHere = false,
  openElsewhere = false,
  unreadable = false,
): ProjectEntry {
  return {
    projectId,
    title,
    path: `/projects/${projectId}/project.db`,
    updatedAt,
    lastOpenedAt,
    openHere,
    openElsewhere,
    unreadable,
  };
}

test("sorts by last opened, then updated, then title", () => {
  const projects = [
    entry("c", "beta", 10, null),
    entry("a", "Alpha", 5, null),
    entry("b", "Gamma", 20, 4),
    entry("d", "delta", 30, 9),
  ];
  expect(sortProjects(projects).map((project) => project.projectId)).toEqual(["d", "b", "c", "a"]);
});

test("sorts case-insensitively and breaks a title tie by id", () => {
  const sameTime = [
    entry("b", "apple", 5, null),
    entry("a", "Banana", 5, null),
    entry("d", "same", 5, null),
    entry("c", "same", 5, null),
  ];
  expect(sortProjects(sameTime).map((project) => project.projectId)).toEqual(["b", "a", "c", "d"]);
});

test("filters by a trimmed case-insensitive title fragment", () => {
  const projects = [entry("a", "Alpha Lake", 1, null), entry("b", "Notes", 1, null)];
  expect(filterProjects(projects, "  lake ").map((project) => project.projectId)).toEqual(["a"]);
  expect(filterProjects(projects, "ALPHA").length).toBe(1);
  expect(filterProjects(projects, "   ").length).toBe(2);
  expect(filterProjects(projects, "missing").length).toBe(0);
});

test("labels the open states and keeps a closed row quiet", () => {
  expect(projectStatusLabel(entry("a", "A", 1, null, true, false))).toBe("Open in this window");
  expect(projectStatusLabel(entry("b", "B", 1, null, false, true))).toBe("Open in another window");
  expect(projectStatusLabel(entry("c", "C", 1, null))).toBe("");
});

test("names an unreadable package and explains why it cannot open", () => {
  const broken = entry("a".repeat(32), "a".repeat(32), 0, null, false, false, true);
  expect(projectDisplayTitle(broken)).toBe("Unavailable project");
  expect(projectSubtitle(broken, 1_000)).toBe("This project can’t be opened");
  expect(projectDisplayTitle(entry("b", "Lake", 5, null))).toBe("Lake");
});

test("the row subtitle prefers the last open, then the update time", () => {
  const now = 100 * 60_000;
  expect(projectSubtitle(entry("a", "A", 0, now - 30_000), now)).toBe("Opened just now");
  expect(projectSubtitle(entry("b", "B", now - 2 * 60_000, null), now)).toBe("Updated 2 min ago");
  expect(projectSubtitle(entry("c", "C", now, now - 3 * 3_600_000), now)).toBe("Opened 3 hr ago");
});

test("relative time stays short and resolves old projects by date", () => {
  const now = 100 * 24 * 3_600_000;
  expect(relativeTime(now - 1, now)).toBe("just now");
  expect(relativeTime(now - 60_000, now)).toBe("1 min ago");
  expect(relativeTime(now - 59 * 60_000, now)).toBe("59 min ago");
  expect(relativeTime(now - 3_600_000, now)).toBe("1 hr ago");
  expect(relativeTime(now - 24 * 3_600_000, now)).toBe("yesterday");
  expect(relativeTime(now - 3 * 24 * 3_600_000, now)).toBe("3 days ago");
  expect(relativeTime(now - 31 * 24 * 3_600_000, now)).toBe("on 1970-03-11");
  // A clock that moved backwards clamps instead of showing a negative age.
  expect(relativeTime(now + 5_000, now)).toBe("just now");
});

test("the projects root lives beside the legacy database", () => {
  expect(projectsRoot("/data/Flow")).toBe("/data/Flow/projects");
  expect(projectsRoot(null)).toBe(null);
  expect(projectsRoot("")).toBe(null);
});

test("an explicit document path keeps the legacy launch; projects are the default", () => {
  const sources = {
    dataDir: "/data/Flow",
    hostProjectsRoot: undefined,
    hostDocumentPath: undefined,
    envDocumentPath: undefined,
    envProjectsRoot: undefined,
  };
  expect(projectsRootForLaunch(sources)).toBe("/data/Flow/projects");
  expect(projectsRootForLaunch({ ...sources, hostProjectsRoot: " /tmp/projects " })).toBe(
    "/tmp/projects",
  );
  expect(projectsRootForLaunch({ ...sources, envProjectsRoot: " /tmp/dev-projects " })).toBe(
    "/tmp/dev-projects",
  );
  expect(
    projectsRootForLaunch({
      ...sources,
      hostProjectsRoot: "/tmp/host",
      envProjectsRoot: "/tmp/env",
    }),
  ).toBe("/tmp/host");
  expect(projectsRootForLaunch({ ...sources, hostDocumentPath: "/tmp/one.db" })).toBe(null);
  expect(projectsRootForLaunch({ ...sources, envDocumentPath: "/tmp/env.db" })).toBe(null);
  expect(
    projectsRootForLaunch({
      ...sources,
      hostDocumentPath: "/tmp/one.db",
      envProjectsRoot: "/tmp/env",
    }),
  ).toBe(null);
  expect(
    projectsRootForLaunch({
      ...sources,
      dataDir: null,
      hostProjectsRoot: undefined,
    }),
  ).toBe(null);
});
