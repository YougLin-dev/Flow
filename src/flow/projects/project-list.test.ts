import { expect, test } from "nsh/test";
import type { ProjectEntry } from "../shared";
import { filterProjects, projectStatusLabel, sortProjects } from "./project-list";
import { projectsRoot } from "./projects-root";

function entry(
  projectId: string,
  title: string,
  updatedAt: number,
  lastOpenedAt: number | null,
  openHere = false,
  openElsewhere = false,
): ProjectEntry {
  return {
    projectId,
    title,
    path: `/projects/${projectId}/project.db`,
    updatedAt,
    lastOpenedAt,
    openHere,
    openElsewhere,
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

test("the projects root lives beside the legacy database", () => {
  expect(projectsRoot("/data/Flow")).toBe("/data/Flow/projects");
  expect(projectsRoot(null)).toBe(null);
  expect(projectsRoot("")).toBe(null);
});
