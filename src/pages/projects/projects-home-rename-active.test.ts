import { expect, test } from "nsh/test";
import type { ProjectEntry } from "../../flow/shared";
import { fakeProjectStore } from "../../test-support/fake-project-store";
import { createProjectsHome } from "./projects-home";

const ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CURRENT: ProjectEntry = {
  projectId: ID,
  title: "Before",
  path: `/projects/${ID}/project.db`,
  updatedAt: 1,
  lastOpenedAt: null,
  openHere: false,
  openElsewhere: false,
  unreadable: false,
};

test("a live rename updates the current project's title", async () => {
  const home = createProjectsHome("/projects", {
    openStore: async () => fakeProjectStore({ listProjects: async () => [CURRENT] }),
  });
  await home.refresh();
  home.open(CURRENT);
  expect(home.current()?.title).toBe("Before");

  home.renameActive("After");
  expect(home.current()?.title).toBe("After");
  expect(home.current()?.projectId).toBe(ID);
  // The list stays the catalog's snapshot: the changed package stamp, not a
  // local patch, is what refreshes the title when the list is read again.
  expect(home.projects()[0]?.title).toBe("Before");
  home.dispose();
});
