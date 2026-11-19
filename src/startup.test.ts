import { expect, test } from "nsh/test";
import type { ProjectEntry } from "./flow/shared";
import { decideStartup } from "./startup";

function entry(projectId: string, extra: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    projectId,
    title: projectId,
    path: `/projects/${projectId}`,
    updatedAt: 0,
    openHere: false,
    openElsewhere: false,
    unreadable: false,
    ...extra,
  };
}

test("startup shows Projects unless the last project is chosen", () => {
  const session = { projectId: "a", title: "A", clean: true };
  expect(decideStartup({ startup: "projects" }, session, [entry("a")])).toEqual({
    kind: "projects",
  });
  expect(decideStartup({ startup: "lastProject" }, null, [entry("a")])).toEqual({
    kind: "projects",
  });
});

test("the last project opens only when it closed cleanly and still opens", () => {
  const clean = { projectId: "a", title: "A", clean: true };
  expect(decideStartup({ startup: "lastProject" }, clean, [entry("a")])).toEqual({
    kind: "project",
    project: entry("a"),
  });
  expect(decideStartup({ startup: "lastProject" }, clean, [])).toEqual({
    kind: "fallback",
    reason: "missing",
  });
  expect(
    decideStartup({ startup: "lastProject" }, clean, [entry("a", { unreadable: true })]),
  ).toEqual({ kind: "fallback", reason: "unreadable" });
  expect(
    decideStartup({ startup: "lastProject" }, clean, [entry("a", { openElsewhere: true })]),
  ).toEqual({ kind: "fallback", reason: "openElsewhere" });
});

test("an unclean run offers to continue, whatever the startup setting", () => {
  const dirty = { projectId: "a", title: "A", clean: false };
  expect(decideStartup({ startup: "lastProject" }, dirty, [entry("a")])).toEqual({
    kind: "recover",
    project: entry("a"),
  });
  expect(decideStartup({ startup: "projects" }, dirty, [entry("a")])).toEqual({
    kind: "recover",
    project: entry("a"),
  });
  // A package that cannot open leaves nothing to continue.
  expect(decideStartup({ startup: "projects" }, dirty, [])).toEqual({ kind: "projects" });
  expect(decideStartup({ startup: "projects" }, dirty, [entry("a", { unreadable: true })])).toEqual(
    { kind: "projects" },
  );
});
